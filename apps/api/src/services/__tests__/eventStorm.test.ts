/**
 * eventStorm.ts — tempeste di allarmi per sorgente con Redis mockato
 * (getSharedRedis): contatore al minuto (INCR + TTL solo alla prima),
 * tasso corrente (max fra minuto corrente e precedente); trackSourceStorm:
 * ripetizioni non contate, sotto soglia niente, a soglia → tempesta con UN
 * incident (titolo/severità/CI del primo evento, descrizione con i CI),
 * event.storm_started una volta, primo evento orfano → senza incident e il
 * primo con CI lo apre, minuto oltre soglia marcato al superamento, fine per
 * raffreddamento (all'ingest e dal job) con commento "Tempesta terminata",
 * event.storm_ended, gauge; listStormSources per la console. Atomicità:
 * lock Redis per (tenant, sorgente) + SET condizionali → due job concorrenti
 * aprono UN solo incident; chi trova il lock occupato si aggancia all'incident
 * appena compare, o fallisce (ritentabile) dopo l'attesa; lock rilasciato
 * anche se la creazione fallisce; duplicato residuo agganciato al vincitore e
 * denunciato. Revisione: l'incident di tempesta porta `storm_source_id`;
 * `storm_last_over_at` marcato da ogni job oltre soglia ma scritto una volta
 * per minuto; incident di tempesta chiuso → replaceClosedStormIncident (sotto
 * lock) ne apre uno nuovo; endCooledStorms paginato.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Ondata 7: la traduzione fra valori di dominio è una lettura (la matrice è
// dato del cliente). Qui si misura altro: il doppio risponde con la matrice di
// fabbrica e i vocabolari spediti, senza grafo (lib/__tests__/domainMatrixFake.ts).
vi.mock('../../lib/domainMatrix.js', () => import('../../lib/__tests__/domainMatrixFake.js'))

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
const redis = { incr: vi.fn(), expire: vi.fn().mockResolvedValue(1), mget: vi.fn(), set: vi.fn(), eval: vi.fn() }
vi.mock('../../lib/bullmq.js', () => ({ getSharedRedis: () => redis }))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../incidentService.js', () => ({ createIncident: vi.fn(), addIncidentComment: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../events/policy.js', () => ({ getEventPolicy: vi.fn() }))
vi.mock('../../middleware/metrics.js', () => ({ eventStormsActive: { set: vi.fn() }, incidentsAutoOpenedTotal: { inc: vi.fn() }, redisLockTimeoutsTotal: { inc: vi.fn() }, redisLockHoldSeconds: { observe: vi.fn() } }))

const storm = await import('../eventStorm.js')
const { trackSourceStorm, getStormState, endCooledStorms, listStormSources, countNewEvent, currentRate, replaceClosedStormIncident, stormCounterKey, stormLockKey, stormCooledDown, stormStateOf, minuteStartOf, invalidateSourceCache, loadSource, STORM_COUNTER_TTL_SECONDS, STORM_LOCK_TTL_SECONDS, STORM_LOCK_WAIT_MS, STORM_LOCK_POLL_MS, SOURCE_CACHE_TTL_MS } = storm
const { PAGE_SIZE } = await import('../../lib/pagedPass.js')
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { audit } = await import('../../lib/audit.js')
const incidentService = await import('../incidentService.js')
const { getEventPolicy } = await import('../events/policy.js')
const metrics = await import('../../middleware/metrics.js')
const { DEFAULT_EVENT_POLICY } = await import('../../lib/eventPolicy.js')

const session = { close: vi.fn().mockResolvedValue(undefined) }
const NOW = '2026-09-09T10:00:30.000Z'
const minutesAgo = (m: number) => new Date(Date.parse(NOW) - m * 60_000).toISOString()
const policy = (over: Partial<typeof DEFAULT_EVENT_POLICY> = {}) => ({ ...structuredClone(DEFAULT_EVENT_POLICY), ...over })

/** Regole (regex → valore o funzione dei parametri); vince l'ultima che combacia. */
function onCypher(rules: Array<[RegExp, unknown]>) {
  const impl = async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
    for (const [re, value] of [...rules].reverse()) if (re.test(cypher)) return typeof value === 'function' ? (value as (p?: Record<string, unknown>) => unknown)(params) : value
    throw new Error(`unexpected cypher in test:\n${cypher}`)
  }
  vi.mocked(runQueryOne).mockImplementation(impl as never)
  vi.mocked(runQuery).mockImplementation((async (s: unknown, c: string, p?: Record<string, unknown>) => { const r = await impl(s, c, p); return r == null ? [] : Array.isArray(r) ? r : [r] }) as never)
}
const calls = () => [...vi.mocked(runQueryOne).mock.calls, ...vi.mocked(runQuery).mock.calls].map(([, cypher, params]) => ({ cypher: cypher as string, params: params as Record<string, unknown> }))
const callMatching = (re: RegExp) => calls().find((c) => re.test(c.cypher))
const published = () => vi.mocked(publishEvent).mock.calls.map((c) => c[0])

