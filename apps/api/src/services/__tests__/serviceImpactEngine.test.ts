/**
 * services/serviceImpact — costruzione della mappa (build.ts: Cypher pinnato,
 * tetto di 500 nodi, precedenza del percorso più corto, impostazioni proposte
 * per ruolo), cronologia (history.ts: frammento e parametri), motore
 * (engine.ts: una lettura + una scrittura per valutazione, salute
 * cambiata/invariata/stale, evento e audit solo se cambia, maintenance dalla
 * finestra di change, createServiceMap in transazione + valutazione
 * `created`, mappe che includono un CI, passata periodica paginata, gauge).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => (v == null ? 0 : Number(v)) }))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../../middleware/metrics.js', () => ({
  serviceEvaluationsTotal: { inc: vi.fn() }, serviceEvaluationDurationSeconds: { observe: vi.fn() }, servicesHealth: { set: vi.fn() },
  eventsSuppressedTotal: { inc: vi.fn() },
}))

const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { audit } = await import('../../lib/audit.js')
const { logger } = await import('../../lib/logger.js')
const metrics = await import('../../middleware/metrics.js')
const { buildServiceMap, proposeNodeSettings, relationshipFilterOf, CI_LABEL_FILTER, ENTRY_NODES_CYPHER, EXPAND_NODES_CYPHER, CREATE_SERVICE_MAP_CYPHER, assertRelationshipTypes, assertMaxDepth } = await import('../serviceImpact/build.js')
const { serviceHistoryWriteCypher, serviceHistoryParams } = await import('../serviceImpact/history.js')
const { evaluateServiceMap, createServiceMap, findMapsIncludingCI, evaluateStaleOrOldMaps, refreshServiceGauges, loadServiceMapState, LOAD_SERVICE_MAP_CYPHER, evaluationWriteCypher, SERVICE_STALE_EVALUATION_MINUTES } = await import('../serviceImpact/engine.js')
const { SERVICE_HISTORY_MAX, SERVICE_MAP_MAX_NODES, DEFAULT_SERVICE_IMPACT_RULES_JSON, SERVICE_RELATIONSHIP_TYPES } = await import('../../lib/serviceVocabularies.js')
const { CHANGE_WINDOW_STEPS } = await import('../events/suppression.js')
const { ALL_CI_LABELS } = await import('../../lib/ciLabels.js')

const NOW = '2026-09-10T10:00:00.000Z'
const log = logger.child({})
const tx = { run: vi.fn() }
const session = { close: vi.fn().mockResolvedValue(undefined), executeWrite: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)) }

function onCypher(rules: Array<[RegExp, unknown]>) {
  const impl = async (_s: unknown, cypher: string, params?: Record<string, unknown>) => {
    for (const [re, value] of rules) if (re.test(cypher)) return typeof value === 'function' ? (value as (p?: Record<string, unknown>) => unknown)(params) : value
    throw new Error(`unexpected cypher in test:\n${cypher}`)
  }
  vi.mocked(runQueryOne).mockImplementation(impl as never)
  vi.mocked(runQuery).mockImplementation((async (s: unknown, c: string, p?: Record<string, unknown>) => { const r = await impl(s, c, p); return r == null ? [] : Array.isArray(r) ? r : [r] }) as never)
}
const calls = () => [...vi.mocked(runQueryOne).mock.calls, ...vi.mocked(runQuery).mock.calls].map(([s, cypher, params]) => ({ session: s, cypher: cypher as string, params: params as Record<string, unknown> }))
const callMatching = (re: RegExp) => calls().find((c) => re.test(c.cypher))

const LOAD_RE = /MATCH \(m:ServiceMap \{id: \$mapId, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(m\)-\[inc:INCLUDES\]->/
const WRITE_RE = /SET m\.health = \$health, m\.impact_score = toInteger\(\$impactScore\)/

/** Riga di lettura della mappa: l'esempio Billing (api-03 L1 critico, db-01, cache-02, cert never). */
function stateRow(over: { props?: Record<string, unknown>; nodes?: Record<string, unknown>[] } = {}) {
  const n = (o: Record<string, unknown>) => ({ name: o['ciId'], labels: ['Server'], level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'api-03', addedBy: 'auto', health: 'operational', healthSource: 'monitoring', status: 'active', changes: [], ...o })
  return {
    props: { id: 'map-1', tenant_id: 't1', service_id: 'ba-1', name: 'Enterprise Billing', status: 'active', rules: DEFAULT_SERVICE_IMPACT_RULES_JSON, health: null, stale: false, node_ids: ['api-03', 'db-01', 'cache-02', 'cert-1'], ...over.props },
    nodes: over.nodes ?? [
      n({ ciId: 'api-03', labels: ['Application'], level: 1, role: 'entry', weight: 8, critical: true, via: null }),
      n({ ciId: 'db-01', labels: ['Database'], health: 'down' }),
      n({ ciId: 'cache-02', weight: 3, health: 'degraded' }),
      n({ ciId: 'cert-1', labels: ['Certificate'], role: 'certificate', propagate: 'never', weight: 3, health: null }),
    ],
  }
}
const writeRow = (over: Record<string, unknown> = {}) => ({ id: 'map-1', previous: null, changed: true, wasStale: false, serviceId: 'ba-1', name: 'Enterprise Billing', ...over })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
})

