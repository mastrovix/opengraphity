/**
 * services/serviceImpact/incident.ts — incident del servizio (ondata 3):
 * soglia `open_incident_from`, apertura con priorità criticità × salute,
 * relazione IMPACTS_SERVICE ed evento `service.incident_opened`, commento
 * «Causa aggiornata» solo quando le cause cambiano davvero, riapertura invece
 * di un doppione, chiusura automatica con il cammino verso `resolved`,
 * manutenzione (nessuna apertura, un solo commento), mappe non attive che non
 * aprono nulla e un solo incident sotto raffica (lock Redis vero, in memoria).
 *
 * Ondata 4: contatori service_incidents_opened_total (la riapertura conta come
 * apertura) / service_incidents_resolved_total (solo la chiusura vera) e
 * collegamento agli incident tecnici già aperti sui CI delle cause.
 *
 * Revisione 2: l'incident si chiude SOLO con il servizio operativo (I1 — negli
 * altri casi resta aperto con un commento onesto, una volta sola) e l'apertura
 * è idempotente (I2 — marcatore Redis, `cause_ids` prima del commento).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisStore = vi.hoisted(() => new Map<string, string>())
const fakeRedis = vi.hoisted(() => ({
  set: vi.fn(async (key: string, value: string, _ex: string, _ttl: number, nx?: string) => {
    if (nx === 'NX' && redisStore.has(key)) return null
    redisStore.set(key, value)
    return 'OK'
  }),
  get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
  del: vi.fn(async (key: string) => (redisStore.delete(key) ? 1 : 0)),
  eval: vi.fn(async (_lua: string, _n: number, key: string, owner: string) => {
    if (redisStore.get(key) === owner) { redisStore.delete(key); return 1 }
    return 0
  }),
}))
const incidentService = vi.hoisted(() => ({
  createIncident:     vi.fn(),
  addIncidentComment: vi.fn().mockResolvedValue(undefined),
  resolveIncident:    vi.fn().mockResolvedValue(undefined),
}))
const workflow = vi.hoisted(() => ({ getAvailableTransitions: vi.fn().mockResolvedValue([]) }))

// Ondata 7: la traduzione fra valori di dominio è una lettura (la matrice è
// dato del cliente). Qui si misura altro: il doppio risponde con la matrice di
// fabbrica e i vocabolari spediti, senza grafo (lib/__tests__/domainMatrixFake.ts).
vi.mock('../../lib/domainMatrix.js', () => import('../../lib/__tests__/domainMatrixFake.js'))

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => (v == null ? 0 : Number(v)) }))
vi.mock('../../middleware/metrics.js', () => ({
  serviceIncidentsOpenedTotal: { inc: vi.fn() }, serviceIncidentsResolvedTotal: { inc: vi.fn() },
  redisLockTimeoutsTotal: { inc: vi.fn() }, redisLockHoldSeconds: { observe: vi.fn() },
}))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../../lib/bullmq.js', () => ({ getSharedRedis: () => fakeRedis, getQueue: vi.fn() }))
vi.mock('../events/deps.js', () => ({
  engine:    async () => workflow,
  incidents: async () => incidentService,
  queue:     async () => ({}),
}))
vi.mock('../events/incidentWorkflow.js', () => ({
  incidentStepInfo:        vi.fn(async () => ({ resolvedStep: 'resolved', terminalSteps: ['resolved', 'closed'] })),
  incidentStep:            vi.fn(),
  reopenIncident:          vi.fn().mockResolvedValue('in_progress'),
  runMonitoringTransition: vi.fn().mockResolvedValue(undefined),
  loadDefinitionTransitions: vi.fn().mockResolvedValue([]),
  findLinkedOpenIncident:  vi.fn(),
}))

const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const metrics = await import('../../middleware/metrics.js')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { audit } = await import('../../lib/audit.js')
const { logger } = await import('../../lib/logger.js')
const { reopenIncident, runMonitoringTransition, loadDefinitionTransitions } = await import('../events/incidentWorkflow.js')
const { GROUP_LOCK_OPTS } = await import('../events/grouping.js')
const {
  reconcileServiceIncident, serviceIncidentLockKey, meetsServiceOpenThreshold, serviceImpactOf, serviceUrgencyOf,
  serviceIncidentTitle, serviceIncidentDescription, SERVICE_INCIDENT_LOCK_OPTS, SERVICE_HEALTH_LABEL_IT,
  FIND_SERVICE_INCIDENT_CYPHER, LINK_SERVICE_INCIDENT_CYPHER,
  FIND_TECHNICAL_INCIDENTS_CYPHER, SERVICE_MAX_TECHNICAL_INCIDENTS, TECHNICAL_INCIDENTS_HEADING,
  keptOpenReason, serviceResolveCause, serviceIncidentOpenedKey, SERVICE_INCIDENT_OPENED_TTL_SECONDS,
} = await import('../serviceImpact/incident.js')
const { DEFAULT_SERVICE_IMPACT_RULES, SERVICE_HEALTHS } = await import('../../lib/serviceVocabularies.js')
const { RedisLockTimeoutError } = await import('../../lib/redisLock.js')

import type { StoredCause } from '../serviceImpact/history.js'
import type { ServiceImpactRules } from '../../lib/serviceVocabularies.js'

const NOW = '2026-09-10T10:00:00.000Z'
const log = logger.child({})
const session = { close: vi.fn().mockResolvedValue(undefined) }

const FIND_RE  = /MATCH \(i:Incident \{tenant_id: \$tenantId\}\)-\[r:IMPACTS_SERVICE\]->/
const LINK_RE  = /MERGE \(i\)-\[r:IMPACTS_SERVICE\]->\(m\)/
const TECH_RE  = /MATCH \(i:Incident \{tenant_id: \$tenantId\}\)-\[:AFFECTED_BY\]->/
/** Recupero d'idempotenza (I2): l'incident per id. Distinta dalla LINK, che comincia con lo stesso MATCH. */
const BY_ID_RE = /RETURN i\.number AS number/