const Q = {
  source:     /MATCH \(w:InboundWebhook \{id: \$sourceId, tenant_id: \$tenantId\}\)\s+RETURN properties\(w\) AS props/,
  start:      /WHERE w\.storm_since IS NULL\s+SET w\.storm_since = \$now, w\.storm_last_over_at = \$now, w\.storm_incident_id = null/,
  ciNames:    /RETURN DISTINCT ci\.name AS name/,
  markInc:    /MATCH \(i:Incident \{id: \$incidentId, tenant_id: \$tenantId\}\)\s+SET i\.storm_source_id = \$sourceId/,
  setInc:     /WHERE w\.storm_incident_id IS NULL\s+SET w\.storm_incident_id = \$incidentId/,
  markOver:   /WHERE w\.storm_last_over_at IS NULL OR w\.storm_last_over_at < \$minuteStart\s+SET w\.storm_last_over_at = \$now\s*$/,
  detachInc:  /WHERE w\.storm_incident_id = \$closedIncidentId\s+SET w\.storm_incident_id = null/,
  countEv:    /MATCH \(e:Event \{tenant_id: \$tenantId, source_id: \$sourceId\}\)\s+WHERE e\.first_seen_at >= \$since\s+RETURN count\(e\) AS n/,
  end:        /SET w\.storm_since = null, w\.storm_incident_id = null, w\.storm_last_over_at = null/,
  gauge:      /WHERE w\.storm_since IS NOT NULL\s+RETURN count\(w\) AS n/,
  allStorms:  /MATCH \(w:InboundWebhook\)\s+WHERE w\.storm_since IS NOT NULL AND w\.id > \$cursor\s+RETURN properties\(w\) AS props\s+ORDER BY w\.id LIMIT toInteger\(\$limit\)/,
  list:       /MATCH \(w:InboundWebhook \{tenant_id: \$tenantId, entity_type: 'event'\}\)/,
}

const source = (over: Record<string, unknown> = {}) => ({ id: 'hook-1', tenant_id: 't1', name: 'Zabbix prod', entity_type: 'event', storm_since: null, storm_incident_id: null, storm_last_over_at: null, ...over })
const STORMING = { storm_since: minutesAgo(3), storm_incident_id: 'inc-storm', storm_last_over_at: minutesAgo(1) }

function baseRules(src: Record<string, unknown> | null = source()): Array<[RegExp, unknown]> {
  return [
    [Q.source, src ? { props: src } : null],
    [Q.start, { id: 'hook-1' }], [Q.ciNames, [{ name: 'db-01' }, { name: 'web-02' }]], [Q.markInc, (p?: Record<string, unknown>) => ({ id: p!['incidentId'] })], [Q.setInc, { id: 'hook-1' }], [Q.markOver, null], [Q.detachInc, null],
    [Q.countEv, { n: 340 }], [Q.end, { id: 'hook-1' }], [Q.gauge, { n: 1 }],
  ]
}

const track = (over: Partial<Parameters<typeof trackSourceStorm>[0]> = {}) =>
  trackSourceStorm({ tenantId: 't1', sourceId: 'hook-1', opensCycle: true, policy: policy(), now: NOW, actorId: 'monitoring', ciId: 'ci-1', ...over })

beforeEach(() => {
  vi.clearAllMocks()
  invalidateSourceCache()   // la cache della sorgente (10 s) è per processo: ogni test parte pulito
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(getEventPolicy).mockResolvedValue(policy())
  vi.mocked(incidentService.createIncident).mockResolvedValue({ id: 'inc-storm', number: 'INC00000042' } as never)
  redis.incr.mockResolvedValue(1)
  redis.mget.mockResolvedValue([null, null])
  redis.set.mockResolvedValue('OK')
  redis.eval.mockResolvedValue(1)
})
afterEach(() => { vi.useRealTimers() })

describe('helper puri', () => {
  it('stormCounterKey: (tenant, sorgente, minuto); stormCooledDown: strettamente oltre il raffreddamento; stormStateOf', () => {
    expect(stormCounterKey('t1', 'hook-1', Date.parse(NOW))).toBe(`og:events:storm:t1:hook-1:${Math.floor(Date.parse(NOW) / 60_000)}`)
    expect(stormCounterKey('t1', 'hook-1', Date.parse(NOW) + 29_000)).toBe(stormCounterKey('t1', 'hook-1', Date.parse(NOW)))
    expect(stormCounterKey('t1', 'hook-1', Date.parse(NOW) + 30_000)).not.toBe(stormCounterKey('t1', 'hook-1', Date.parse(NOW)))
    expect(() => stormCounterKey('t1', 'hook-1', NaN)).toThrow(/not a timestamp/)
    expect(stormCooledDown(minutesAgo(6), NOW, 5)).toBe(true)
    expect(stormCooledDown(minutesAgo(5), NOW, 5)).toBe(false)
    expect(stormCooledDown(NOW, NOW, 0)).toBe(false)
    expect(stormCooledDown(minutesAgo(0.1), NOW, 0)).toBe(true)
    expect(() => stormCooledDown('ieri', NOW, 5)).toThrow(/not an ISO date/)
    expect(stormStateOf(source())).toEqual({ active: false, since: null, incidentId: null, sourceName: 'Zabbix prod' })
    expect(stormStateOf(source(STORMING))).toEqual({ active: true, since: STORMING.storm_since, incidentId: 'inc-storm', sourceName: 'Zabbix prod' })
    expect(stormStateOf(source({ name: null, storm_since: 'T' })).sourceName).toBe('hook-1')
    expect(minuteStartOf(NOW)).toBe('2026-09-09T10:00:00.000Z')
    expect(() => minuteStartOf('ieri')).toThrow(/not an ISO date/)
  })
})