// ── build.ts ─────────────────────────────────────────────────────────────────

describe('buildServiceMap', () => {
  const entry = { serviceName: 'Enterprise Billing', apps: [{ ciId: 'app-3', name: 'APP-003', labels: ['Application'] }] }
  const expanded = [
    { ciId: 'db-1', name: 'DB-01', level: 2, via: 'app-3', labels: ['Database'] },
    { ciId: 'srv-1', name: 'SRV-01', level: 2, via: 'app-3', labels: ['Server'] },
    { ciId: 'cert-1', name: 'CERT-01', level: 2, via: 'app-3', labels: ['Certificate'] },
    { ciId: 'stor-1', name: 'STOR-01', level: 3, via: 'srv-1', labels: ['Storage'] },
  ]

  it('due query pinnate: livello 1 da REALIZES (solo label del metamodello, stesso tenant), poi apoc.path.expandConfig BFS/NODE_GLOBAL in uscita fino a maxDepth−1 con limit = tetto + 1; proposta con ruolo/peso/critico per livello e tipo', async () => {
    onCypher([[/MATCH \(ba:BusinessApplication \{id: \$serviceId, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(ba\)-\[:REALIZES\]->\(app \{tenant_id: \$tenantId\}\)/, entry], [/apoc\.path\.expandConfig/, expanded]])
    const p = await buildServiceMap(session as never, 't1', 'ba-1', 4, ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE'])
    expect(p.serviceName).toBe('Enterprise Billing')
    expect(p.maxDepth).toBe(4)
    expect(p.relationshipTypes).toEqual(['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE'])
    expect(p.nodes).toEqual([
      { ciId: 'app-3', name: 'APP-003', labels: ['Application'], level: 1, via: null, role: 'entry', propagate: 'weighted', weight: 8, critical: true },
      { ciId: 'db-1', name: 'DB-01', labels: ['Database'], level: 2, via: 'app-3', role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false },
      { ciId: 'srv-1', name: 'SRV-01', labels: ['Server'], level: 2, via: 'app-3', role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false },
      { ciId: 'cert-1', name: 'CERT-01', labels: ['Certificate'], level: 2, via: 'app-3', role: 'certificate', propagate: 'never', weight: 3, critical: false },
      { ciId: 'stor-1', name: 'STOR-01', labels: ['Storage'], level: 3, via: 'srv-1', role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false },
    ])
    const e = callMatching(/REALIZES/)!
    expect(e.cypher).toBe(ENTRY_NODES_CYPHER)
    expect(e.cypher).toContain("WHERE ANY(l IN labels(app) WHERE l IN $ciLabels)")
    expect(e.params).toEqual({ serviceId: 'ba-1', tenantId: 't1', ciLabels: ALL_CI_LABELS })
    const x = callMatching(/apoc\.path\.expandConfig/)!
    expect(x.cypher).toBe(EXPAND_NODES_CYPHER)
    expect(x.cypher).toMatch(/MATCH \(app \{tenant_id: \$tenantId\}\)\s+WHERE app\.id IN \$appIds\s+WITH collect\(app\) AS apps/)
    expect(x.cypher).toContain("uniqueness:         'NODE_GLOBAL'")
    expect(x.cypher).toContain('bfs:                true')
    expect(x.cypher).toContain('maxLevel:           toInteger($maxLevel)')
    expect(x.cypher).toContain('WHERE ALL(n IN nodes(path) WHERE n.tenant_id = $tenantId)')
    expect(x.cypher).toContain('WITH last(nodes(path)) AS node, length(path) + 1 AS level, nodes(path)[-2] AS pred')
    expect(x.params).toEqual({
      tenantId: 't1', appIds: ['app-3'], relFilter: 'DEPENDS_ON>|HOSTED_ON>|INSTALLED_ON>|USES_CERTIFICATE>', labelFilter: CI_LABEL_FILTER,
      maxLevel: 3, limit: SERVICE_MAP_MAX_NODES + 1,
    })
    expect(CI_LABEL_FILTER).toBe(ALL_CI_LABELS.map((l) => `+${l}`).join('|'))
    expect(relationshipFilterOf(['HOSTED_ON'])).toBe('HOSTED_ON>')
  })

  it('precedenza del percorso più corto: un nodo ripetuto (o uguale a un\'applicazione di livello 1) tiene la prima occorrenza (livello più basso e il suo via)', async () => {
    onCypher([[/REALIZES/, entry], [/apoc\.path\.expandConfig/, [
      { ciId: 'db-1', name: 'DB-01', level: 2, via: 'app-3', labels: ['Database'] },
      { ciId: 'app-3', name: 'APP-003', level: 3, via: 'db-1', labels: ['Application'] },
      { ciId: 'db-1', name: 'DB-01', level: 3, via: 'srv-x', labels: ['Database'] },
    ]]])
    const p = await buildServiceMap(session as never, 't1', 'ba-1', 4, ['DEPENDS_ON'])
    expect(p.nodes.map((n) => [n.ciId, n.level, n.via])).toEqual([['app-3', 1, null], ['db-1', 2, 'app-3']])
  })

  it('maxDepth 1 → solo il livello 1, nessuna espansione; relazioni normalizzate nell\'ordine canonico e senza doppioni', async () => {
    onCypher([[/REALIZES/, entry]])
    const p = await buildServiceMap(session as never, 't1', 'ba-1', 1, ['USES_CERTIFICATE', 'DEPENDS_ON', 'DEPENDS_ON'])
    expect(p.nodes).toHaveLength(1)
    expect(p.relationshipTypes).toEqual(['DEPENDS_ON', 'USES_CERTIFICATE'])
    expect(callMatching(/apoc/)).toBeUndefined()
  })

  it('servizio senza REALIZES → proposta vuota con warning; servizio inesistente → NOT_FOUND', async () => {
    onCypher([[/REALIZES/, { serviceName: 'Vuoto', apps: [] }]])
    const p = await buildServiceMap(session as never, 't1', 'ba-1', 4, [...SERVICE_RELATIONSHIP_TYPES])
    expect(p.nodes).toEqual([])
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'ba-1' }), expect.stringContaining('no REALIZES'))
    onCypher([[/REALIZES/, null]])
    await expect(buildServiceMap(session as never, 't1', 'ba-x', 4, ['DEPENDS_ON'])).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })

  it('oltre 500 nodi → BAD_USER_INPUT con il conteggio raggiunto (mai un taglio silenzioso)', async () => {
    const many = Array.from({ length: SERVICE_MAP_MAX_NODES }, (_, i) => ({ ciId: `n-${i}`, name: `N-${i}`, level: 2, via: 'app-3', labels: ['Server'] }))
    onCypher([[/REALIZES/, entry], [/apoc/, many]])
    const err = await buildServiceMap(session as never, 't1', 'ba-1', 4, ['DEPENDS_ON']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
    expect((err as GraphQLError).message).toMatch(/would exceed 500 nodes \(at least 501 reached with maxDepth 4 over DEPENDS_ON\)/)
  })

  it('validazione di profondità e relazioni → BAD_USER_INPUT prima di ogni query', async () => {
    for (const d of [0, 9, 2.5, NaN]) await expect(buildServiceMap(session as never, 't1', 'ba-1', d, ['DEPENDS_ON'])).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    await expect(buildServiceMap(session as never, 't1', 'ba-1', 4, [])).rejects.toThrow(/at least one of/)
    await expect(buildServiceMap(session as never, 't1', 'ba-1', 4, ['REALIZES'])).rejects.toThrow(/"REALIZES" is not one of/)
    expect(runQueryOne).not.toHaveBeenCalled()
    expect(assertMaxDepth(8)).toBe(8)
    expect(assertRelationshipTypes(['HOSTED_ON'])).toEqual(['HOSTED_ON'])
  })

  it('proposeNodeSettings: livello 1 → entry 8 critico; certificato → never 3; infrastruttura/componente → weighted 5; label non del metamodello → errore', () => {
    expect(proposeNodeSettings(['Server'], 1)).toEqual({ role: 'entry', propagate: 'weighted', weight: 8, critical: true })
    expect(proposeNodeSettings(['SslCertificate'], 2)).toEqual({ role: 'certificate', propagate: 'never', weight: 3, critical: false })
    expect(proposeNodeSettings(['Microservice'], 3)).toEqual({ role: 'component', propagate: 'weighted', weight: 5, critical: false })
    expect(proposeNodeSettings(['VirtualMachine'], 2).role).toBe('infrastructure')
    expect(() => proposeNodeSettings(['ErpSystem'], 2)).toThrow(/No service node role for CI labels \["ErpSystem"\]/)
  })
})

// ── history.ts ───────────────────────────────────────────────────────────────

describe('serviceHistoryWriteCypher / serviceHistoryParams', () => {
  it('CREATE (m)-[:HAS_HEALTH_HISTORY]->(:ServiceHealthEntry {…}) con tenant_id e map_id in un FOREACH condizionale; cap nello stesso statement (mai la `created`), SKIP 499', () => {
    expect(SERVICE_HISTORY_MAX).toBe(500)
    const q = serviceHistoryWriteCypher()
    expect(q).toMatch(/^FOREACH \(_ IN CASE WHEN true THEN \[1\] ELSE \[\] END \|\s+CREATE \(m\)-\[:HAS_HEALTH_HISTORY\]->\(:ServiceHealthEntry \{id: \$hId, tenant_id: \$tenantId, map_id: m\.id, at: \$hAt, health: \$hHealth, previous_health: \$hPreviousHealth,/)
    expect(q).toContain('impact_score: toInteger($hImpactScore), cause: $hCause, trigger: $hTrigger, note: $hNote})')
    expect(q).toMatch(/WITH \*\s+CALL \{\s+WITH m\s+UNWIND CASE WHEN true THEN \[1\] ELSE \[\] END AS _\s+MATCH \(m\)-\[:HAS_HEALTH_HISTORY\]->\(old:ServiceHealthEntry \{tenant_id: \$tenantId\}\)\s+WHERE old\.trigger <> 'created'\s+WITH old ORDER BY old\.at DESC, old\.id DESC\s+SKIP 499\s+DETACH DELETE old\s+\}$/)
  })

  it('prefisso, condizione, campo previous_health come espressione, cap disattivabile o con condizione propria', () => {
    const noCap = serviceHistoryWriteCypher({ when: 'changed', prefix: 'x', fields: { previousHealth: 'previous' }, cap: false })
    expect(noCap).toContain('CASE WHEN changed THEN [1]')
    expect(noCap).toContain('id: $xId')
    expect(noCap).toContain('previous_health: previous,')
    expect(noCap).not.toContain('CALL {')
    const cap = serviceHistoryWriteCypher({ when: 'becameStale', prefix: 'st', imports: ['previous', 'becameStale', 'changed'], capWhen: 'changed OR becameStale' })
    expect(cap).toMatch(/CALL \{\s+WITH m, previous, becameStale, changed\s+UNWIND CASE WHEN changed OR becameStale THEN/)
  })

  it('parametri: id nuovo, at = now, cause serializzata, note null di default; prefisso personalizzabile', () => {
    const a = serviceHistoryParams({ trigger: 'ci_health', health: 'degraded', previousHealth: 'operational', impactScore: 41, causes: [] }, NOW)
    const b = serviceHistoryParams({ trigger: 'ci_health', health: 'degraded', previousHealth: 'operational', impactScore: 41, causes: [] }, NOW)
    expect(a).toEqual({ hId: expect.any(String), hAt: NOW, hHealth: 'degraded', hPreviousHealth: 'operational', hImpactScore: 41, hCause: '[]', hTrigger: 'ci_health', hNote: null })
    expect(a['hId']).not.toBe(b['hId'])
    expect(serviceHistoryParams({ trigger: 'map_changed', health: 'down', previousHealth: null, impactScore: 0, causes: [], note: 'n', at: 'T0' }, NOW, 'st')).toMatchObject({ stAt: 'T0', stNote: 'n', stTrigger: 'map_changed' })
  })
})

// ── engine.ts ────────────────────────────────────────────────────────────────

describe('evaluateServiceMap', () => {
  it('salute cambiata: UNA lettura (mappa + INCLUDES + change in finestra) e UNA scrittura (SET + voce + cap, decisione nel Cypher); evento service.health_changed, audit, metrica changed', async () => {
    onCypher([[LOAD_RE, stateRow()], [WRITE_RE, writeRow()]])
    const r = await evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'ci_health', now: NOW, jobId: 'j1' })
    expect(r).toMatchObject({ mapId: 'map-1', health: 'degraded', previousHealth: null, impactScore: 41, changed: true, stale: false })
    expect(r.causes.map((c) => [c.ciId, c.ci.name, c.ci.type, c.ci.health, c.path.map((p) => p.id)])).toEqual([
      ['db-01', 'db-01', 'database', 'down', ['db-01', 'api-03']],
      ['cache-02', 'cache-02', 'server', 'degraded', ['cache-02', 'api-03']],
    ])
    expect(runQueryOne).toHaveBeenCalledTimes(2)
    expect(runQuery).not.toHaveBeenCalled()
    expect(getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(session.close).toHaveBeenCalledTimes(1)

    const load = callMatching(LOAD_RE)!
    expect(load.cypher).toBe(LOAD_SERVICE_MAP_CYPHER)
    expect(load.cypher).toContain("[(c:Change {tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)")
    expect(load.cypher).toContain('EXISTS { (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId}) WHERE wi.current_step IN $windowSteps }')
    expect(load.cypher).toContain("plans: [(c)-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask {tenant_id: $tenantId}) | dp.steps]")
    expect(load.params).toEqual({ mapId: 'map-1', tenantId: 't1', windowSteps: CHANGE_WINDOW_STEPS })

    const w = callMatching(WRITE_RE)!
    expect(w.cypher).toBe(evaluationWriteCypher())
    expect(w.cypher).toContain('MATCH (m:ServiceMap {id: $mapId, tenant_id: $tenantId})')
    expect(w.cypher).toContain('(previous IS NULL OR previous <> $health) AS changed, ($stale AND NOT wasStale) AS becameStale')
    expect(w.cypher).toContain('m.health_since = CASE WHEN changed THEN $now ELSE m.health_since END')
    expect(w.cypher).toContain('FOREACH (_ IN CASE WHEN changed THEN [1] ELSE [] END |')
    expect(w.cypher).toContain('FOREACH (_ IN CASE WHEN becameStale THEN [1] ELSE [] END |')
    expect(w.cypher.match(/CALL \{/g)).toHaveLength(1)   // il cap gira una volta sola
    expect(w.cypher).toContain('UNWIND CASE WHEN changed OR becameStale THEN [1] ELSE [] END AS _')
    expect(w.cypher).toMatch(/RETURN m\.id AS id, previous, changed, wasStale, m\.service_id AS serviceId, m\.name AS name$/)
    expect(w.params).toMatchObject({ mapId: 'map-1', tenantId: 't1', now: NOW, stale: false, health: 'degraded', impactScore: 41, hTrigger: 'ci_health', hHealth: 'degraded', hImpactScore: 41, hAt: NOW, stTrigger: 'map_changed', stNote: null })
    expect(JSON.parse(w.params['explanation'] as string)).toEqual(JSON.parse(w.params['hCause'] as string))
    expect(JSON.parse(w.params['explanation'] as string)[0]).toMatchObject({ ciId: 'db-01', health: 'down', weight: 5, critical: false, ci: { id: 'db-01', type: 'database', health: 'down' }, path: [{ id: 'db-01' }, { id: 'api-03', type: 'application', health: 'operational' }] })

    expect(publishEvent).toHaveBeenCalledWith('service.health_changed', 't1', 'monitoring', { id: 'map-1', map_id: 'map-1', service_id: 'ba-1', name: 'Enterprise Billing', previous_health: null, new_health: 'degraded', impact_score: 41 }, NOW)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', userId: 'monitoring' }), 'service.health_changed', 'ServiceMap', 'map-1', expect.objectContaining({ trigger: 'ci_health', previousHealth: null, health: 'degraded', impactScore: 41, causes: ['db-01', 'cache-02'] }))
    expect(metrics.serviceEvaluationsTotal.inc).toHaveBeenCalledWith({ result: 'changed' })
    expect(metrics.serviceEvaluationDurationSeconds.observe).toHaveBeenCalledTimes(1)
  })

  it('salute invariata (deciso dal Cypher): niente evento, niente audit, metrica unchanged; punteggio e spiegazione comunque scritti', async () => {
    onCypher([[LOAD_RE, stateRow({ props: { health: 'degraded' } })], [WRITE_RE, writeRow({ previous: 'degraded', changed: false })]])
    const r = await evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'periodic', now: NOW })
    expect(r).toMatchObject({ health: 'degraded', previousHealth: 'degraded', changed: false })
    expect(publishEvent).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
    expect(callMatching(WRITE_RE)!.params).toMatchObject({ impactScore: 41, health: 'degraded' })
    expect(metrics.serviceEvaluationsTotal.inc).toHaveBeenCalledWith({ result: 'unchanged' })
  })

  it('nodo incluso sparito (node_ids ⊄ INCLUDES) → stale = true, voce map_changed con gli id mancanti, warning; la valutazione prosegue sui nodi rimasti', async () => {
    const s = stateRow({ props: { node_ids: ['api-03', 'db-01', 'cache-02', 'cert-1', 'gone-1', 'gone-2'] } })
    onCypher([[LOAD_RE, s], [WRITE_RE, writeRow()]])
    const r = await evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'ci_health', now: NOW })
    expect(r.stale).toBe(true)
    expect(r.health).toBe('degraded')
    expect(callMatching(WRITE_RE)!.params).toMatchObject({ stale: true, stTrigger: 'map_changed', stNote: 'Componenti non più presenti nella CMDB: gone-1, gone-2', stHealth: 'degraded' })
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ mapId: 'map-1', missing: ['gone-1', 'gone-2'] }), expect.stringContaining('stale'))
    // già stale: il warning non si ripete (la voce è scritta dal Cypher solo se becameStale)
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[LOAD_RE, s], [WRITE_RE, writeRow({ wasStale: true, changed: false, previous: 'degraded' })]])
    await evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'periodic', now: NOW })
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('change in finestra sul nodo critico (deployment, o scheduled con finestra del piano che contiene l\'istante) → maintenance; scheduled fuori finestra → no', async () => {
    const withChange = (changes: unknown[]) => stateRow({ nodes: [
      { ciId: 'api-03', name: 'api-03', labels: ['Application'], level: 1, role: 'entry', propagate: 'weighted', weight: 8, critical: true, via: null, addedBy: 'auto', health: 'operational', healthSource: null, status: 'active', changes },
      { ciId: 'db-01', name: 'db-01', labels: ['Database'], level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'api-03', addedBy: 'auto', health: 'down', healthSource: null, status: 'active', changes: [] },
    ] })
    onCypher([[LOAD_RE, withChange([{ step: 'deployment', plans: [] }])], [WRITE_RE, writeRow()]])
    expect((await evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'ci_health', now: NOW })).health).toBe('maintenance')
    const inWindow = JSON.stringify([{ releaseWindow: { start: '2026-09-10T09:00:00Z', end: '2026-09-10T11:00:00Z' } }])
    onCypher([[LOAD_RE, withChange([{ step: 'scheduled', plans: [inWindow] }])], [WRITE_RE, writeRow()]])
    expect((await evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'ci_health', now: NOW })).health).toBe('maintenance')
    const outOfWindow = JSON.stringify([{ releaseWindow: { start: '2026-09-11T09:00:00Z', end: '2026-09-11T11:00:00Z' } }])
    onCypher([[LOAD_RE, withChange([{ step: 'scheduled', plans: [outOfWindow] }])], [WRITE_RE, writeRow()]])
    // fuori finestra api-03 pesa (8 su 13): db-01 giù = 38 % < 50 → degraded, non maintenance
    expect((await evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'ci_health', now: NOW })).health).toBe('degraded')
  })

  it('ciclo di vita `status = maintenance` sul nodo critico → maintenance anche senza change (la salute di quel CI non viene aggiornata dagli allarmi); su un nodo non critico → non pesa', async () => {
    const withStatus = (l1Status: string, l2Status: string) => stateRow({ nodes: [
      { ciId: 'api-03', name: 'api-03', labels: ['Application'], level: 1, role: 'entry', propagate: 'weighted', weight: 8, critical: true, via: null, addedBy: 'auto', health: null, healthSource: null, status: l1Status, changes: [] },
      { ciId: 'db-01', name: 'db-01', labels: ['Database'], level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'api-03', addedBy: 'auto', health: 'down', healthSource: null, status: l2Status, changes: [] },
    ] })
    onCypher([[LOAD_RE, withStatus('maintenance', 'active')], [WRITE_RE, writeRow()]])
    expect((await evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'ci_health', now: NOW })).health).toBe('maintenance')
    // db-01 in manutenzione non pesa: resta solo api-03 senza salute nota → unknown (non «operativo»)
    onCypher([[LOAD_RE, withStatus('active', 'maintenance')], [WRITE_RE, writeRow()]])
    expect((await evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'ci_health', now: NOW })).health).toBe('unknown')
  })

  it('attore esplicito (mutation) → actor_id dell\'evento e audit con l\'utente', async () => {
    onCypher([[LOAD_RE, stateRow()], [WRITE_RE, writeRow()]])
    await evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'manual', actorId: 'u-1', now: NOW })
    expect(publishEvent).toHaveBeenCalledWith('service.health_changed', 't1', 'u-1', expect.anything(), NOW)
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-1' }), 'service.health_changed', 'ServiceMap', 'map-1', expect.objectContaining({ trigger: 'manual' }))
  })

  it('mappa assente → NOT_FOUND; node_ids assente → errore con la migrazione; regole corrotte → errore; mappa sparita in scrittura → errore; sempre metrica error e sessione chiusa', async () => {
    onCypher([[LOAD_RE, null]])
    await expect(evaluateServiceMap({ tenantId: 't1', mapId: 'map-x', trigger: 'ci_health', now: NOW })).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    onCypher([[LOAD_RE, stateRow({ props: { node_ids: undefined } })]])
    await expect(evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'ci_health', now: NOW })).rejects.toThrow(/has no node_ids — run the 20260910_1080_service_maps_bootstrap migration/)
    onCypher([[LOAD_RE, stateRow({ props: { rules: '{nope' } })]])
    await expect(evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'ci_health', now: NOW })).rejects.toThrow(/ServiceMap map-1 rules is corrupt JSON/)
    onCypher([[LOAD_RE, stateRow()], [WRITE_RE, null]])
    await expect(evaluateServiceMap({ tenantId: 't1', mapId: 'map-1', trigger: 'ci_health', now: NOW })).rejects.toThrow(/vanished while writing its evaluation/)
    expect(vi.mocked(metrics.serviceEvaluationsTotal.inc).mock.calls.every((c) => c[0].result === 'error')).toBe(true)
    expect(metrics.serviceEvaluationsTotal.inc).toHaveBeenCalledTimes(4)
    expect(session.close).toHaveBeenCalledTimes(4)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('loadServiceMapState: nodo con ruolo/propagate/salute fuori vocabolario → errore (nodo non scritto dal motore)', async () => {
    onCypher([[LOAD_RE, stateRow({ nodes: [{ ciId: 'x', labels: ['Server'], level: 2, role: 'boss', propagate: 'weighted', weight: 5, critical: false, via: null, health: null, changes: [] }] })]])
    await expect(loadServiceMapState(session as never, 't1', 'map-1', NOW)).rejects.toThrow(/node x role is "boss"/)
    await expect(loadServiceMapState(session as never, 't1', 'map-1', 'domani')).rejects.toThrow(/not an ISO date/)
  })
})