function cause(ciId: string, over: Partial<StoredCause> = {}): StoredCause {
  return {
    ciId, health: 'down', weight: 5, critical: false,
    ci:   { id: ciId, name: ciId.toUpperCase(), type: 'database', health: 'down' },
    path: [{ id: ciId, name: ciId.toUpperCase(), type: 'database', health: 'down' }, { id: 'api-03', name: 'API-03', type: 'application', health: 'operational' }],
    ...over,
  }
}

/**
 * Regole cypher → risposta. In coda c'è sempre «nessun incident tecnico»: la
 * ricerca dell'ondata 4 gira a ogni apertura e i casi che non la riguardano non
 * devono elencarla; chi la vuole passa la sua regola su TECH_RE (vince, è prima).
 */
function onCypher(rules: Array<[RegExp, unknown]>) {
  const all: Array<[RegExp, unknown]> = [...rules, [TECH_RE, []]]
  const impl = async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
    for (const [re, value] of all) if (re.test(cypher)) return typeof value === 'function' ? (value as (p?: Record<string, unknown>) => unknown)(params) : value
    throw new Error(`unexpected cypher in test:\n${cypher}`)
  }
  vi.mocked(runQueryOne).mockImplementation(impl as never)
  vi.mocked(runQuery).mockImplementation((async (s: unknown, c: string, p?: Record<string, unknown>) => {
    const r = await impl(s, c, p)
    return r == null ? [] : Array.isArray(r) ? r : [r]
  }) as never)
}
const calls = () => [...vi.mocked(runQueryOne).mock.calls, ...vi.mocked(runQuery).mock.calls].map(([, cypher, params]) => ({ cypher: cypher as string, params: params as Record<string, unknown> }))
const callMatching = (re: RegExp) => calls().find((c) => re.test(c.cypher))

const openRow = (over: Record<string, unknown> = {}) => ({ incidentId: 'inc-1', instanceId: 'wi-1', step: 'new', number: 'INC00000042', causeIds: ['db-01'], maintenanceNotedAt: null, keptOpenNotedAt: null, ...over })

function input(over: Partial<Parameters<typeof reconcileServiceIncident>[0]> = {}) {
  return {
    tenantId: 't1', mapId: 'map-1', serviceId: 'ba-1', serviceName: 'Enterprise Billing',
    criticality: 'business_critical', status: 'active' as const,
    rules: { ...DEFAULT_SERVICE_IMPACT_RULES } as ServiceImpactRules,
    health: 'down' as const, impactScore: 62, causes: [cause('db-01')],
    actorId: 'monitoring', now: NOW,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  redisStore.clear()
  vi.mocked(getSession).mockReturnValue(session as never)
  incidentService.createIncident.mockResolvedValue({ id: 'inc-9', number: 'INC00000099' })
  workflow.getAvailableTransitions.mockResolvedValue([])
  vi.mocked(loadDefinitionTransitions).mockResolvedValue([])
})

// ── Helper puri ──────────────────────────────────────────────────────────────