describe('contatore Redis', () => {
  it('countNewEvent: INCR sulla chiave del minuto; TTL 120 s solo quando la chiave nasce', async () => {
    redis.incr.mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    await expect(countNewEvent('t1', 'hook-1', NOW)).resolves.toBe(1)
    expect(redis.incr).toHaveBeenCalledWith(stormCounterKey('t1', 'hook-1', Date.parse(NOW)))
    expect(redis.expire).toHaveBeenCalledWith(stormCounterKey('t1', 'hook-1', Date.parse(NOW)), STORM_COUNTER_TTL_SECONDS)
    await expect(countNewEvent('t1', 'hook-1', NOW)).resolves.toBe(2)
    expect(redis.expire).toHaveBeenCalledTimes(1)
    expect(STORM_COUNTER_TTL_SECONDS).toBe(120)
  })

  it('currentRate: massimo fra minuto corrente e precedente, 0 senza contatori; Redis giù → errore propagato', async () => {
    redis.mget.mockResolvedValueOnce(['12', '80'])
    await expect(currentRate('t1', 'hook-1', Date.parse(NOW))).resolves.toBe(80)
    expect(redis.mget).toHaveBeenCalledWith(stormCounterKey('t1', 'hook-1', Date.parse(NOW)), stormCounterKey('t1', 'hook-1', Date.parse(NOW) - 60_000))
    await expect(currentRate('t1', 'hook-1', Date.parse(NOW))).resolves.toBe(0)
    redis.mget.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(currentRate('t1', 'hook-1')).rejects.toThrow('ECONNREFUSED')
  })
})