describe('createServiceMap', () => {
  it('proposta → scrittura in transazione (ServiceMap + INCLUDES, node_ids, regole di default, status active) → valutazione created', async () => {
    const entry = { serviceName: 'Enterprise Billing', apps: [{ ciId: 'app-3', name: 'APP-003', labels: ['Application'] }] }
    onCypher([
      [/REALIZES/, entry],
      [/apoc\.path\.expandConfig/, [{ ciId: 'db-1', name: 'DB-01', level: 2, via: 'app-3', labels: ['Database'] }]],
      [/CREATE \(ba\)-\[:HAS_SERVICE_MAP\]->\(m:ServiceMap/, { id: 'new', linked: 2 }],
      [LOAD_RE, stateRow({ props: { health: null } })],
      [WRITE_RE, writeRow()],
    ])
    const r = await createServiceMap({ tenantId: 't1', serviceId: 'ba-1', maxDepth: 4, relationshipTypes: ['DEPENDS_ON', 'HOSTED_ON'], actorId: 'u-1', now: NOW })
    expect(r.mapId).toMatch(/^[0-9a-f-]{36}$/)
    expect(r.proposal.nodes).toHaveLength(2)
    expect(r.evaluation).toMatchObject({ health: 'degraded', changed: true })

    expect(session.executeWrite).toHaveBeenCalledTimes(1)
    const c = calls().find((x) => /HAS_SERVICE_MAP\]->\(m:ServiceMap/.test(x.cypher))!
    expect(c.session).toBe(tx)   // dentro executeWrite
    expect(c.cypher).toBe(CREATE_SERVICE_MAP_CYPHER)
    expect(c.cypher).toContain('MATCH (ba:BusinessApplication {id: $serviceId, tenant_id: $tenantId})')
    expect(c.cypher).toContain('WHERE NOT EXISTS { (ba)-[:HAS_SERVICE_MAP]->(:ServiceMap {tenant_id: $tenantId}) }')
    expect(c.cypher).toContain("health: 'unknown', health_since: null, impact_score: 0, explanation: '[]', stale: false, evaluated_at: null")
    expect(c.cypher).toContain('node_ids: [n IN $nodes | n.ciId]')
    expect(c.cypher).toContain("CREATE (m)-[:INCLUDES {level: toInteger(n.level), role: n.role, propagate: n.propagate, weight: toInteger(n.weight)")
    expect(c.cypher).toContain('MATCH (ci {id: n.ciId, tenant_id: $tenantId})')
    expect(c.params).toEqual({
      serviceId: 'ba-1', tenantId: 't1', mapId: r.mapId, status: 'active', maxDepth: 4, relationshipTypes: ['DEPENDS_ON', 'HOSTED_ON'],
      rules: DEFAULT_SERVICE_IMPACT_RULES_JSON, actorId: 'u-1', now: NOW,
      nodes: [
        { ciId: 'app-3', level: 1, role: 'entry', propagate: 'weighted', weight: 8, critical: true, via: null },
        { ciId: 'db-1', level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'app-3' },
      ],
    })
    expect(callMatching(WRITE_RE)!.params).toMatchObject({ mapId: r.mapId, hTrigger: 'created' })
    expect(publishEvent).toHaveBeenCalledWith('service.health_changed', 't1', 'u-1', expect.objectContaining({ previous_health: null, new_health: 'degraded' }), NOW)
  })

  it('mappa già esistente (o servizio sparito) → BAD_USER_INPUT senza valutazione; CI sparito fra proposta e scrittura → errore', async () => {
    const entry = { serviceName: 'X', apps: [{ ciId: 'app-3', name: 'APP-003', labels: ['Application'] }] }
    onCypher([[/REALIZES/, entry], [/apoc/, []], [/HAS_SERVICE_MAP\]->\(m:ServiceMap/, null]])
    await expect(createServiceMap({ tenantId: 't1', serviceId: 'ba-1', maxDepth: 2, relationshipTypes: ['DEPENDS_ON'], actorId: 'u-1' })).rejects.toThrow(/already has a service map \(one map per service\) or does not exist/)
    expect(callMatching(LOAD_RE)).toBeUndefined()
    onCypher([[/REALIZES/, entry], [/apoc/, []], [/HAS_SERVICE_MAP\]->\(m:ServiceMap/, { id: 'x', linked: 0 }]])
    await expect(createServiceMap({ tenantId: 't1', serviceId: 'ba-1', maxDepth: 2, relationshipTypes: ['DEPENDS_ON'], actorId: 'u-1' })).rejects.toThrow(/0 of 1 proposed nodes could be linked/)
    await expect(createServiceMap({ tenantId: 't1', serviceId: 'ba-1', maxDepth: 2, relationshipTypes: ['DEPENDS_ON'], actorId: 'u-1', status: 'archived' as never })).rejects.toThrow(/ServiceMap status is "archived"/)
  })
})

describe('findMapsIncludingCI / evaluateStaleOrOldMaps / refreshServiceGauges', () => {
  it('findMapsIncludingCI: mappe del tenant che includono il CI, tranne le paused, per id', async () => {
    onCypher([[/INCLUDES\]->\(ci \{id: \$ciId, tenant_id: \$tenantId\}\)/, [{ id: 'm1', status: 'active' }]]])
    await expect(findMapsIncludingCI('t1', 'ci-1')).resolves.toEqual([{ id: 'm1', status: 'active' }])
    const q = callMatching(/INCLUDES/)!
    expect(q.cypher).toMatch(/MATCH \(m:ServiceMap \{tenant_id: \$tenantId\}\)-\[:INCLUDES\]->\(ci \{id: \$ciId, tenant_id: \$tenantId\}\)\s+WHERE m\.status <> 'paused'/)
    expect(q.params).toEqual({ tenantId: 't1', ciId: 'ci-1' })
  })

  it('evaluateStaleOrOldMaps: pagina di mappe attive non valutate da 10 min o stale (cursore per id), ognuna valutata con trigger periodic; un errore non ferma le altre ma fa fallire alla fine', async () => {
    expect(SERVICE_STALE_EVALUATION_MINUTES).toBe(10)
    let page = 0
    let loads = 0
    onCypher([
      [/MATCH \(m:ServiceMap \{status: 'active'\}\)/, () => (page++ === 0 ? [{ tenantId: 't1', id: 'm1' }, { tenantId: 't2', id: 'm2' }] : [])],
      [LOAD_RE, () => (loads++ === 0 ? stateRow() : null)],
      [WRITE_RE, writeRow({ changed: false, previous: 'degraded' })],
    ])
    await expect(evaluateStaleOrOldMaps(NOW)).rejects.toThrow(/1\/2 service maps failed evaluation/)
    const p = callMatching(/status: 'active'/)!
    expect(p.cypher).toContain("WHERE (m.evaluated_at IS NULL OR m.evaluated_at < $cutoff OR m.stale = true) AND m.id > $cursor")
    expect(p.cypher).toMatch(/ORDER BY m\.id LIMIT toInteger\(\$limit\)/)
    expect(p.params).toEqual({ cutoff: '2026-09-10T09:50:00.000Z', cursor: '', limit: 200 })
    expect(callMatching(WRITE_RE)!.params).toMatchObject({ hTrigger: 'periodic', tenantId: 't1', mapId: 'm1' })
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't2', mapId: 'm2' }), expect.stringContaining('Periodic service map evaluation failed'))
    await expect(evaluateStaleOrOldMaps('ieri')).rejects.toThrow(/not an ISO date/)
  })

  it('refreshServiceGauges: services_health{health} per ogni salute (0 dove assente), su tutti i tenant', async () => {
    onCypher([[/MATCH \(m:ServiceMap\)\s+RETURN m\.health AS health, count\(m\) AS n/, [{ health: 'down', n: 2 }, { health: 'operational', n: 5 }, { health: null, n: 1 }]]])
    await expect(refreshServiceGauges()).resolves.toEqual({ operational: 5, degraded: 0, down: 2, maintenance: 0, unknown: 0 })
    expect(vi.mocked(metrics.servicesHealth.set).mock.calls).toEqual([[{ health: 'operational' }, 5], [{ health: 'degraded' }, 0], [{ health: 'down' }, 2], [{ health: 'maintenance' }, 0], [{ health: 'unknown' }, 0]])
  })
})
