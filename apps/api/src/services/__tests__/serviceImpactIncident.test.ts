/**
 * services/serviceImpact/incident.ts — incident del servizio (ondata 3):
 * soglia `open_incident_from`, apertura con priorità criticità × salute,
 * relazione IMPACTS_SERVICE ed evento `service.incident_opened`, commento
 * «Causa aggiornata» solo quando le cause cambiano davvero, riapertura invece
 * di un doppione, chiusura automatica con il cammino verso `resolved`,
 * manutenzione (nessuna apertura, un solo commento), mappe non attive che non
 * aprono nulla e un solo incident sotto raffica (lock Redis vero, in memoria).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisStore = vi.hoisted(() => new Map<string, string>())
const fakeRedis = vi.hoisted(() => ({
  set: vi.fn(async (key: string, value: string, _ex: string, _ttl: number, nx?: string) => {
    if (nx === 'NX' && redisStore.has(key)) return null
    redisStore.set(key, value)
    return 'OK'
  }),
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

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => (v == null ? 0 : Number(v)) }))
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

const { getSession, runQueryOne } = await import('@opengraphity/neo4j')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { audit } = await import('../../lib/audit.js')
const { logger } = await import('../../lib/logger.js')
const { reopenIncident, runMonitoringTransition, loadDefinitionTransitions } = await import('../events/incidentWorkflow.js')
const { GROUP_LOCK_OPTS } = await import('../events/grouping.js')
const {
  reconcileServiceIncident, serviceIncidentLockKey, meetsServiceOpenThreshold, serviceImpactOf, serviceUrgencyOf,
  serviceIncidentTitle, serviceIncidentDescription, SERVICE_INCIDENT_LOCK_OPTS, SERVICE_HEALTH_LABEL_IT,
  FIND_SERVICE_INCIDENT_CYPHER, LINK_SERVICE_INCIDENT_CYPHER,
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

function cause(ciId: string, over: Partial<StoredCause> = {}): StoredCause {
  return {
    ciId, health: 'down', weight: 5, critical: false,
    ci:   { id: ciId, name: ciId.toUpperCase(), type: 'database', health: 'down' },
    path: [{ id: ciId, name: ciId.toUpperCase(), type: 'database', health: 'down' }, { id: 'api-03', name: 'API-03', type: 'application', health: 'operational' }],
    ...over,
  }
}

function onCypher(rules: Array<[RegExp, unknown]>) {
  vi.mocked(runQueryOne).mockImplementation((async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
    for (const [re, value] of rules) if (re.test(cypher)) return typeof value === 'function' ? (value as (p?: Record<string, unknown>) => unknown)(params) : value
    throw new Error(`unexpected cypher in test:\n${cypher}`)
  }) as never)
}
const calls = () => vi.mocked(runQueryOne).mock.calls.map(([, cypher, params]) => ({ cypher: cypher as string, params: params as Record<string, unknown> }))
const callMatching = (re: RegExp) => calls().find((c) => re.test(c.cypher))

const openRow = (over: Record<string, unknown> = {}) => ({ incidentId: 'inc-1', instanceId: 'wi-1', step: 'new', number: 'INC00000042', causeIds: ['db-01'], maintenanceNotedAt: null, ...over })

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

  it('impatto dalla criticità (mission/business critical → high, gli altri → medium); assente o ignota → medium con warning', () => {
    const ctx = { tenantId: 't1', mapId: 'map-1' }
    expect(serviceImpactOf('mission_critical', ctx)).toBe('high')
    expect(serviceImpactOf('business_critical', ctx)).toBe('high')
    expect(serviceImpactOf('business_operational', ctx)).toBe('medium')
    expect(serviceImpactOf('office_productivity', ctx)).toBe('medium')
    expect(log.warn).not.toHaveBeenCalled()
    expect(serviceImpactOf(null, ctx)).toBe('medium')
    expect(serviceImpactOf('boh', ctx)).toBe('medium')
    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(vi.mocked(log.warn).mock.calls[0]![1]).toContain('falls back to medium')
  })

  it('urgenza dalla salute: giù → high, degradato → medium; una salute che non apre incident è un errore', () => {
    expect(serviceUrgencyOf('down')).toBe('high')
    expect(serviceUrgencyOf('degraded')).toBe('medium')
    expect(() => serviceUrgencyOf('operational')).toThrow(/no incident urgency/)
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
    expect(link.params).toEqual({ tenantId: 't1', mapId: 'map-1', incidentId: 'inc-9', causeIds: ['db-01', 'cache-02'], maintenanceNoted: false, now: NOW, openedBy: 'monitoring' })

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
    expect(redisStore.size).toBe(0)   // lock rilasciato in entrambi i casi
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