describe('trackSourceStorm', () => {
  it('ripetizione (opensCycle=false) → nessun INCR, nessuna tempesta; sorgente cancellata → nessuna tempesta; soglia 0 → rilevamento spento', async () => {
    onCypher(baseRules())
    await expect(track({ opensCycle: false })).resolves.toEqual({ active: false, since: null, incidentId: null, sourceName: 'Zabbix prod' })
    expect(redis.incr).not.toHaveBeenCalled()
    invalidateSourceCache()   // sorgente diversa nello stesso test: via la voce in cache
    onCypher(baseRules(null))
    await expect(track()).resolves.toMatchObject({ active: false, sourceName: 'hook-1' })
    expect(redis.incr).not.toHaveBeenCalled()
    invalidateSourceCache()
    onCypher(baseRules())
    redis.incr.mockResolvedValue(999)
    await expect(track({ policy: policy({ storm_threshold_per_minute: 0 }) })).resolves.toMatchObject({ active: false })
    expect(redis.incr).not.toHaveBeenCalled()
  })

  it('sotto soglia → conta e basta: nessuna scrittura, nessun avviso', async () => {
    onCypher(baseRules())
    redis.incr.mockResolvedValue(49)
    await expect(track()).resolves.toMatchObject({ active: false })
    expect(redis.incr).toHaveBeenCalledTimes(1)
    expect(callMatching(Q.start)).toBeUndefined()
    expect(publishEvent).not.toHaveBeenCalled()
    expect(incidentService.createIncident).not.toHaveBeenCalled()
  })

  it('a soglia (50° evento nuovo nel minuto) → tempesta: storm_since/last_over_at sulla sorgente, UN incident critical con il CI del primo evento e i CI coinvolti, storm_incident_id, event.storm_started, audit, metriche', async () => {
    onCypher(baseRules())
    redis.incr.mockResolvedValue(50)
    const out = await track()
    expect(out).toEqual({ active: true, since: NOW, incidentId: 'inc-storm', sourceName: 'Zabbix prod' })
    const start = callMatching(Q.start)!
    expect(start.cypher).toContain('MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})')
    expect(start.params).toMatchObject({ sourceId: 'hook-1', tenantId: 't1', now: NOW, rate: 50 })
    expect(incidentService.createIncident).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Tempesta di allarmi da Zabbix prod: 50 allarmi al minuto', severity: 'critical', affectedCIIds: ['ci-1'] }),
      { tenantId: 't1', userId: 'monitoring' },
    )
    const desc = vi.mocked(incidentService.createIncident).mock.calls[0]![0].description!
    expect(desc).toContain('50 allarmi nuovi al minuto')
    expect(desc).toContain('Primi CI coinvolti: db-01, web-02')
    expect(callMatching(Q.ciNames)!.params).toMatchObject({ tenantId: 't1', sourceId: 'hook-1', since: NOW })
    // marcatore: l'incident di tempesta non è "l'incident del CI" per il raggruppamento
    expect(callMatching(Q.markInc)!.params).toEqual({ incidentId: 'inc-storm', tenantId: 't1', sourceId: 'hook-1' })
    expect(callMatching(Q.setInc)!.params).toMatchObject({ sourceId: 'hook-1', tenantId: 't1', incidentId: 'inc-storm' })
    expect(published()).toEqual(['event.storm_started'])
    expect(vi.mocked(publishEvent).mock.calls[0]![3]).toEqual({ id: 'inc-storm', source_id: 'hook-1', source_name: 'Zabbix prod', rate_per_minute: 50, incident_id: 'inc-storm', since: NOW, entity_type: 'incident', entity_id: 'inc-storm' })
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', userId: 'monitoring' }), 'event.storm_started', 'InboundWebhook', 'hook-1', expect.objectContaining({ rate: 50, incidentId: 'inc-storm' }))
    expect(metrics.incidentsAutoOpenedTotal.inc).toHaveBeenCalledTimes(1)
    expect(metrics.eventStormsActive.set).toHaveBeenCalledWith({}, 1)
    // sezione critica: lock SET NX EX 30 preso e rilasciato con il proprio token
    expect(redis.set).toHaveBeenCalledWith(stormLockKey('t1', 'hook-1'), expect.any(String), 'EX', STORM_LOCK_TTL_SECONDS, 'NX')
    expect(STORM_LOCK_TTL_SECONDS).toBe(30)
    expect(redis.eval).toHaveBeenCalledWith(expect.stringMatching(/GET.*DEL/s), 1, stormLockKey('t1', 'hook-1'), redis.set.mock.calls[0]![1])
  })

  it('primo evento orfano → tempesta senza incident (createIncident richiede un CI), avviso sulla sorgente; il primo evento con CI apre poi l\'incident', async () => {
    onCypher(baseRules())
    redis.incr.mockResolvedValue(50)
    const out = await track({ ciId: null })
    expect(out).toEqual({ active: true, since: NOW, incidentId: null, sourceName: 'Zabbix prod' })
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(vi.mocked(publishEvent).mock.calls[0]![3]).toMatchObject({ id: 'hook-1', incident_id: null, entity_type: 'inbound_webhook', entity_id: 'hook-1' })

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher(baseRules(source({ storm_since: NOW, storm_last_over_at: NOW, storm_incident_id: null })))
    redis.incr.mockResolvedValue(51)
    redis.mget.mockResolvedValue(['51', null])
    const next = await track({ ciId: 'ci-7' })
    expect(next).toEqual({ active: true, since: NOW, incidentId: 'inc-storm', sourceName: 'Zabbix prod' })
    expect(incidentService.createIncident).toHaveBeenCalledWith(expect.objectContaining({ affectedCIIds: ['ci-7'], title: 'Tempesta di allarmi da Zabbix prod: 51 allarmi al minuto' }), expect.anything())
    expect(callMatching(Q.start)).toBeUndefined()   // nessuna seconda tempesta
    expect(publishEvent).not.toHaveBeenCalled()      // event.storm_started una sola volta
  })

  it('tempesta in corso: ogni job a/oltre soglia marca il minuto (rate >= soglia, non solo il 50°: un job fallito non "raffredda" la tempesta) con una SET condizionale che scrive una volta per minuto; tasso sotto soglia entro il raffreddamento → resta in tempesta', async () => {
    onCypher(baseRules(source(STORMING)))
    redis.incr.mockResolvedValue(50)
    await expect(track()).resolves.toMatchObject({ active: true, incidentId: 'inc-storm' })
    expect(callMatching(Q.markOver)!.params).toEqual({ sourceId: 'hook-1', tenantId: 't1', now: NOW, minuteStart: '2026-09-09T10:00:00.000Z' })
    expect(incidentService.createIncident).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher(baseRules(source(STORMING)))
    redis.incr.mockResolvedValue(51)
    await track()
    expect(callMatching(Q.markOver)!.params).toMatchObject({ minuteStart: minuteStartOf(NOW) })

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher(baseRules(source(STORMING)))
    redis.incr.mockResolvedValue(49)
    await track()
    expect(callMatching(Q.markOver)).toBeUndefined()   // sotto soglia: nessuna marcatura

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher(baseRules(source(STORMING)))
    redis.incr.mockResolvedValue(3)
    await expect(track()).resolves.toMatchObject({ active: true, incidentId: 'inc-storm' })
    expect(callMatching(Q.end)).toBeUndefined()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('raffreddamento all\'ingest: ultimo minuto oltre soglia più vecchio di storm_cooldown_minutes → fine tempesta: sorgente azzerata, commento "Tempesta terminata: N eventi in T minuti", event.storm_ended, gauge', async () => {
    onCypher([...baseRules(source({ ...STORMING, storm_since: minutesAgo(12), storm_last_over_at: minutesAgo(6) })), [Q.gauge, { n: 0 }]])
    redis.incr.mockResolvedValue(2)
    const out = await track()
    expect(out).toEqual({ active: false, since: null, incidentId: null, sourceName: 'Zabbix prod' })
    const end = callMatching(Q.end)!
    expect(end.cypher).toContain('MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})')
    expect(end.params).toMatchObject({ sourceId: 'hook-1', tenantId: 't1', since: minutesAgo(12), now: NOW, incidentId: 'inc-storm', events: 340 })
    expect(callMatching(Q.countEv)!.params).toMatchObject({ tenantId: 't1', sourceId: 'hook-1', since: minutesAgo(12) })
    expect(incidentService.addIncidentComment).toHaveBeenCalledWith('inc-storm', { tenantId: 't1', userId: 'monitoring' }, 'Tempesta terminata: 340 eventi in 12 minuti')
    expect(published()).toEqual(['event.storm_ended'])
    expect(vi.mocked(publishEvent).mock.calls[0]![3]).toMatchObject({ id: 'inc-storm', source_id: 'hook-1', incident_id: 'inc-storm', events: 340, duration_minutes: 12, since: minutesAgo(12) })
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'event.storm_ended', 'InboundWebhook', 'hook-1', expect.objectContaining({ events: 340, durationMinutes: 12 }))
    expect(metrics.eventStormsActive.set).toHaveBeenCalledWith({}, 0)
  })

  it('Redis giù → l\'ingest fallisce (nessun fallback), la sorgente non viene toccata', async () => {
    onCypher(baseRules())
    redis.incr.mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(track()).rejects.toThrow('ECONNREFUSED')
    expect(callMatching(Q.start)).toBeUndefined()
  })

  it('getStormState legge senza contare', async () => {
    onCypher(baseRules(source(STORMING)))
    await expect(getStormState('t1', 'hook-1')).resolves.toMatchObject({ active: true, incidentId: 'inc-storm' })
    expect(redis.incr).not.toHaveBeenCalled()
    onCypher(baseRules(null))
    await expect(getStormState('t1', 'hook-x')).resolves.toMatchObject({ active: false, sourceName: 'hook-x' })
  })
})