describe('soglia, impatto, urgenza, testi', () => {
  it('open_incident_from: never non apre mai, down solo giù, degraded da degradato in su; le altre salute non aprono', () => {
    for (const h of SERVICE_HEALTHS) expect(meetsServiceOpenThreshold(h, 'never')).toBe(false)
    expect(meetsServiceOpenThreshold('down', 'down')).toBe(true)
    expect(meetsServiceOpenThreshold('degraded', 'down')).toBe(false)
    expect(meetsServiceOpenThreshold('down', 'degraded')).toBe(true)
    expect(meetsServiceOpenThreshold('degraded', 'degraded')).toBe(true)
    for (const h of ['operational', 'maintenance', 'unknown'] as const) {
      expect(meetsServiceOpenThreshold(h, 'degraded')).toBe(false)
    }
  })

  // CONTRATTO RINEGOZIATO (ondata 7 · C-7). Questo punto pretendeva
  // `serviceImpactOf(null) === 'medium'` e `serviceImpactOf('boh') === 'medium'`
  // con un solo `log.warn`: era il difetto, non una garanzia. Il Dizionario
  // permette di aggiungere o rinominare le criticità, quindi `boh` può essere
  // una configurazione legittima — e l'incident del servizio nasceva P3 invece
  // di P1/P2, con la SLA sbagliata di conseguenza, senza che nessun utente
  // vedesse niente. Ora: la criticità si valida contro il vocabolario del
  // cliente e si traduce con la sua matrice `service_impact`; l'assenza e il
  // valore fuori vocabolario sono errori che nominano il servizio e la strada,
  // e il job resta nella coda dei falliti (rigiocabile).
  it('impatto dalla criticità, dalla matrice del cliente (mission/business critical → high, gli altri → medium)', async () => {
    const ctx = { mapId: 'map-1', serviceName: 'Enterprise Billing' }
    expect(await serviceImpactOf('t1', 'mission_critical', ctx)).toBe('high')
    expect(await serviceImpactOf('t1', 'business_critical', ctx)).toBe('high')
    expect(await serviceImpactOf('t1', 'business_operational', ctx)).toBe('medium')
    expect(await serviceImpactOf('t1', 'office_productivity', ctx)).toBe('medium')
  })

  it('criticità ASSENTE: errore che nomina il servizio e dice cosa compilare, non un «medium» silenzioso', async () => {
    const err = await serviceImpactOf('t1', null, { mapId: 'map-1', serviceName: 'Enterprise Billing' })
      .then(() => null, (e: unknown) => e as Error)
    expect(err!.message).toContain('Enterprise Billing')
    expect(err!.message).toMatch(/non ha una criticità/)
    expect(err!.message).toMatch(/mission_critical, business_critical/)
  })

  it('criticità FUORI vocabolario: errore che elenca gli ammessi (prima era «medium» con un log)', async () => {
    await expect(serviceImpactOf('t1', 'boh', { mapId: 'map-1' }))
      .rejects.toThrow(/service_criticality: "boh" non è nel vocabolario di questo cliente/)
  })

  it('criticità del vocabolario ma SENZA cella nella matrice: nomina la combinazione', async () => {
    // Il caso che il cliente crea aggiungendo un valore e dimenticando la
    // matrice: si dice, non si ripiega.
    const { FAKE_VOCABULARIES } = await import('../../lib/__tests__/domainMatrixFake.js')
    const vocab = FAKE_VOCABULARIES as Record<string, readonly string[]>
    const original = [...vocab['service_criticality']!]
    vocab['service_criticality'] = [...original, 'tier_0']
    try {
      await expect(serviceImpactOf('t1', 'tier_0', { mapId: 'map-1' }))
        .rejects.toThrow(/Matrice "service_impact".*service_criticality="tier_0"/s)
    } finally {
      vocab['service_criticality'] = original
    }
  })

  it('urgenza dalla salute: giù → high, degradato → medium; una salute che non apre incident è un errore', async () => {
    expect(await serviceUrgencyOf('t1', 'down')).toBe('high')
    expect(await serviceUrgencyOf('t1', 'degraded')).toBe('medium')
    await expect(serviceUrgencyOf('t1', 'operational')).rejects.toThrow(/no incident urgency/)
  })

  it('titolo e descrizione in italiano, con punteggio, cause e percorso', () => {
    expect(serviceIncidentTitle('Enterprise Billing', 'down')).toBe('Servizio Enterprise Billing: non disponibile')
    expect(serviceIncidentTitle('Enterprise Billing', 'degraded')).toBe('Servizio Enterprise Billing: degradato')
    expect(SERVICE_HEALTH_LABEL_IT['maintenance']).toBe('in manutenzione')
    const d = serviceIncidentDescription('Enterprise Billing', 'down', 62, [cause('db-01', { critical: true })])
    expect(d).toContain('Il servizio "Enterprise Billing" è non disponibile')
    expect(d).toContain("Punteggio d'impatto: 62/100.")
    expect(d).toContain('Componenti che pesano (1):')
    expect(d).toContain('- DB-01 (non disponibile), critico — percorso: DB-01 → API-03')
  })

  it('lock: chiave per (tenant, mappa) e stesse opzioni del raggruppamento degli allarmi', () => {
    expect(serviceIncidentLockKey('t1', 'map-1')).toBe('og:services:incident:t1:map-1')
    expect(SERVICE_INCIDENT_LOCK_OPTS).toBe(GROUP_LOCK_OPTS)
    expect(SERVICE_INCIDENT_LOCK_OPTS).toMatchObject({ ttlSeconds: 30, waitMs: 5_000 })
  })
})

// ── Apertura ─────────────────────────────────────────────────────────────────