/** Redis in memoria: SET NX e rilascio guardato dal token, come il vero. */
function inMemoryLock(): Map<string, string> {
  const store = new Map<string, string>()
  redis.set.mockImplementation((async (key: string, value: string, _ex: string, _ttl: number, nx?: string) => {
    if (nx === 'NX' && store.has(key)) return null
    store.set(key, value)
    return 'OK'
  }) as never)
  redis.eval.mockImplementation((async (_lua: string, _n: number, key: string, owner: string) => {
    if (store.get(key) !== owner) return 0
    store.delete(key)
    return 1
  }) as never)
  return store
}

/** Sorgente "viva": le SET condizionali la mutano davvero e chi rilegge la vede aggiornata. */
function liveSource(over: Record<string, unknown> = {}): Record<string, unknown> {
  const src = source(over)
  onCypher([
    [Q.source, () => ({ props: { ...src } })],
    [Q.start, () => {
      if (src['storm_since'] != null) return null
      Object.assign(src, { storm_since: NOW, storm_last_over_at: NOW, storm_incident_id: null })
      return { id: 'hook-1' }
    }],
    [Q.ciNames, [{ name: 'db-01' }]],
    [Q.markInc, (p?: Record<string, unknown>) => ({ id: p!['incidentId'] })],
    [Q.setInc, (p?: Record<string, unknown>) => {
      if (src['storm_incident_id'] != null) return null
      src['storm_incident_id'] = p!['incidentId']
      return { id: 'hook-1' }
    }],
    [Q.detachInc, (p?: Record<string, unknown>) => {
      if (src['storm_incident_id'] === p!['closedIncidentId']) src['storm_incident_id'] = null
      return null
    }],
    [Q.markOver, null], [Q.gauge, { n: 1 }],
  ])
  return src
}

describe('atomicità: lock Redis per (tenant, sorgente) + SET condizionali', () => {
  const lockKey = stormLockKey('t1', 'hook-1')

  it('due job concorrenti a soglia sulla stessa sorgente → UN solo createIncident, UNA sola tempesta avviata (storm_started una volta), entrambi agganciati allo stesso incident; ogni lock preso viene rilasciato', async () => {
    const store = inMemoryLock()
    liveSource()
    redis.incr.mockResolvedValueOnce(50).mockResolvedValueOnce(51)
    const [a, b] = await Promise.all([track({ ciId: 'ci-1' }), track({ ciId: 'ci-2' })])
    expect(a).toEqual({ active: true, since: NOW, incidentId: 'inc-storm', sourceName: 'Zabbix prod' })
    expect(b).toEqual(a)
    expect(incidentService.createIncident).toHaveBeenCalledTimes(1)
    expect(calls().filter((c) => Q.start.test(c.cypher))).toHaveLength(1)
    expect(published()).toEqual(['event.storm_started'])
    expect(vi.mocked(publishEvent).mock.calls[0]![3]).toMatchObject({ incident_id: 'inc-storm', rate_per_minute: 50 })
    expect(metrics.incidentsAutoOpenedTotal.inc).toHaveBeenCalledTimes(1)
    const acquired = redis.set.mock.results.filter((r) => r.type === 'return').length
    expect(acquired).toBeGreaterThanOrEqual(2)
    expect(store.size).toBe(0)   // nessun lock lasciato in giro
  })

  it('lock occupato e poi storm_incident_id compare sulla sorgente → aggancio senza creare nulla, senza mai entrare nella sezione critica', async () => {
    redis.set.mockResolvedValue(null)   // il lock resta di un altro job
    let reads = 0
    onCypher([...baseRules(), [Q.source, () => ({ props: source(reads++ === 0 ? {} : STORMING) })]])
    redis.incr.mockResolvedValue(50)
    await expect(track()).resolves.toEqual({ active: true, since: STORMING.storm_since, incidentId: 'inc-storm', sourceName: 'Zabbix prod' })
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(callMatching(Q.start)).toBeUndefined()
    expect(publishEvent).not.toHaveBeenCalled()
    expect(redis.eval).not.toHaveBeenCalled()   // mai preso, niente da rilasciare
  })

  it('lock occupato e nessun incident entro l\'attesa (3 s, polling ogni 100 ms) → errore ritentabile, nessun incident creato', async () => {
    vi.useFakeTimers()
    redis.set.mockResolvedValue(null)
    onCypher(baseRules())
    redis.incr.mockResolvedValue(50)
    const pending = expect(track()).rejects.toThrow(/Lock og:events:storm-open:t1:hook-1 still held by another job after 3000 ms and no storm incident appeared on source hook-1 \(tenant t1\) — will retry/)
    await vi.advanceTimersByTimeAsync(STORM_LOCK_WAIT_MS + STORM_LOCK_POLL_MS)
    await pending
    expect(STORM_LOCK_WAIT_MS).toBe(3_000)
    expect(STORM_LOCK_POLL_MS).toBe(100)
    expect(redis.set.mock.calls.length).toBeGreaterThanOrEqual(STORM_LOCK_WAIT_MS / STORM_LOCK_POLL_MS)
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(callMatching(Q.start)).toBeUndefined()
    expect(redis.eval).not.toHaveBeenCalled()
  })

  it('createIncident fallisce → l\'errore propaga (il job ritenta) e il lock viene rilasciato con il proprio token', async () => {
    const store = inMemoryLock()
    liveSource()
    redis.incr.mockResolvedValue(50)
    vi.mocked(incidentService.createIncident).mockRejectedValueOnce(new Error('Neo4j down'))
    await expect(track()).rejects.toThrow('Neo4j down')
    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), 1, lockKey, redis.set.mock.calls[0]![1])
    expect(store.size).toBe(0)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('rete di sicurezza: la SET condizionale non tocca nulla (un altro job ha scritto l\'incident) → si aggancia al vincitore, log.error + audit event_storm.duplicate_incident + commento sul duplicato; sorgente senza vincitore → errore', async () => {
    const src = liveSource({ storm_since: NOW, storm_last_over_at: NOW })
    redis.incr.mockResolvedValue(51)
    vi.mocked(incidentService.createIncident).mockImplementationOnce((async () => {
      src['storm_incident_id'] = 'inc-winner'   // qualcuno vince mentre creiamo
      return { id: 'inc-dup', number: 'INC00000099' }
    }) as never)
    await expect(track()).resolves.toEqual({ active: true, since: NOW, incidentId: 'inc-winner', sourceName: 'Zabbix prod' })
    const { logger } = await import('../../lib/logger.js')
    expect(logger.child({}).error).toHaveBeenCalledWith(expect.objectContaining({ duplicateIncidentId: 'inc-dup', incidentId: 'inc-winner', sourceId: 'hook-1' }), expect.stringMatching(/Duplicate storm incident/))
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1' }), 'event_storm.duplicate_incident', 'InboundWebhook', 'hook-1', expect.objectContaining({ duplicateIncidentId: 'inc-dup', incidentId: 'inc-winner' }))
    expect(incidentService.addIncidentComment).toHaveBeenCalledWith('inc-dup', { tenantId: 't1', userId: 'monitoring' }, expect.stringContaining('inc-winner'))
    expect(metrics.incidentsAutoOpenedTotal.inc).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); redis.set.mockResolvedValue('OK'); redis.eval.mockResolvedValue(1); invalidateSourceCache()
    onCypher([...baseRules(source({ storm_since: NOW, storm_last_over_at: NOW })), [Q.setInc, null]])
    redis.incr.mockResolvedValue(51)
    vi.mocked(incidentService.createIncident).mockResolvedValue({ id: 'inc-dup' } as never)
    await expect(track()).rejects.toThrow(/Storm incident inc-dup created but InboundWebhook hook-1 has no storm_incident_id/)
    expect(redis.eval).toHaveBeenCalledTimes(1)   // lock rilasciato anche qui
  })
})