describe('apertura', () => {
  it('sopra soglia e nessun incident → UN incident con priorità criticità × salute, i CI delle cause impattati, relazione IMPACTS_SERVICE, evento e audit', async () => {
    onCypher([[FIND_RE, null], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input({ causes: [cause('db-01'), cause('cache-02', { health: 'degraded' })] }))
    expect(r).toEqual({ outcome: 'opened', incidentId: 'inc-9', incidentNumber: 'INC00000099' })

    expect(incidentService.createIncident).toHaveBeenCalledTimes(1)
    const [created, ctx] = incidentService.createIncident.mock.calls[0]!
    // business_critical → impatto high; down → urgenza high; matrice ITIL → critical
    expect(created).toMatchObject({ title: 'Servizio Enterprise Billing: non disponibile', impact: 'high', urgency: 'high', severity: 'critical', affectedCIIds: ['db-01', 'cache-02'] })
    expect(created.description).toContain('- DB-01 (non disponibile)')
    expect(ctx).toEqual({ tenantId: 't1', userId: 'monitoring' })

    const link = callMatching(LINK_RE)!
    expect(link.cypher).toBe(LINK_SERVICE_INCIDENT_CYPHER)
    expect(link.cypher).toContain('ON CREATE SET r.opened_by = $openedBy, r.at = $now')
    expect(link.params).toEqual({ tenantId: 't1', mapId: 'map-1', incidentId: 'inc-9', causeIds: ['db-01', 'cache-02'], maintenanceNoted: false, keptOpenNoted: false, now: NOW, openedBy: 'monitoring' })

    expect(publishEvent).toHaveBeenCalledWith('service.incident_opened', 't1', 'monitoring', {
      id: 'map-1', map_id: 'map-1', service_id: 'ba-1', name: 'Enterprise Billing',
      incident_id: 'inc-9', incident_number: 'INC00000099', health: 'down', impact_score: 62,
    }, NOW)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', userId: 'monitoring' }), 'service.incident_opened', 'ServiceMap', 'map-1',
      expect.objectContaining({ incidentId: 'inc-9', severity: 'critical', causes: ['db-01', 'cache-02'] }))
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('criticità non critica + degradato → priorità medium (medium × medium)', async () => {
    onCypher([[FIND_RE, null], [LINK_RE, { at: NOW }]])
    await reconcileServiceIncident(input({
      criticality: 'business_operational', health: 'degraded', rules: { ...DEFAULT_SERVICE_IMPACT_RULES, open_incident_from: 'degraded' },
      causes: [cause('db-01', { health: 'degraded' })],
    }))
    expect(incidentService.createIncident.mock.calls[0]![0]).toMatchObject({ impact: 'medium', urgency: 'medium', severity: 'medium' })
  })

  it('sotto soglia (degradato con soglia down) → nessun incident, nessuna scrittura', async () => {
    onCypher([[FIND_RE, null]])
    const r = await reconcileServiceIncident(input({ health: 'degraded', causes: [cause('db-01', { health: 'degraded' })] }))
    expect(r).toEqual({ outcome: 'none', incidentId: null, incidentNumber: null })
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(callMatching(LINK_RE)).toBeUndefined()
  })

  it('open_incident_from = never → nessun incident nemmeno con il servizio giù', async () => {
    onCypher([[FIND_RE, null]])
    const r = await reconcileServiceIncident(input({ rules: { ...DEFAULT_SERVICE_IMPACT_RULES, open_incident_from: 'never' } }))
    expect(r).toEqual({ outcome: 'disabled', incidentId: null, incidentNumber: null })
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('mappa draft (bozza) o paused → nessuna apertura, la salute resta calcolata', async () => {
    for (const status of ['draft', 'paused'] as const) {
      vi.clearAllMocks()
      vi.mocked(getSession).mockReturnValue(session as never)
      onCypher([[FIND_RE, null]])
      const r = await reconcileServiceIncident(input({ status }))
      expect(r).toEqual({ outcome: 'inactive', incidentId: null, incidentNumber: null })
      expect(incidentService.createIncident).not.toHaveBeenCalled()
    }
  })

  it('sopra soglia senza cause (dato incoerente) → errore, mai un incident senza CI impattato', async () => {
    onCypher([[FIND_RE, null]])
    await expect(reconcileServiceIncident(input({ causes: [] }))).rejects.toThrow(/with no causes/)
    expect(incidentService.createIncident).not.toHaveBeenCalled()
  })

  it('la lettura dell\'incident del servizio esclude i passi terminali tranne resolved (un incident risolto si riapre, non si affianca)', async () => {
    onCypher([[FIND_RE, null]])
    await reconcileServiceIncident(input({ health: 'operational', causes: [] }))
    const find = callMatching(FIND_RE)!
    expect(find.cypher).toBe(FIND_SERVICE_INCIDENT_CYPHER)
    expect(find.cypher).toContain('WHERE NOT wi.current_step IN $terminalSteps OR wi.current_step = $resolvedStep')
    expect(find.params).toEqual({ tenantId: 't1', mapId: 'map-1', terminalSteps: ['resolved', 'closed'], resolvedStep: 'resolved' })
  })
})

// ── Un solo incident sotto raffica ───────────────────────────────────────────

describe('lock', () => {
  it('due riconciliazioni concorrenti della stessa mappa → UN solo incident (la seconda vede quello aperto dalla prima)', async () => {
    let opened: ReturnType<typeof openRow> | null = null
    onCypher([
      [FIND_RE, () => opened],
      [LINK_RE, () => { opened = openRow({ incidentId: 'inc-9', number: 'INC00000099', causeIds: ['db-01'] }); return { at: NOW } }],
    ])
    const [a, b] = await Promise.all([reconcileServiceIncident(input()), reconcileServiceIncident(input())])
    expect(incidentService.createIncident).toHaveBeenCalledTimes(1)
    expect([a.outcome, b.outcome].sort()).toEqual(['none', 'opened'])
    expect(fakeRedis.set).toHaveBeenCalledWith('og:services:incident:t1:map-1', expect.any(String), 'EX', 30, 'NX')
    expect(redisStore.has('og:services:incident:t1:map-1')).toBe(false)   // lock rilasciato in entrambi i casi
    // resta solo il marcatore d'idempotenza dell'apertura (I2)
    expect([...redisStore.keys()]).toEqual(['og:services:incident:opened:t1:map-1'])
  })

  it('lock occupato oltre l\'attesa → errore ritentabile (il job riprova), nessuna scrittura', async () => {
    redisStore.set('og:services:incident:t1:map-1', 'someone-else')
    onCypher([[FIND_RE, null]])
    await expect(reconcileServiceIncident({ ...input(), rules: { ...DEFAULT_SERVICE_IMPACT_RULES } })).rejects.toBeInstanceOf(RedisLockTimeoutError)
    expect(incidentService.createIncident).not.toHaveBeenCalled()
  }, 10_000)
})

// ── Aggiornamento delle cause ────────────────────────────────────────────────

describe('cause aggiornate', () => {
  it('stesse cause (anche in ordine diverso) → nessun commento', async () => {
    onCypher([[FIND_RE, openRow({ causeIds: ['cache-02', 'db-01'] })]])
    const r = await reconcileServiceIncident(input({ causes: [cause('db-01'), cause('cache-02')] }))
    expect(r).toEqual({ outcome: 'none', incidentId: 'inc-1', incidentNumber: 'INC00000042' })
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()
    expect(callMatching(LINK_RE)).toBeUndefined()
  })

  it('insieme delle cause diverso → UN commento «Causa aggiornata» e il nuovo insieme sulla relazione', async () => {
    onCypher([[FIND_RE, openRow({ causeIds: ['db-01'] })], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input({ causes: [cause('srv-7')] }))
    expect(r).toEqual({ outcome: 'updated', incidentId: 'inc-1', incidentNumber: 'INC00000042' })
    expect(incidentService.addIncidentComment).toHaveBeenCalledTimes(1)
    expect(incidentService.addIncidentComment.mock.calls[0]![2]).toContain('Causa aggiornata: il servizio è non disponibile (punteggio 62/100)')
    expect(incidentService.addIncidentComment.mock.calls[0]![2]).toContain('- SRV-7 (non disponibile)')
    expect(callMatching(LINK_RE)!.params).toMatchObject({ causeIds: ['srv-7'], maintenanceNoted: false })
  })
})

// ── Riapertura ───────────────────────────────────────────────────────────────

describe('riapertura', () => {
  it('incident del servizio in resolved e servizio di nuovo sopra soglia → riapertura + commento, MAI un secondo incident', async () => {
    onCypher([[FIND_RE, openRow({ step: 'resolved' })], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input())
    expect(r).toEqual({ outcome: 'reopened', incidentId: 'inc-1', incidentNumber: 'INC00000042' })
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(reopenIncident).toHaveBeenCalledWith(session, 't1', expect.objectContaining({ incidentId: 'inc-1', instanceId: 'wi-1', step: 'resolved' }),
      { resolvedStep: 'resolved', terminalSteps: ['resolved', 'closed'] },
      'Il servizio "Enterprise Billing" è di nuovo non disponibile (punteggio 62/100)')
    expect(incidentService.addIncidentComment.mock.calls[0]![2]).toContain('Riaperto dal monitoraggio')
  })

  it('mappa non attiva → un incident risolto non viene riaperto', async () => {
    onCypher([[FIND_RE, openRow({ step: 'resolved' })]])
    const r = await reconcileServiceIncident(input({ status: 'paused' }))
    expect(r.outcome).toBe('inactive')
    expect(reopenIncident).not.toHaveBeenCalled()
  })
})

// ── Chiusura automatica ──────────────────────────────────────────────────────

describe('chiusura automatica', () => {
  it('servizio tornato operativo con "Risolvi" disponibile → resolveIncident con la causa e UN commento riassuntivo', async () => {
    workflow.getAvailableTransitions.mockResolvedValue([{ toStep: 'resolved' }])
    onCypher([[FIND_RE, openRow({ step: 'in_progress' })], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input({ health: 'operational', impactScore: 0, causes: [] }))
    expect(r).toEqual({ outcome: 'resolved', incidentId: 'inc-1', incidentNumber: 'INC00000042' })
    expect(runMonitoringTransition).not.toHaveBeenCalled()
    expect(incidentService.resolveIncident).toHaveBeenCalledWith('inc-1', { tenantId: 't1', userId: 'monitoring' }, 'Servizio tornato operativo')
    expect(incidentService.addIncidentComment).toHaveBeenCalledTimes(1)
    expect(incidentService.addIncidentComment.mock.calls[0]![2]).toBe('Risolto automaticamente: Il servizio "Enterprise Billing" è tornato operativo (punteggio 0/100)')
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'service.incident_resolved', 'ServiceMap', 'map-1', expect.objectContaining({ incidentId: 'inc-1', path: [] }))
  })

  it('"Risolvi" non disponibile dal passo corrente → passi intermedi trovati nella definizione, poi resolveIncident; un solo commento con il cammino', async () => {
    workflow.getAvailableTransitions.mockResolvedValue([{ toStep: 'assigned' }])
    vi.mocked(loadDefinitionTransitions).mockResolvedValue([
      { fromStep: 'new', toStep: 'assigned', toLabel: 'Assegnato', trigger: 'manual', condition: null },
      { fromStep: 'assigned', toStep: 'in_progress', toLabel: 'In lavorazione', trigger: 'manual', condition: null },
      { fromStep: 'in_progress', toStep: 'resolved', toLabel: 'Risolto', trigger: 'manual', condition: null },
    ])
    onCypher([[FIND_RE, openRow({ step: 'new' })], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input({ health: 'operational', impactScore: 0, causes: [] }))
    expect(r.outcome).toBe('resolved')
    expect(vi.mocked(runMonitoringTransition).mock.calls.map((c) => [c[4], c[5], c[8]])).toEqual([
      ['assigned', 'manual', false],
      ['in_progress', 'manual', false],
    ])
    expect(incidentService.addIncidentComment).toHaveBeenCalledTimes(1)
    expect(incidentService.addIncidentComment.mock.calls[0]![2]).toContain('passando per Assegnato, In lavorazione')
  })

  it('nessun cammino percorribile → commento e basta, nessuna transizione forzata', async () => {
    workflow.getAvailableTransitions.mockResolvedValue([])
    vi.mocked(loadDefinitionTransitions).mockResolvedValue([])
    onCypher([[FIND_RE, openRow({ step: 'on_hold' })], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input({ health: 'operational', impactScore: 0, causes: [] }))
    expect(r.outcome).toBe('resolve_skipped')
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
    expect(runMonitoringTransition).not.toHaveBeenCalled()
    expect(incidentService.addIncidentComment.mock.calls[0]![2]).toContain('l\'incident è in "on_hold" e non può essere risolto automaticamente da questo passo')
  })

  it('incident già in resolved → non si tocca', async () => {
    onCypher([[FIND_RE, openRow({ step: 'resolved' })]])
    const r = await reconcileServiceIncident(input({ health: 'operational', impactScore: 0, causes: [] }))
    expect(r.outcome).toBe('none')
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()
  })

  it('anche con soglia never un incident aperto prima del cambio di regola viene chiuso quando il servizio torna a posto', async () => {
    workflow.getAvailableTransitions.mockResolvedValue([{ toStep: 'resolved' }])
    onCypher([[FIND_RE, openRow({ step: 'in_progress' })], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input({ health: 'operational', impactScore: 0, causes: [], rules: { ...DEFAULT_SERVICE_IMPACT_RULES, open_incident_from: 'never' } }))
    expect(r.outcome).toBe('resolved')
  })
})

// ── Manutenzione ─────────────────────────────────────────────────────────────

describe('manutenzione', () => {
  it('nessun incident aperto → non ne apre e non scrive nulla', async () => {
    onCypher([[FIND_RE, null]])
    const r = await reconcileServiceIncident(input({ health: 'maintenance', impactScore: 0, causes: [] }))
    expect(r).toEqual({ outcome: 'none', incidentId: null, incidentNumber: null })
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(callMatching(LINK_RE)).toBeUndefined()
  })

  it('incident aperto → resta aperto con UN commento; alla valutazione successiva nessun secondo commento', async () => {
    onCypher([[FIND_RE, openRow({ step: 'in_progress' })], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input({ health: 'maintenance', impactScore: 0, causes: [] }))
    expect(r).toEqual({ outcome: 'maintenance', incidentId: 'inc-1', incidentNumber: 'INC00000042' })
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
    expect(incidentService.addIncidentComment.mock.calls[0]![2]).toContain('Servizio in manutenzione: la valutazione resta sospesa')
    expect(callMatching(LINK_RE)!.params).toMatchObject({ maintenanceNoted: true, causeIds: ['db-01'] })

    vi.clearAllMocks()
    vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[FIND_RE, openRow({ step: 'in_progress', maintenanceNotedAt: NOW })]])
    const again = await reconcileServiceIncident(input({ health: 'maintenance', impactScore: 0, causes: [] }))
    expect(again.outcome).toBe('none')
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()
  })

  it('uscita dalla manutenzione → la nota viene azzerata (potrà essere riscritta alla prossima finestra)', async () => {
    onCypher([[FIND_RE, openRow({ step: 'resolved', maintenanceNotedAt: NOW })], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input({ health: 'operational', impactScore: 0, causes: [] }))
    expect(r.outcome).toBe('none')
    expect(callMatching(LINK_RE)!.params).toMatchObject({ maintenanceNoted: false })
  })
})

// ── Revisione 2 · I1: l'incident si chiude solo se il servizio è operativo ───

describe('sotto soglia ma non operativo: l\'incident resta aperto (I1)', () => {
  const keptOpen = async (over: Partial<Parameters<typeof reconcileServiceIncident>[0]>) => {
    onCypher([[FIND_RE, openRow({ step: 'in_progress' })], [LINK_RE, { at: NOW }]])
    return reconcileServiceIncident(input(over))
  }

  it('open_incident_from = down e servizio passato a degradato → NON chiuso, un solo commento onesto', async () => {
    const r = await keptOpen({ health: 'degraded', impactScore: 20, causes: [cause('db-01', { health: 'degraded' })] })
    expect(r).toEqual({ outcome: 'kept_open', incidentId: 'inc-1', incidentNumber: 'INC00000042' })
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
    expect(runMonitoringTransition).not.toHaveBeenCalled()
    expect(incidentService.addIncidentComment).toHaveBeenCalledTimes(1)
    expect(incidentService.addIncidentComment.mock.calls[0]![2]).toBe('Il servizio "Enterprise Billing" è degradato, sotto la soglia di apertura ("down"): l\'incident resta aperto.')
    // il marcatore si scrive PRIMA del commento (al retry nessun doppione)
    expect(callMatching(LINK_RE)!.params).toMatchObject({ keptOpenNoted: true, maintenanceNoted: false })
    expect(metrics.serviceIncidentsResolvedTotal.inc).not.toHaveBeenCalled()
  })

  it('salute `unknown` (composizione azzerata) → resta aperto con il commento giusto', async () => {
    const r = await keptOpen({ health: 'unknown', impactScore: 0, causes: [] })
    expect(r.outcome).toBe('kept_open')
    expect(incidentService.addIncidentComment.mock.calls[0]![2]).toContain('di stato sconosciuto')
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
  })

  it('regola passata a `never` con il servizio ancora giù → resta aperto, «chiudere a mano»', async () => {
    const r = await keptOpen({ rules: { ...DEFAULT_SERVICE_IMPACT_RULES, open_incident_from: 'never' } })
    expect(r.outcome).toBe('kept_open')
    expect(incidentService.addIncidentComment.mock.calls[0]![2]).toContain('va chiuso a mano')
    expect(incidentService.resolveIncident).not.toHaveBeenCalled()
  })

  it('il commento si scrive UNA volta sola: alla valutazione successiva nessun secondo commento', async () => {
    onCypher([[FIND_RE, openRow({ step: 'in_progress', keptOpenNotedAt: NOW })], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input({ health: 'degraded', impactScore: 20, causes: [cause('db-01', { health: 'degraded' })] }))
    expect(r.outcome).toBe('none')
    expect(incidentService.addIncidentComment).not.toHaveBeenCalled()
  })

  it('tornato sopra soglia con le stesse cause → il marcatore viene azzerato (il commento potrà essere riscritto)', async () => {
    onCypher([[FIND_RE, openRow({ step: 'in_progress', keptOpenNotedAt: NOW })], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input())
    expect(r.outcome).toBe('none')
    expect(callMatching(LINK_RE)!.params).toMatchObject({ keptOpenNoted: false, maintenanceNoted: false })
  })

  it('la causa di risoluzione viene dalla salute vera: si chiude SOLO da operational', async () => {
    workflow.getAvailableTransitions.mockResolvedValue([{ toStep: 'resolved' }])
    onCypher([[FIND_RE, openRow({ step: 'in_progress' })], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input({ health: 'operational', impactScore: 0, causes: [] }))
    expect(r.outcome).toBe('resolved')
    expect(incidentService.resolveIncident).toHaveBeenCalledWith('inc-1', { tenantId: 't1', userId: 'monitoring' }, 'Servizio tornato operativo')
    expect(serviceResolveCause('operational')).toBe('Servizio tornato operativo')
    expect(serviceResolveCause('degraded')).toBe('Servizio tornato degradato')
    // e il marcatore d'idempotenza dell'apertura viene ripulito
    expect(fakeRedis.del).toHaveBeenCalledWith('og:services:incident:opened:t1:map-1')
  })

  it('keptOpenReason: i tre testi, senza frasi inventate', () => {
    expect(keptOpenReason('degraded', 'down', 'X')).toContain('sotto la soglia di apertura ("down")')
    expect(keptOpenReason('unknown', 'down', 'X')).toContain('stato sconosciuto')
    expect(keptOpenReason('down', 'never', 'X')).toContain('"mai aprire incident"')
  })
})

// ── Revisione 2 · I2: apertura idempotente ───────────────────────────────────

describe('apertura idempotente (I2)', () => {
  it('IMPACTS_SERVICE fallita al primo giro → al retry si RICOLLEGA lo stesso incident, nessun doppione, un solo evento', async () => {
    // primo giro: il link fallisce dopo createIncident
    onCypher([[FIND_RE, null], [LINK_RE, () => { throw new Error('neo4j transient') }]])
    await expect(reconcileServiceIncident(input())).rejects.toThrow('neo4j transient')
    expect(incidentService.createIncident).toHaveBeenCalledTimes(1)
    expect(redisStore.get('og:services:incident:opened:t1:map-1')).toBe('inc-9')
    expect(publishEvent).not.toHaveBeenCalled()

    // retry: l'incident non è collegato, findServiceIncident non lo vede
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[FIND_RE, null], [BY_ID_RE, { number: 'INC00000099' }], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input())
    expect(r).toEqual({ outcome: 'opened', incidentId: 'inc-9', incidentNumber: 'INC00000099' })
    expect(incidentService.createIncident).not.toHaveBeenCalled()   // nessun secondo incident
    expect(publishEvent).toHaveBeenCalledTimes(1)                   // un solo evento
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ incidentId: 'inc-9' }), expect.stringContaining('relinked instead of opening a second one'))
    expect(serviceIncidentOpenedKey('t1', 'map-1')).toBe('og:services:incident:opened:t1:map-1')
    expect(SERVICE_INCIDENT_OPENED_TTL_SECONDS).toBe(3600)
  })

  it('marcatore che punta a un incident sparito → si riparte e se ne apre uno nuovo (mai un id inventato)', async () => {
    redisStore.set('og:services:incident:opened:t1:map-1', 'inc-vanished')
    onCypher([[FIND_RE, null], [BY_ID_RE, null], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input())
    expect(r.outcome).toBe('opened')
    expect(r.incidentId).toBe('inc-9')
    expect(incidentService.createIncident).toHaveBeenCalledTimes(1)
  })

  it('«Causa aggiornata»: cause_ids scritte PRIMA del commento (al retry il confronto è già allineato)', async () => {
    const order: string[] = []
    incidentService.addIncidentComment.mockImplementationOnce(async () => { order.push('comment') })
    onCypher([[FIND_RE, openRow({ causeIds: ['db-01'] })], [LINK_RE, () => { order.push('link'); return { at: NOW } }]])
    await reconcileServiceIncident(input({ causes: [cause('srv-7')] }))
    expect(order).toEqual(['link', 'comment'])
  })
})

// ── Ondata 4 §1: contatori ───────────────────────────────────────────────────

describe('metriche degli incident di servizio', () => {
  it('apertura → service_incidents_opened_total; riapertura → di nuovo opened (conta come apertura), MAI resolved', async () => {
    onCypher([[FIND_RE, null], [LINK_RE, { at: NOW }]])
    await reconcileServiceIncident(input())
    expect(metrics.serviceIncidentsOpenedTotal.inc).toHaveBeenCalledTimes(1)
    expect(metrics.serviceIncidentsOpenedTotal.inc).toHaveBeenCalledWith({})
    expect(metrics.serviceIncidentsResolvedTotal.inc).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[FIND_RE, openRow({ step: 'resolved' })], [LINK_RE, { at: NOW }]])
    expect((await reconcileServiceIncident(input())).outcome).toBe('reopened')
    expect(metrics.serviceIncidentsOpenedTotal.inc).toHaveBeenCalledTimes(1)
    expect(metrics.serviceIncidentsResolvedTotal.inc).not.toHaveBeenCalled()
  })

  it('chiusura automatica → service_incidents_resolved_total; nessun cammino (resolve_skipped) → nessun contatore', async () => {
    workflow.getAvailableTransitions.mockResolvedValue([{ toStep: 'resolved' }])
    onCypher([[FIND_RE, openRow({ step: 'in_progress' })], [LINK_RE, { at: NOW }]])
    expect((await reconcileServiceIncident(input({ health: 'operational', impactScore: 0, causes: [] }))).outcome).toBe('resolved')
    expect(metrics.serviceIncidentsResolvedTotal.inc).toHaveBeenCalledTimes(1)
    expect(metrics.serviceIncidentsResolvedTotal.inc).toHaveBeenCalledWith({})
    expect(metrics.serviceIncidentsOpenedTotal.inc).not.toHaveBeenCalled()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    workflow.getAvailableTransitions.mockResolvedValue([])
    vi.mocked(loadDefinitionTransitions).mockResolvedValue([])
    onCypher([[FIND_RE, openRow({ step: 'on_hold' })], [LINK_RE, { at: NOW }]])
    expect((await reconcileServiceIncident(input({ health: 'operational', impactScore: 0, causes: [] }))).outcome).toBe('resolve_skipped')
    expect(metrics.serviceIncidentsResolvedTotal.inc).not.toHaveBeenCalled()
  })

  it('commento «Causa aggiornata», manutenzione e mappe non attive non toccano i contatori', async () => {
    onCypher([[FIND_RE, openRow({ causeIds: ['db-01'] })], [LINK_RE, { at: NOW }]])
    await reconcileServiceIncident(input({ causes: [cause('srv-7')] }))
    onCypher([[FIND_RE, openRow({ step: 'in_progress' })], [LINK_RE, { at: NOW }]])
    await reconcileServiceIncident(input({ health: 'maintenance', impactScore: 0, causes: [] }))
    onCypher([[FIND_RE, null]])
    await reconcileServiceIncident(input({ status: 'paused' }))
    expect(metrics.serviceIncidentsOpenedTotal.inc).not.toHaveBeenCalled()
    expect(metrics.serviceIncidentsResolvedTotal.inc).not.toHaveBeenCalled()
  })
})

// ── Ondata 4 §5: collegamento agli incident tecnici ──────────────────────────

describe('incident tecnici già aperti sui componenti', () => {
  const tech = [{ number: 'INC00000011', title: 'DB-01 non raggiungibile' }, { number: 'INC00000012', title: 'CACHE-02 in errore' }]

  it('apertura: UNA query sui CI delle cause, scopata per tenant, senza gli incident di servizio e senza i passi terminali; la descrizione li elenca', async () => {
    onCypher([[TECH_RE, tech], [FIND_RE, null], [LINK_RE, { at: NOW }]])
    const r = await reconcileServiceIncident(input({ causes: [cause('db-01'), cause('cache-02', { health: 'degraded' })] }))
    expect(r.outcome).toBe('opened')

    const q = callMatching(TECH_RE)!
    expect(q.cypher).toBe(FIND_TECHNICAL_INCIDENTS_CYPHER)
    expect(q.cypher).toContain('MATCH (i:Incident {tenant_id: $tenantId})-[:AFFECTED_BY]->(ci {tenant_id: $tenantId})')
    expect(q.cypher).toContain('NOT EXISTS { (i)-[:IMPACTS_SERVICE]->(:ServiceMap {tenant_id: $tenantId}) }')
    expect(q.cypher).toContain('WHERE NOT wi.current_step IN $terminalSteps')
    expect(q.cypher).toContain('LIMIT toInteger($limit)')
    expect(q.params).toEqual({ tenantId: 't1', ciIds: ['db-01', 'cache-02'], terminalSteps: ['resolved', 'closed'], limit: SERVICE_MAX_TECHNICAL_INCIDENTS })
    expect(SERVICE_MAX_TECHNICAL_INCIDENTS).toBe(10)

    const description = incidentService.createIncident.mock.calls[0]![0].description as string
    expect(description).toContain(TECHNICAL_INCIDENTS_HEADING)
    expect(description).toContain('- INC00000011 DB-01 non raggiungibile')
    expect(description).toContain('- INC00000012 CACHE-02 in errore')
    // additiva: l'incident del servizio si apre comunque, nulla viene soppresso
    expect(incidentService.createIncident).toHaveBeenCalledTimes(1)
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'service.incident_opened', 'ServiceMap', 'map-1',
      expect.objectContaining({ technicalIncidents: ['INC00000011', 'INC00000012'] }))
  })

  it('nessun incident tecnico → nessuna riga in più nella descrizione', async () => {
    onCypher([[FIND_RE, null], [LINK_RE, { at: NOW }]])
    await reconcileServiceIncident(input())
    const description = incidentService.createIncident.mock.calls[0]![0].description as string
    expect(description).not.toContain(TECHNICAL_INCIDENTS_HEADING)
    expect(description.trimEnd().endsWith('- DB-01 (non disponibile) — percorso: DB-01 → API-03')).toBe(true)
  })

  it('la ricerca gira SOLO all\'apertura: riapertura, commento e chiusura non la eseguono', async () => {
    onCypher([[TECH_RE, tech], [FIND_RE, openRow({ step: 'resolved' })], [LINK_RE, { at: NOW }]])
    await reconcileServiceIncident(input())
    expect(callMatching(TECH_RE)).toBeUndefined()

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[TECH_RE, tech], [FIND_RE, openRow({ causeIds: ['db-01'] })], [LINK_RE, { at: NOW }]])
    await reconcileServiceIncident(input({ causes: [cause('srv-7')] }))
    expect(callMatching(TECH_RE)).toBeUndefined()
  })

  it('serviceIncidentDescription: l\'elenco è in coda ai componenti e senza incident non compare', () => {
    const withTech = serviceIncidentDescription('Enterprise Billing', 'down', 62, [cause('db-01')], tech)
    expect(withTech.split('\n').slice(-3)).toEqual([TECHNICAL_INCIDENTS_HEADING, '- INC00000011 DB-01 non raggiungibile', '- INC00000012 CACHE-02 in errore'])
    expect(serviceIncidentDescription('Enterprise Billing', 'down', 62, [cause('db-01')])).not.toContain(TECHNICAL_INCIDENTS_HEADING)
    expect(serviceIncidentDescription('Enterprise Billing', 'down', 62, [cause('db-01')], [])).not.toContain(TECHNICAL_INCIDENTS_HEADING)
  })
})