describe('replaceClosedStormIncident (incident di tempesta chiuso mentre la sorgente è ancora in tempesta)', () => {
  it('sotto lock: azzera storm_incident_id (SET condizionale sull\'incident chiuso), apre un NUOVO incident di tempesta marcato, commento sull\'incident chiuso, audit; chi arriva dopo trova il nuovo incident senza aprirne un altro', async () => {
    const store = inMemoryLock()
    const src = liveSource({ ...STORMING, storm_incident_id: 'inc-closed' })
    redis.mget.mockResolvedValue(['70', '20'])
    vi.mocked(incidentService.createIncident).mockResolvedValue({ id: 'inc-storm-2', number: 'INC00000043' } as never)
    const [a, b] = await Promise.all([
      replaceClosedStormIncident('t1', 'hook-1', 'inc-closed', 'ci-1', 'monitoring', NOW),
      replaceClosedStormIncident('t1', 'hook-1', 'inc-closed', 'ci-2', 'monitoring', NOW),
    ])
    expect(a).toEqual({ active: true, since: STORMING.storm_since, incidentId: 'inc-storm-2', sourceName: 'Zabbix prod' })
    expect(b).toEqual(a)
    expect(src['storm_incident_id']).toBe('inc-storm-2')
    expect(incidentService.createIncident).toHaveBeenCalledTimes(1)
    expect(incidentService.createIncident).toHaveBeenCalledWith(expect.objectContaining({ title: 'Tempesta di allarmi da Zabbix prod: 70 allarmi al minuto', severity: 'critical' }), { tenantId: 't1', userId: 'monitoring' })
    expect(callMatching(Q.detachInc)!.params).toEqual({ sourceId: 'hook-1', tenantId: 't1', closedIncidentId: 'inc-closed', now: NOW })
    expect(callMatching(Q.markInc)!.params).toMatchObject({ incidentId: 'inc-storm-2', sourceId: 'hook-1' })
    expect(incidentService.addIncidentComment).toHaveBeenCalledWith('inc-closed', { tenantId: 't1', userId: 'monitoring' }, expect.stringMatching(/continua dopo la chiusura.*inc-storm-2/))
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1' }), 'event_storm.incident_closed_during_storm', 'InboundWebhook', 'hook-1', expect.objectContaining({ closedIncidentId: 'inc-closed' }))
    expect(publishEvent).not.toHaveBeenCalled()   // nessun secondo storm_started
    expect(store.size).toBe(0)
  })

  it('sorgente già passata a un altro incident → si aggancia a quello senza toccare nulla; tempesta finita → stato "nessuna tempesta"; senza CI → resta senza incident (storm_no_ci)', async () => {
    inMemoryLock()
    liveSource({ ...STORMING, storm_incident_id: 'inc-storm-2' })
    await expect(replaceClosedStormIncident('t1', 'hook-1', 'inc-closed', 'ci-1', 'monitoring', NOW)).resolves.toMatchObject({ active: true, incidentId: 'inc-storm-2' })
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(callMatching(Q.detachInc)).toBeUndefined()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); redis.set.mockResolvedValue('OK'); redis.eval.mockResolvedValue(1)
    liveSource()
    await expect(replaceClosedStormIncident('t1', 'hook-1', 'inc-closed', 'ci-1', 'monitoring', NOW)).resolves.toEqual({ active: false, since: null, incidentId: null, sourceName: 'Zabbix prod' })
    expect(incidentService.createIncident).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); redis.set.mockResolvedValue('OK'); redis.eval.mockResolvedValue(1)
    const src = liveSource({ ...STORMING, storm_incident_id: 'inc-closed' })
    await expect(replaceClosedStormIncident('t1', 'hook-1', 'inc-closed', null, 'monitoring', NOW)).resolves.toMatchObject({ active: true, incidentId: null })
    expect(src['storm_incident_id']).toBeNull()
    expect(incidentService.createIncident).not.toHaveBeenCalled()
  })
})

describe('endCooledStorms (job periodico, paginato)', () => {
  it('chiude solo le tempeste raffreddate (policy del tenant), riallinea il gauge; un errore su una sorgente non ferma le altre ma fa fallire il job', async () => {
    onCypher([
      ...baseRules(),
      [Q.allStorms, [
        { props: source({ ...STORMING, storm_since: minutesAgo(20), storm_last_over_at: minutesAgo(7) }) },
        { props: source({ id: 'hook-2', name: 'Grafana', ...STORMING }) },
      ]],
      [Q.gauge, { n: 1 }],
    ])
    await expect(endCooledStorms(NOW)).resolves.toEqual({ evaluated: 2, active: 1, ended: 1, failed: 0, truncated: false })
    expect(callMatching(Q.allStorms)!.params).toEqual({ cursor: '', limit: PAGE_SIZE })
    expect(callMatching(Q.end)!.params).toMatchObject({ sourceId: 'hook-1' })
    expect(published()).toEqual(['event.storm_ended'])
    expect(metrics.eventStormsActive.set).toHaveBeenLastCalledWith({}, 1)

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    vi.mocked(getEventPolicy).mockRejectedValueOnce(new Error('Tenant t9 has no event_policy'))
    onCypher([...baseRules(), [Q.allStorms, [{ props: source({ tenant_id: 't9', ...STORMING }) }]], [Q.gauge, { n: 1 }]])
    await expect(endCooledStorms(NOW)).rejects.toThrow(/1\/1 storming sources failed the cooldown check/)

    onCypher([[Q.allStorms, []], [Q.gauge, { n: 0 }]])
    await expect(endCooledStorms(NOW)).resolves.toEqual({ evaluated: 0, active: 0, ended: 0, failed: 0, truncated: false })
  })

  it('più di una pagina di sorgenti in tempesta → cursore sull\'id, una policy per tenant', async () => {
    const all = Array.from({ length: PAGE_SIZE + 5 }, (_, i) => source({ id: `hook-${String(i).padStart(4, '0')}`, ...STORMING }))
    onCypher([
      ...baseRules(),
      [Q.allStorms, (p?: Record<string, unknown>) => all.filter((s) => (s['id'] as string) > (p!['cursor'] as string)).slice(0, p!['limit'] as number).map((s) => ({ props: s }))],
      [Q.gauge, { n: PAGE_SIZE + 5 }],
    ])
    await expect(endCooledStorms(NOW)).resolves.toMatchObject({ evaluated: PAGE_SIZE + 5, ended: 0, truncated: false })
    expect(calls().filter((c) => Q.allStorms.test(c.cypher)).map((c) => c.params['cursor'])).toEqual(['', 'hook-0199'])
    expect(getEventPolicy).toHaveBeenCalledTimes(1)
  })
})

describe('listStormSources', () => {
  it('sorgenti del tenant in tempesta con tasso da Redis e incident (id + numero)', async () => {
    onCypher([[Q.list, [{ sourceId: 'hook-1', sourceName: 'Zabbix prod', since: minutesAgo(3), incidentId: 'inc-storm', incidentNumber: 'INC00000042' }, { sourceId: 'hook-2', sourceName: null, since: minutesAgo(1), incidentId: null, incidentNumber: null }]]])
    redis.mget.mockResolvedValueOnce(['70', '120']).mockResolvedValueOnce([null, '55'])
    const out = await listStormSources('t1', Date.parse(NOW))
    expect(out).toEqual([
      { sourceId: 'hook-1', sourceName: 'Zabbix prod', ratePerMinute: 120, since: minutesAgo(3), incidentId: 'inc-storm', incidentNumber: 'INC00000042' },
      { sourceId: 'hook-2', sourceName: 'hook-2', ratePerMinute: 55, since: minutesAgo(1), incidentId: null, incidentNumber: null },
    ])
    const q = callMatching(Q.list)!
    expect(q.cypher).toContain('OPTIONAL MATCH (i:Incident {id: w.storm_incident_id, tenant_id: $tenantId})')
    expect(q.params).toEqual({ tenantId: 't1' })
  })
})

describe('cache della sorgente (sourceCache.ts, TTL 10 s) e fine condizionale', () => {
  it('trackSourceStorm e getStormState leggono la sorgente dalla cache entro il TTL (una sola query); allo scadere si rilegge; invalidateSourceCache la azzera', async () => {
    vi.useFakeTimers({ now: Date.parse(NOW) })
    onCypher(baseRules(source(STORMING)))
    redis.incr.mockResolvedValue(3)
    await track()
    await track()
    await getStormState('t1', 'hook-1')
    expect(calls().filter((c) => Q.source.test(c.cypher))).toHaveLength(1)
    expect(SOURCE_CACHE_TTL_MS).toBe(10_000)
    vi.setSystemTime(Date.parse(NOW) + SOURCE_CACHE_TTL_MS + 1)
    await getStormState('t1', 'hook-1')
    expect(calls().filter((c) => Q.source.test(c.cypher))).toHaveLength(2)
    invalidateSourceCache('t1', 'hook-1')
    await getStormState('t1', 'hook-1')
    expect(calls().filter((c) => Q.source.test(c.cypher))).toHaveLength(3)
    // chi riceve la copia non altera la voce in cache
    const a = (await loadSource('t1', 'hook-1'))!
    a['name'] = 'mutato'
    expect((await loadSource('t1', 'hook-1'))!['name']).toBe('Zabbix prod')
  })

  it('sotto lock la sorgente è SEMPRE riletta dal grafo (fresh): la cache stantia "nessuna tempesta" non fa avviare una seconda tempesta', async () => {
    inMemoryLock()
    let reads = 0
    onCypher([...baseRules(), [Q.source, () => ({ props: source(reads++ === 0 ? {} : STORMING) })]])
    redis.incr.mockResolvedValue(50)
    // prima lettura (cache): nessuna tempesta → si entra nel lock → rilettura fresca: STORMING → nessun avvio
    await expect(track()).resolves.toEqual({ active: true, since: STORMING.storm_since, incidentId: 'inc-storm', sourceName: 'Zabbix prod' })
    expect(callMatching(Q.start)).toBeUndefined()
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
    expect(reads).toBe(2)
  })

  it('ogni scrittura sulla sorgente invalida la cache: dopo il marcatore del minuto la lettura successiva è fresca', async () => {
    onCypher(baseRules(source(STORMING)))
    redis.incr.mockResolvedValue(50)
    await track()
    expect(callMatching(Q.markOver)).toBeDefined()
    await track()
    expect(calls().filter((c) => Q.source.test(c.cypher))).toHaveLength(2)
  })

  it("fine tempesta condizionale (WHERE storm_since = $since): se un'altra replica l'ha già chiusa non si ripubblica storm_ended né si commenta; endCooledStorms non la conta", async () => {
    onCypher([...baseRules(source({ ...STORMING, storm_since: minutesAgo(12), storm_last_over_at: minutesAgo(6) })), [Q.end, null], [Q.gauge, { n: 0 }]])
    redis.incr.mockResolvedValue(2)
    await expect(track()).resolves.toMatchObject({ active: false })
    expect(callMatching(Q.end)!.cypher).toContain('WHERE w.storm_since = $since')
    expect(publishEvent).not.toHaveBeenCalled()
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never); invalidateSourceCache()
    onCypher([...baseRules(), [Q.allStorms, [{ props: source({ ...STORMING, storm_since: minutesAgo(20), storm_last_over_at: minutesAgo(7) }) }]], [Q.end, null], [Q.gauge, { n: 0 }]])
    await expect(endCooledStorms(NOW)).resolves.toMatchObject({ evaluated: 1, ended: 0, active: 1, failed: 0 })
    expect(publishEvent).not.toHaveBeenCalled()
  })
})
