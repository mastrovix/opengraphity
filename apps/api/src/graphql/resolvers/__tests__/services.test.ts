/**
 * resolvers/services.ts — lettura (serviceMaps: una query con contatori del
 * tenant, totale filtrato e pagina ordinata per gravità → punteggio → nome,
 * filtri validati; serviceMap; servicesImpactedByCI; serviceMapCandidates
 * admin), field resolver (nodes con contributes, edges fra inclusi, history
 * ordinata e limitata, historyCount), mapper fail-loud, mutation admin
 * (createServiceMap con default del contratto, reevaluateServiceMap,
 * setServiceMapStatus con expectedVersion, deleteServiceMap con cronologia).
 * Tutto scopato per tenant; RBAC di seconda linea (requireRole).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

// Ondata 7: la traduzione fra valori di dominio è una lettura (la matrice è
// dato del cliente). Qui si misura altro: il doppio risponde con la matrice di
// fabbrica e i vocabolari spediti, senza grafo (lib/__tests__/domainMatrixFake.ts).
vi.mock('../../../lib/domainMatrix.js', () => import('../../../lib/__tests__/domainMatrixFake.js'))

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => (v == null ? 0 : Number(v)) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
// Revisione 2 · D6.2: la lettura della mappa prende `suppress_upstream_hops`
// dalla policy degli allarmi (cache in memoria): qui la policy è mockata, così
// la mappa resta UNA sola query nel test.
vi.mock('../../../services/events/policy.js', () => ({ getEventPolicy: vi.fn().mockResolvedValue({ suppress_upstream_hops: 1,
  // Ondata 7 · C-4: la SEMANTICA del ciclo di vita («ritirato», «in
  // manutenzione») è dato del cliente e vive sulla policy. Qui i valori
  // iniziali, gli stessi che il codice aveva come costanti.
  retired_statuses: ['inactive', 'decommissioned'], maintenance_statuses: ['maintenance'], ignore_lifecycle_statuses: ['decommissioned'] }) }))

vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../../../lib/bullmq.js', () => ({ getQueue: vi.fn(() => ({})) }))
vi.mock('../../../jobs/serviceImpactWorker.js', () => ({ forgetServiceMapJobs: vi.fn().mockResolvedValue(2) }))
vi.mock('../../../services/serviceImpact/engine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/serviceImpact/engine.js')>()),
  createServiceMap: vi.fn(),
  evaluateServiceMap: vi.fn(),
}))
vi.mock('../../../services/events/incidentWorkflow.js', () => ({
  incidentStepInfo: vi.fn(async () => ({ resolvedStep: 'resolved', terminalSteps: ['resolved', 'closed'] })),
}))
// Revisione 2 · D4.3: prima di eliminare la mappa gli incident di servizio ancora aperti ricevono un commento.
vi.mock('../../../services/events/cascade.js', () => ({ noteServiceMapDeletion: vi.fn().mockResolvedValue(1) }))
vi.mock('../../../services/serviceImpact/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/serviceImpact/config.js')>()),
  serviceMapProposal: vi.fn(),
  previewServiceImpact: vi.fn(),
  updateServiceImpactRules: vi.fn(),
  updateServiceMapNodes: vi.fn(),
  applyServiceMapProposal: vi.fn(),
  removeServiceMapExclusion: vi.fn(),
  setServiceMapAutoSync: vi.fn(),
}))
vi.mock('../../../services/serviceImpact/sync.js', () => ({ syncServiceMap: vi.fn(), notifyCIGraphChanged: vi.fn() }))

// Ondata 6 · C-3: le relazioni percorse a monte sono quelle del tenant (il
// field resolver `nodes` riusa la lettura del motore).
vi.mock('../../../lib/ciMetamodelForTenant.js', () => ({
  serviceRelationshipTypesForTenant: vi.fn(async () => ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE']),
  suppressionRelPatternForTenant:    vi.fn(async () => 'DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE'),
  serviceRolesForTenant:             vi.fn(async () => new Map()),
}))

vi.mock('../../../lib/workflowHelpers.js', () => ({
  // Ondata 4 · A4-1: i passi della finestra di change vengono dallo SCOPO.
  // Il tenant di prova ha i nomi di fabbrica con gli scopi della migrazione.
  getStepNamesByPurpose: vi.fn(async (_s: unknown, _t: unknown, _e: unknown, purposes: readonly string[]) =>
    purposes.includes('implementation') ? ['deployment'] : ['scheduled']),
}))

const { serviceResolvers, mapServiceMap, parseStoredCauses, SERVICE_MAP_ORDER, SERVICE_NODE_GONE_ADDED_BY, SET_STATUS_CYPHER } = await import('../services.js')
const config = await import('../../../services/serviceImpact/config.js')
const sync = await import('../../../services/serviceImpact/sync.js')
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { audit } = await import('../../../lib/audit.js')
const { createServiceMap, evaluateServiceMap } = await import('../../../services/serviceImpact/engine.js')
const { DEFAULT_SERVICE_IMPACT_RULES_JSON, SERVICE_RELATIONSHIP_TYPES } = await import('../../../lib/serviceVocabularies.js')

const { forgetServiceMapJobs } = await import('../../../jobs/serviceImpactWorker.js')
const { noteServiceMapDeletion } = await import('../../../services/events/cascade.js')

const admin:    GraphQLContext = { tenantId: 'tenant-1', userId: 'adm-1', userEmail: 'adm@test.io', role: 'admin' }
const operator: GraphQLContext = { ...admin, userId: 'op-1', role: 'operator' }
const viewer:   GraphQLContext = { ...admin, userId: 'v-1', role: 'viewer' }
const tx = { run: vi.fn() }
// `executeRead` c'è perché la sessione vera ce l'ha: la risoluzione dei passi
// di finestra per SCOPO (ondata 4 · A4-1) riusa la sessione del chiamante
// invece di aprirne una in più per valutazione.
const session = { close: vi.fn().mockResolvedValue(undefined), executeWrite: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)), executeRead: vi.fn(async (work: (t: unknown) => Promise<unknown>) => work(tx)) }

async function expectCode(p: Promise<unknown>, code: string, pattern?: RegExp) {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe(code)
  if (pattern) expect((err as GraphQLError).message).toMatch(pattern)
}

function onCypher(rules: Array<[RegExp, unknown]>) {
  const impl = async (_s: unknown, cypher: string) => {
    for (const [re, value] of rules) if (re.test(cypher)) return typeof value === 'function' ? (value as () => unknown)() : value
    throw new Error(`unexpected cypher in test:\n${cypher}`)
  }
  vi.mocked(runQueryOne).mockImplementation(impl as never)
  vi.mocked(runQuery).mockImplementation((async (s: unknown, c: string) => { const r = await impl(s, c); return r == null ? [] : Array.isArray(r) ? r : [r] }) as never)
}
const calls = () => [...vi.mocked(runQueryOne).mock.calls, ...vi.mocked(runQuery).mock.calls].map(([, cypher, params]) => ({ cypher: cypher as string, params: params as Record<string, unknown> }))
const callMatching = (re: RegExp) => calls().find((c) => re.test(c.cypher))

const cause = { ciId: 'db-01', health: 'down', weight: 5, critical: false, ci: { id: 'db-01', name: 'DB-01', type: 'database', health: 'down' }, path: [{ id: 'db-01', name: 'DB-01', type: 'database', health: 'down' }, { id: 'app-3', name: 'APP-003', type: 'application', health: 'operational' }] }
const mapRow = (over: Record<string, unknown> = {}) => ({
  props: {
    id: 'map-1', tenant_id: 'tenant-1', service_id: 'ba-1', name: 'Enterprise Billing', status: 'active', version: 1, updated_at: 'T0', updated_by: 'u',
    built_from: 'auto', max_depth: 4, relationship_types: ['DEPENDS_ON', 'HOSTED_ON'], rules: DEFAULT_SERVICE_IMPACT_RULES_JSON,
    health: 'degraded', health_since: 'T1', impact_score: 41, explanation: JSON.stringify([cause]), stale: false, evaluated_at: 'T2', node_ids: ['app-3', 'db-01'],
    auto_sync: true, synced_at: 'T3', ...over,
  },
  service: { id: 'ba-1', name: 'Enterprise Billing', criticality: 'mission_critical', owner: { id: 'team-1', tenant_id: 'tenant-1', name: 'Finance IT', created_at: 'T' } },
  nodeCount: 2,
})
const MAP_RE = /MATCH \(m:ServiceMap \{id: \$id, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(ba:BusinessApplication/
const STATUS_RE = /SET m\.status = \$status, m\.updated_at = \$now/

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(forgetServiceMapJobs).mockResolvedValue(2)
})

// ── Mapper ───────────────────────────────────────────────────────────────────

describe('mapServiceMap / parseStoredCauses', () => {
  it('snake_case → camelCase, regole e spiegazione dal JSON (istantanee: status null), servizio con owner Team, nodeCount', () => {
    const out = mapServiceMap(mapRow())
    expect(out).toMatchObject({
      id: 'map-1', name: 'Enterprise Billing', status: 'active', version: 1, updatedAt: 'T0', maxDepth: 4, relationshipTypes: ['DEPENDS_ON', 'HOSTED_ON'], builtFrom: 'auto', stale: false,
      autoSync: true, syncedAt: 'T3',
      rules: { version: 1, downSharePct: 50, degradedSharePct: 1, minNodes: 1, unknownNodes: 'operational', openIncidentFrom: 'down' },
      health: 'degraded', healthSince: 'T1', impactScore: 41, evaluatedAt: 'T2', nodeCount: 2,
      // revisione 2: assenti = nessuna informazione (mappa a posto, nessuna finestra di change)
      healthIfActive: null, staleReason: null,
      service: { id: 'ba-1', name: 'Enterprise Billing', criticality: 'mission_critical', ownerGroup: expect.objectContaining({ id: 'team-1', name: 'Finance IT' }) },
    })
    expect(out.explanation).toEqual([{ ci: { id: 'db-01', name: 'DB-01', type: 'database', status: null, health: 'down' }, health: 'down', weight: 5, critical: false, path: [expect.objectContaining({ id: 'db-01' }), expect.objectContaining({ id: 'app-3', type: 'application', health: 'operational' })] }])
  })

  it('fail-loud: servizio sparito, relationship_types/rules/explanation assenti o corrotti, salute o stato fuori vocabolario → errore, mai un valore inventato', () => {
    expect(() => mapServiceMap({ ...mapRow(), service: null })).toThrow(/ServiceMap map-1 has no BusinessApplication/)
    expect(() => mapServiceMap(mapRow({ relationship_types: undefined }))).toThrow(/has no relationship_types — run the 20260910_1080_service_maps_bootstrap migration/)
    expect(() => mapServiceMap(mapRow({ rules: undefined }))).toThrow(/has no rules/)
    expect(() => mapServiceMap(mapRow({ explanation: undefined }))).toThrow(/explanation is not a JSON string/)
    expect(() => mapServiceMap(mapRow({ health: 'broken' }))).toThrow(/health is "broken"/)
    expect(() => mapServiceMap(mapRow({ status: 'archived' }))).toThrow(/status is "archived"/)
    // ondata 5: mappa creata prima dell'interruttore → la migrazione, mai un default a runtime
    expect(() => mapServiceMap(mapRow({ auto_sync: undefined }))).toThrow(/has no auto_sync \(got undefined\) — run the 20260910_1110_service_map_auto_sync migration/)
    // `synced_at` invece può mancare: significa «mai sincronizzata»
    expect(mapServiceMap(mapRow({ synced_at: undefined })).syncedAt).toBeNull()
    // revisione 2: i due campi nuovi possono mancare (nessuna informazione), ma un valore fuori vocabolario è un errore
    expect(mapServiceMap(mapRow({ health: 'maintenance', health_if_active: 'down' })).healthIfActive).toBe('down')
    expect(mapServiceMap(mapRow({ stale: true, stale_reason: 'over_limit' })).staleReason).toBe('over_limit')
    expect(mapServiceMap(mapRow({ stale: true, stale_reason: 'missing_ci' })).staleReason).toBe('missing_ci')
    expect(() => mapServiceMap(mapRow({ health_if_active: 'boh' }))).toThrow(/health_if_active is "boh"/)
    expect(() => mapServiceMap(mapRow({ stale_reason: 'boh' }))).toThrow(/stale_reason is "boh"/)
    expect(() => parseStoredCauses('{nope', 'x')).toThrow(/x is corrupt JSON/)
    expect(() => parseStoredCauses('{}', 'x')).toThrow(/x is not a JSON array/)
  })
})

// ── Query ────────────────────────────────────────────────────────────────────

describe('serviceMaps', () => {
  it('una query scopata per tenant: contatori su tutto il tenant, totale filtrato, pagina ordinata per gravità → impact_score DESC → nome; limit ≤ 500, offset ≥ 0', async () => {
    onCypher([[/RETURN countTotal, operational, degraded, down, maintenance, unknown, total, items/, { countTotal: 3, operational: 1, degraded: 1, down: 1, maintenance: 0, unknown: 0, total: 1, items: [mapRow()] }]])
    const out = await serviceResolvers.Query.serviceMaps(null, { filter: { health: ['degraded', 'down'], status: 'active', search: ' Bill ' }, limit: 9000, offset: -3 }, viewer)
    expect(out.total).toBe(1)
    expect(out.counts).toEqual({ total: 3, operational: 1, degraded: 1, down: 1, maintenance: 0, unknown: 0 })
    expect(out.items).toEqual([expect.objectContaining({ id: 'map-1', health: 'degraded', nodeCount: 2 })])
    const q = callMatching(/countTotal/)!
    expect(q.cypher.match(/MATCH \(m:ServiceMap \{tenant_id: \$tenantId\}\)/g)).toHaveLength(3)
    expect(q.cypher).toContain("count(CASE WHEN m.health = 'maintenance' THEN 1 END) AS maintenance")
    expect(q.cypher.match(/WHERE m\.health IN \$health AND m\.status = \$status AND toLower\(m\.name\) CONTAINS \$search/g)).toHaveLength(2)
    expect(q.cypher).toContain(`WITH m ORDER BY ${SERVICE_MAP_ORDER}`)
    expect(SERVICE_MAP_ORDER).toBe("CASE m.health WHEN 'down' THEN 0 WHEN 'degraded' THEN 1 WHEN 'maintenance' THEN 2 WHEN 'unknown' THEN 3 WHEN 'operational' THEN 4 ELSE 5 END, m.impact_score DESC, m.name")
    expect(q.cypher).toMatch(/SKIP toInteger\(\$offset\) LIMIT toInteger\(\$limit\)\s+OPTIONAL MATCH \(ba:BusinessApplication \{tenant_id: \$tenantId\}\)-\[:HAS_SERVICE_MAP\]->\(m\)/)
    expect(q.cypher).toContain("owner: head([(ba)-[:OWNED_BY]->(t:Team {tenant_id: $tenantId}) | properties(t)])")
    expect(q.cypher).toContain('COUNT { (m)-[:INCLUDES]->() } AS nodeCount')
    expect(q.params).toEqual({ tenantId: 'tenant-1', limit: 500, offset: 0, health: ['degraded', 'down'], status: 'active', search: 'bill' })
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('senza filtro nessun WHERE, default limit 50; filtri fuori vocabolario → BAD_USER_INPUT senza query; pagina vuota → items []', async () => {
    onCypher([[/countTotal/, { countTotal: 0, operational: 0, degraded: 0, down: 0, maintenance: 0, unknown: 0, total: 0, items: [] }]])
    const out = await serviceResolvers.Query.serviceMaps(null, {}, viewer)
    expect(out).toEqual({ items: [], total: 0, counts: { total: 0, operational: 0, degraded: 0, down: 0, maintenance: 0, unknown: 0 } })
    const q = callMatching(/countTotal/)!
    expect(q.cypher).not.toContain('WHERE')
    expect(q.params).toEqual({ tenantId: 'tenant-1', limit: 50, offset: 0 })
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    await expectCode(serviceResolvers.Query.serviceMaps(null, { filter: { health: ['broken'] } }, viewer), 'BAD_USER_INPUT', /Invalid health filter "broken"/)
    await expectCode(serviceResolvers.Query.serviceMaps(null, { filter: { status: 'archived' } }, viewer), 'BAD_USER_INPUT', /Invalid status filter/)
    // Ondata 7: la criticità si valida contro il VOCABOLARIO DEL CLIENTE
    // (`assertDomainValue`), non contro la copia in lib/serviceVocabularies.ts
    // — che era il seme del prodotto e rifiutava una criticità aggiunta
    // dall'admin. Il messaggio elenca gli ammessi di QUESTO cliente.
    await expectCode(serviceResolvers.Query.serviceMaps(null, { filter: { criticality: ['molto_critico'] } }, viewer), 'BAD_USER_INPUT', /service_criticality: "molto_critico" non è nel vocabolario di questo cliente/)
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  // Revisione 2 · C-7 e C-14: due filtri che prima il web simulava a valle (leggendo una
  // pagina e scartando), con il risultato che il banner dei servizi critici poteva tacere.
  it('filtra per criticità dell\'applicazione radice e per CI incluso, nella stessa query', async () => {
    onCypher([[/countTotal/, { countTotal: 3, operational: 0, degraded: 0, down: 3, maintenance: 0, unknown: 0, total: 1, items: [mapRow()] }]])
    await serviceResolvers.Query.serviceMaps(null, { filter: { health: ['down'], criticality: ['mission_critical', 'business_critical'], ciId: 'ci-7' } }, viewer)
    const q = callMatching(/countTotal/)!
    expect(q.cypher).toContain('EXISTS { MATCH (ba:BusinessApplication {tenant_id: $tenantId})-[:HAS_SERVICE_MAP]->(m) WHERE ba.criticality IN $criticality }')
    expect(q.cypher).toContain('EXISTS { MATCH (m)-[:INCLUDES]->(ci {id: $ciId, tenant_id: $tenantId}) }')
    expect(q.params).toEqual({ tenantId: 'tenant-1', limit: 50, offset: 0, health: ['down'], criticality: ['mission_critical', 'business_critical'], ciId: 'ci-7' })
  })
})

describe('serviceMap / servicesImpactedByCI / serviceMapCandidates', () => {
  it('serviceMap: per id e tenant, null se assente', async () => {
    onCypher([[MAP_RE, mapRow()]])
    expect(await serviceResolvers.Query.serviceMap(null, { id: 'map-1' }, viewer)).toMatchObject({ id: 'map-1' })
    expect(callMatching(MAP_RE)!.params).toEqual({ id: 'map-1', tenantId: 'tenant-1' })
    onCypher([[MAP_RE, null]])
    expect(await serviceResolvers.Query.serviceMap(null, { id: 'map-x' }, viewer)).toBeNull()
  })

  it('servicesImpactedByCI: mappe che includono il CI (scopate), per gravità', async () => {
    onCypher([[/INCLUDES\]->\(ci \{id: \$ciId, tenant_id: \$tenantId\}\)/, [mapRow(), mapRow({ id: 'map-2', health: 'operational', impact_score: 0 })]]])
    const out = await serviceResolvers.Query.servicesImpactedByCI(null, { ciId: 'db-01' }, operator)
    expect(out.map((m) => m.id)).toEqual(['map-1', 'map-2'])
    const q = callMatching(/INCLUDES\]->\(ci/)!
    expect(q.cypher).toMatch(/MATCH \(m:ServiceMap \{tenant_id: \$tenantId\}\)-\[:INCLUDES\]->\(ci \{id: \$ciId, tenant_id: \$tenantId\}\)\s+WITH m ORDER BY CASE m\.health/)
    expect(q.params).toEqual({ ciId: 'db-01', tenantId: 'tenant-1' })
  })

  it('serviceMapCandidates: admin; BusinessApplication senza mappa, ricerca minuscola, limit ≤ 100; operator → FORBIDDEN senza query', async () => {
    onCypher([[/NOT EXISTS \{ \(ba\)-\[:HAS_SERVICE_MAP\]->\(:ServiceMap \{tenant_id: \$tenantId\}\) \}/, [{ id: 'ba-2', name: 'CRM', criticality: 'business_critical', owner: null }]]])
    const out = await serviceResolvers.Query.serviceMapCandidates(null, { search: ' CR ', limit: 500 }, admin)
    expect(out).toEqual([{ id: 'ba-2', name: 'CRM', criticality: 'business_critical', ownerGroup: null }])
    const q = callMatching(/HAS_SERVICE_MAP/)!
    expect(q.cypher).toContain('MATCH (ba:BusinessApplication {tenant_id: $tenantId})')
    expect(q.cypher).toContain('($search IS NULL OR toLower(ba.name) CONTAINS $search)')
    expect(q.params).toEqual({ tenantId: 'tenant-1', search: 'cr', limit: 100 })
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    await expectCode(serviceResolvers.Query.serviceMapCandidates(null, {}, operator), 'FORBIDDEN')
    expect(runQuery).not.toHaveBeenCalled()
  })
})

// ── Field resolver ───────────────────────────────────────────────────────────

describe('ServiceMap field resolver', () => {
  const stateRow = {
    props: { id: 'map-1', version: 1, rules: DEFAULT_SERVICE_IMPACT_RULES_JSON, node_ids: ['app-3', 'db-01', 'cert-1'] },
    nodes: [
      { ciId: 'db-01', name: 'DB-01', labels: ['Database'], level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'app-3', addedBy: 'auto', health: 'down', healthSource: 'monitoring', status: 'active', changes: [] },
      { ciId: 'app-3', name: 'APP-003', labels: ['Application'], level: 1, role: 'entry', propagate: 'weighted', weight: 8, critical: true, via: null, addedBy: 'auto', health: 'operational', healthSource: 'monitoring', status: 'active', changes: [{ changeId: 'chg-1', code: 'CHG-1', step: 'deployment', plans: [], viaCiId: 'app-3', viaCiName: 'APP-003', upstream: false }] },
      { ciId: 'cert-1', name: 'CERT-01', labels: ['Certificate'], level: 2, role: 'certificate', propagate: 'never', weight: 3, critical: false, via: 'app-3', addedBy: 'auto', health: null, healthSource: null, status: 'active', changes: [] },
    ],
  }

  it('nodes: stessa lettura del motore (finestra di change inclusa), per livello poi nome, con ci ref, inMaintenance, contributes ed excludedReason', async () => {
    onCypher([[/OPTIONAL MATCH \(m\)-\[inc:INCLUDES\]->/, stateRow]])
    const out = await serviceResolvers.ServiceMap.nodes({ id: 'map-1' }, null, viewer)
    expect(out).toEqual([
      // `inMaintenance` = finestra di change (R1): il ciclo di vita si legge da ci.status / excludedReason
      { ci: { id: 'app-3', name: 'APP-003', type: 'application', status: 'active', health: 'operational' }, level: 1, role: 'entry', propagate: 'weighted', weight: 8, critical: true, via: null, addedBy: 'auto', health: 'operational', inMaintenance: true, contributes: false, excludedReason: 'change_window' },
      { ci: { id: 'cert-1', name: 'CERT-01', type: 'certificate', status: 'active', health: null }, level: 2, role: 'certificate', propagate: 'never', weight: 3, critical: false, via: 'app-3', addedBy: 'auto', health: null, inMaintenance: false, contributes: false, excludedReason: 'never' },
      { ci: { id: 'db-01', name: 'DB-01', type: 'database', status: 'active', health: 'down' }, level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'app-3', addedBy: 'auto', health: 'down', inMaintenance: false, contributes: true, excludedReason: null },
    ])
    expect(callMatching(/inc:INCLUDES/)!.params).toEqual({ mapId: 'map-1', tenantId: 'tenant-1', windowSteps: ['deployment', 'scheduled'], implementationSteps: ['deployment'] })
    onCypher([[/inc:INCLUDES/, null]])
    await expectCode(serviceResolvers.ServiceMap.nodes({ id: 'map-x' }, null, viewer), 'NOT_FOUND')
  })

  it('edges: archi fra i soli componenti inclusi, scopati, distinti e ordinati', async () => {
    onCypher([[/EXISTS \{ \(m\)-\[:INCLUDES\]->\(b\) \}/, [{ source: 'app-3', target: 'db-01', relType: 'DEPENDS_ON' }]]])
    expect(await serviceResolvers.ServiceMap.edges({ id: 'map-1' }, null, viewer)).toEqual([{ source: 'app-3', target: 'db-01', relType: 'DEPENDS_ON' }])
    const q = callMatching(/INCLUDES\]->\(b\)/)!
    expect(q.cypher).toMatch(/MATCH \(m:ServiceMap \{id: \$id, tenant_id: \$tenantId\}\)-\[:INCLUDES\]->\(a \{tenant_id: \$tenantId\}\)\s+MATCH \(a\)-\[r\]->\(b \{tenant_id: \$tenantId\}\)/)
    expect(q.cypher).toMatch(/RETURN DISTINCT a\.id AS source, b\.id AS target, type\(r\) AS relType\s+ORDER BY source, target, relType\s+LIMIT 5000/)
    expect(q.params).toEqual({ id: 'map-1', tenantId: 'tenant-1' })
  })

  it('history: ultime limit voci (1..500, default 100) dalla più recente sull\'indice (tenant_id, map_id, at), cause dal JSON; historyCount', async () => {
    const entry = { id: 'h1', at: 'T1', health: 'degraded', previous_health: null, impact_score: 41, trigger: 'created', cause: JSON.stringify([cause]), note: null }
    onCypher([[/MATCH \(h:ServiceHealthEntry \{tenant_id: \$tenantId, map_id: \$id\}\)\s+WITH h ORDER BY h\.at DESC, h\.id DESC LIMIT toInteger\(\$limit\)/, [{ props: entry }]], [/RETURN count\(h\) AS n/, { n: 7 }]])
    const out = await serviceResolvers.ServiceMap.history({ id: 'map-1' }, { limit: 9000 }, viewer)
    expect(out).toEqual([{ id: 'h1', at: 'T1', health: 'degraded', previousHealth: null, impactScore: 41, trigger: 'created', causes: [expect.objectContaining({ ci: expect.objectContaining({ id: 'db-01' }) })], note: null }])
    expect(callMatching(/LIMIT toInteger\(\$limit\)/)!.params).toEqual({ id: 'map-1', tenantId: 'tenant-1', limit: 500 })
    await serviceResolvers.ServiceMap.history({ id: 'map-1' }, null, viewer)
    expect(calls().at(-1)!.params).toMatchObject({ limit: 100 })
    expect(await serviceResolvers.ServiceMap.historyCount({ id: 'map-1' }, null, viewer)).toBe(7)
    expect(callMatching(/count\(h\)/)!.params).toEqual({ id: 'map-1', tenantId: 'tenant-1' })
    // voce con trigger fuori vocabolario → errore
    onCypher([[/LIMIT toInteger\(\$limit\)/, [{ props: { ...entry, trigger: 'oops' } }]]])
    await expect(serviceResolvers.ServiceMap.history({ id: 'map-1' }, null, viewer)).rejects.toThrow(/ServiceHealthEntry h1 trigger is "oops"/)
  })
})

// ── Ondata 3: incident del servizio e capacità di business ───────────────────

describe('ServiceMap.openIncident / Incident.impactedServices / businessCapabilitiesHealth', () => {
  const OPEN_RE = /MATCH \(i:Incident \{tenant_id: \$tenantId\}\)-\[:IMPACTS_SERVICE\]->\(m:ServiceMap \{id: \$id, tenant_id: \$tenantId\}\)/
  const IMPACTED_RE = /MATCH \(i:Incident \{id: \$id, tenant_id: \$tenantId\}\)-\[:IMPACTS_SERVICE\]->\(m:ServiceMap \{tenant_id: \$tenantId\}\)/
  const CAPS_RE = /MATCH \(c:BusinessCapability \{tenant_id: \$tenantId\}\)/

  it('openIncident: l\'incident non chiuso collegato (resolved incluso: si riapre, non si affianca); null se non c\'è', async () => {
    const props = { id: 'inc-1', tenant_id: 'tenant-1', number: 'INC00000042', title: 'Servizio Enterprise Billing: non disponibile', severity: 'critical', status: 'in_progress', created_at: 'T1', updated_at: 'T2' }
    onCypher([[OPEN_RE, { props }]])
    const out = await serviceResolvers.ServiceMap.openIncident({ id: 'map-1' }, null, viewer)
    expect(out).toMatchObject({ id: 'inc-1', number: 'INC00000042', severity: 'critical', priority: 'critical', status: 'in_progress' })
    const q = callMatching(OPEN_RE)!
    expect(q.cypher).toContain('WHERE NOT wi.current_step IN $terminalSteps OR wi.current_step = $resolvedStep')
    expect(q.cypher).toContain('ORDER BY createdAt DESC LIMIT 1')
    expect(q.params).toEqual({ id: 'map-1', tenantId: 'tenant-1', terminalSteps: ['resolved', 'closed'], resolvedStep: 'resolved' })
    onCypher([[OPEN_RE, null]])
    expect(await serviceResolvers.ServiceMap.openIncident({ id: 'map-1' }, null, viewer)).toBeNull()
  })

  it('Incident.impactedServices: le mappe collegate all\'incident, per gravità, con la stessa riga della lista', async () => {
    onCypher([[IMPACTED_RE, [mapRow()]]])
    const out = await serviceResolvers.Incident.impactedServices({ id: 'inc-1' }, null, viewer)
    expect(out).toEqual([expect.objectContaining({ id: 'map-1', health: 'degraded', impactScore: 41 })])
    const q = callMatching(IMPACTED_RE)!
    expect(q.cypher).toContain(`WITH m ORDER BY ${SERVICE_MAP_ORDER}`)
    expect(q.params).toEqual({ id: 'inc-1', tenantId: 'tenant-1' })
  })

  it('businessCapabilitiesHealth: UNA query su ENABLED_BY → HAS_SERVICE_MAP; salute peggiore fra i servizi noti, conteggi giù/degradati, ordine per gravità', async () => {
    onCypher([[CAPS_RE, [
      { id: 'cap-1', name: 'Customer Relationship', services: [
        { id: 'ba-1', name: 'CRM', criticality: 'business_critical', health: 'degraded', owner: { id: 'team-1', tenant_id: 'tenant-1', name: 'CRM Team', created_at: 'T' } },
        { id: 'ba-2', name: 'Portale', criticality: null, health: 'down', owner: null },
      ] },
      { id: 'cap-2', name: 'Billing & Invoicing', services: [{ id: 'ba-3', name: 'Billing', criticality: 'mission_critical', health: 'operational', owner: null }] },
      { id: 'cap-3', name: 'Workforce', services: [] },
      { id: 'cap-4', name: 'Reporting', services: [{ id: 'ba-4', name: 'BI', criticality: null, health: 'unknown', owner: null }] },
    ]]])
    const out = await serviceResolvers.Query.businessCapabilitiesHealth(null, {}, viewer)
    expect(out.map((c) => [c.id, c.health, c.downServices, c.degradedServices])).toEqual([
      // ordine di gravità della pagina Servizi (down, degraded, maintenance, unknown, operational), poi nome
      ['cap-1', 'down', 1, 1],          // la peggiore fra i servizi collegati
      ['cap-4', 'unknown', 0, 0],       // nessuna salute nota → unknown
      ['cap-3', 'unknown', 0, 0],       // nessun servizio collegato → unknown
      ['cap-2', 'operational', 0, 0],
    ])
    // i servizi della capacità sono ServiceRef (id della BusinessApplication) ordinati per gravità
    expect(out[0]!.services).toEqual([
      { id: 'ba-2', name: 'Portale', criticality: null, ownerGroup: null },
      { id: 'ba-1', name: 'CRM', criticality: 'business_critical', ownerGroup: expect.objectContaining({ id: 'team-1', name: 'CRM Team' }) },
    ])
    const q = callMatching(CAPS_RE)!
    expect(q.cypher).toContain('OPTIONAL MATCH (c)-[:ENABLED_BY]->(ba:BusinessApplication {tenant_id: $tenantId})-[:HAS_SERVICE_MAP]->(m:ServiceMap {tenant_id: $tenantId})')
    expect(q.cypher).toContain('RETURN c.id AS id, c.name AS name, [s IN services WHERE s IS NOT NULL] AS services')
    expect(q.params).toEqual({ tenantId: 'tenant-1' })
    expect(calls()).toHaveLength(1)
  })

  it('businessCapabilitiesHealth: una salute fuori vocabolario è un errore, mai una capacità "sana" per sbaglio', async () => {
    onCypher([[CAPS_RE, [{ id: 'cap-1', name: 'X', services: [{ id: 'ba-1', name: 'CRM', criticality: null, health: 'boh', owner: null }] }]]])
    await expect(serviceResolvers.Query.businessCapabilitiesHealth(null, {}, viewer)).rejects.toThrow(/BusinessCapability cap-1 service ba-1 health is "boh"/)
  })
})

// ── Ondata 2: diff, anteprima, esclusioni ────────────────────────────────────

describe('serviceMapProposal / serviceImpactPreview / ServiceMap.excluded', () => {
  const loaded = (over: Record<string, unknown> = {}) => ({
    ciId: 'old-99', name: 'OLD-99', labels: ['Server'], level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false,
    via: 'app-3', addedBy: 'auto', health: null, healthSource: null, status: 'active', inMaintenance: false, ...over,
  })

  it('serviceMapProposal: admin; aggiunti, spariti (CI cancellato con i sentinella dichiarati), spostati, esclusi; operator → FORBIDDEN', async () => {
    vi.mocked(config.serviceMapProposal).mockResolvedValueOnce({
      mapId: 'map-1', version: 2, status: 'active', updatedAt: 'T0', maxDepth: 4, relationshipTypes: ['DEPENDS_ON'],
      added: [{ ciId: 'srv-9', name: 'SRV-09', labels: ['Server'], status: 'active', health: null, level: 2, via: 'app-3', role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false }],
      removed: [{ ciId: 'old-99', node: loaded() }, { ciId: 'gone-1', node: null }],
      moved: [{ node: loaded({ ciId: 'db-01', name: 'DB-01', labels: ['Database'], health: 'down' }), proposedLevel: 3, proposedVia: 'srv-9' }],
      excluded: [{ id: 'cert-x', name: 'CERT-X', labels: ['Certificate'], status: 'active', health: null }],
      totalProposed: 3, proposed: [], currentIds: [], missing: ['gone-1'],
      rules: { version: 1, down_share_pct: 50, degraded_share_pct: 1, min_nodes: 1, unknown_nodes: 'operational', open_incident_from: 'down' },
      nodeCount: 3,
    })
    const out = await serviceResolvers.Query.serviceMapProposal(null, { id: 'map-1' }, admin)
    expect(config.serviceMapProposal).toHaveBeenCalledWith('tenant-1', 'map-1')
    expect(out).toMatchObject({ mapId: 'map-1', version: 2, maxDepth: 4, relationshipTypes: ['DEPENDS_ON'], totalProposed: 3 })
    expect(out.added).toEqual([{ ci: { id: 'srv-9', name: 'SRV-09', type: 'server', status: 'active', health: null }, level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'app-3' }])
    expect(out.moved).toEqual([{ ci: { id: 'db-01', name: 'DB-01', type: 'database', status: 'active', health: 'down' }, level: 2, proposedLevel: 3, via: 'app-3', proposedVia: 'srv-9' }])
    expect(out.excluded).toEqual([{ id: 'cert-x', name: 'CERT-X', type: 'certificate', status: 'active', health: null }])
    expect(out.removed[0]).toMatchObject({ ci: { id: 'old-99', type: 'server' }, level: 2, addedBy: 'auto', contributes: true })
    // CI sparito: della mappa resta solo l'id, i campi mancanti sono sentinella dichiarati
    expect(out.removed[1]).toEqual({ ci: { id: 'gone-1', name: 'gone-1', type: 'unknown', status: null, health: null }, level: 0, role: 'component', propagate: 'never', weight: 1, critical: false, via: null, addedBy: SERVICE_NODE_GONE_ADDED_BY, health: null, inMaintenance: false, contributes: false, excludedReason: 'never' })
    await expectCode(serviceResolvers.Query.serviceMapProposal(null, { id: 'map-1' }, operator), 'FORBIDDEN')
  })

  it('serviceImpactPreview: admin; regole e nodi passati al servizio, cause mappate; viewer → FORBIDDEN senza chiamare il servizio', async () => {
    vi.mocked(config.previewServiceImpact).mockResolvedValueOnce({ health: 'down', impactScore: 62, causes: [cause as never], contributingCount: 2, nodeCount: 3 })
    const rules = { downSharePct: 40, degradedSharePct: 5, minNodes: 1, unknownNodes: 'ignore' as const, openIncidentFrom: 'down' as const }
    const nodes = [{ ciId: 'db-01', propagate: 'never' as const, weight: 5, critical: false }]
    const out = await serviceResolvers.Query.serviceImpactPreview(null, { id: 'map-1', rules, nodes }, admin)
    expect(config.previewServiceImpact).toHaveBeenCalledWith({ tenantId: 'tenant-1', mapId: 'map-1', rules, nodes })
    expect(out).toMatchObject({ health: 'down', impactScore: 62, contributingCount: 2, nodeCount: 3 })
    expect(out.causes).toEqual([{ ci: { id: 'db-01', name: 'DB-01', type: 'database', status: null, health: 'down' }, health: 'down', weight: 5, critical: false, path: [expect.objectContaining({ id: 'db-01' }), expect.objectContaining({ id: 'app-3' })] }])
    // argomenti assenti → null espliciti (il servizio usa le regole della mappa)
    vi.mocked(config.previewServiceImpact).mockResolvedValueOnce({ health: 'operational', impactScore: 0, causes: [], contributingCount: 0, nodeCount: 0 })
    await serviceResolvers.Query.serviceImpactPreview(null, { id: 'map-1' }, admin)
    expect(config.previewServiceImpact).toHaveBeenLastCalledWith({ tenantId: 'tenant-1', mapId: 'map-1', rules: null, nodes: null })
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    await expectCode(serviceResolvers.Query.serviceImpactPreview(null, { id: 'map-1' }, viewer), 'FORBIDDEN')
    expect(config.previewServiceImpact).not.toHaveBeenCalled()
  })

  it('ServiceMap.excluded: EXCLUDES del tenant come ConfigurationItemRef', async () => {
    onCypher([[/\[:EXCLUDES\]->\(ci \{tenant_id: \$tenantId\}\)/, [{ id: 'cert-x', name: 'CERT-X', labels: ['Certificate'], status: 'active', health: null }]]])
    expect(await serviceResolvers.ServiceMap.excluded({ id: 'map-1' }, null, viewer)).toEqual([{ id: 'cert-x', name: 'CERT-X', type: 'certificate', status: 'active', health: null }])
    expect(callMatching(/EXCLUDES/)!.params).toEqual({ mapId: 'map-1', tenantId: 'tenant-1' })
  })
})

// ── Mutation ─────────────────────────────────────────────────────────────────

describe('createServiceMap', () => {
  it('admin: default del contratto (maxDepth 4, tutte le relazioni), motore chiamato con l\'utente, audit, restituisce la mappa riletta', async () => {
    vi.mocked(createServiceMap).mockResolvedValueOnce({ mapId: 'map-1', proposal: { serviceName: 'Enterprise Billing', maxDepth: 4, relationshipTypes: [...SERVICE_RELATIONSHIP_TYPES], nodes: [{}, {}] }, evaluation: { health: 'degraded', impactScore: 41 } } as never)
    onCypher([[MAP_RE, mapRow()]])
    const out = await serviceResolvers.Mutation.createServiceMap(null, { serviceId: 'ba-1' }, admin)
    expect(out).toMatchObject({ id: 'map-1', health: 'degraded' })
    // ondata 5: mappa VIVA per default (autoSync true), si passa false solo per congelarla subito
    expect(createServiceMap).toHaveBeenCalledWith({ tenantId: 'tenant-1', serviceId: 'ba-1', maxDepth: 4, relationshipTypes: [...SERVICE_RELATIONSHIP_TYPES], status: 'active', autoSync: true, actorId: 'adm-1' })
    expect(audit).toHaveBeenCalledWith(admin, 'service_map.created', 'ServiceMap', 'map-1', expect.objectContaining({ serviceId: 'ba-1', serviceName: 'Enterprise Billing', status: 'active', autoSync: true, nodes: 2, health: 'degraded', impactScore: 41 }))
  })

  it('autoSync: false esplicito passato al motore (mappa congelata alla nascita)', async () => {
    vi.mocked(createServiceMap).mockResolvedValueOnce({ mapId: 'map-1', proposal: { serviceName: 'CRM', maxDepth: 4, relationshipTypes: [...SERVICE_RELATIONSHIP_TYPES], nodes: [] }, evaluation: { health: 'unknown', impactScore: 0 } } as never)
    onCypher([[MAP_RE, mapRow({ auto_sync: false })]])
    const out = await serviceResolvers.Mutation.createServiceMap(null, { serviceId: 'ba-1', autoSync: false }, admin)
    expect(out.autoSync).toBe(false)
    expect(createServiceMap).toHaveBeenCalledWith(expect.objectContaining({ autoSync: false }))
  })

  it('status: bozza esplicita passata al motore; fuori enum → BAD_USER_INPUT senza chiamare il motore', async () => {
    vi.mocked(createServiceMap).mockResolvedValueOnce({ mapId: 'map-1', proposal: { serviceName: 'CRM', maxDepth: 4, relationshipTypes: [...SERVICE_RELATIONSHIP_TYPES], nodes: [] }, evaluation: { health: 'unknown', impactScore: 0 } } as never)
    onCypher([[MAP_RE, mapRow({ status: 'draft' })]])
    await serviceResolvers.Mutation.createServiceMap(null, { serviceId: 'ba-1', status: 'draft' }, admin)
    expect(createServiceMap).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }))
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    await expectCode(serviceResolvers.Mutation.createServiceMap(null, { serviceId: 'ba-1', status: 'archived' }, admin), 'BAD_USER_INPUT', /status must be one of: draft, active, paused/)
    expect(createServiceMap).not.toHaveBeenCalled()
  })

  it('argomenti espliciti passati al motore; errori del motore propagano (NOT_FOUND / BAD_USER_INPUT); operator → FORBIDDEN senza chiamare il motore', async () => {
    const { ValidationError } = await import('../../../lib/errors.js')
    vi.mocked(createServiceMap).mockRejectedValueOnce(new ValidationError('already has a service map'))
    await expectCode(serviceResolvers.Mutation.createServiceMap(null, { serviceId: 'ba-1', maxDepth: 2, relationshipTypes: ['DEPENDS_ON'] }, admin), 'BAD_USER_INPUT', /already has a service map/)
    expect(createServiceMap).toHaveBeenCalledWith(expect.objectContaining({ maxDepth: 2, relationshipTypes: ['DEPENDS_ON'] }))
    vi.clearAllMocks()
    await expectCode(serviceResolvers.Mutation.createServiceMap(null, { serviceId: 'ba-1' }, operator), 'FORBIDDEN')
    expect(createServiceMap).not.toHaveBeenCalled()
  })
})

describe('reevaluateServiceMap / setServiceMapStatus / deleteServiceMap', () => {
  it('reevaluateServiceMap: trigger manual con l\'utente, audit, mappa riletta; inesistente → NOT_FOUND dal motore', async () => {
    vi.mocked(evaluateServiceMap).mockResolvedValueOnce({ mapId: 'map-1', health: 'down', previousHealth: 'degraded', impactScore: 100, changed: true, stale: false, causes: [] })
    onCypher([[MAP_RE, mapRow({ health: 'down' })]])
    const out = await serviceResolvers.Mutation.reevaluateServiceMap(null, { id: 'map-1' }, admin)
    expect(out.health).toBe('down')
    expect(evaluateServiceMap).toHaveBeenCalledWith({ tenantId: 'tenant-1', mapId: 'map-1', trigger: 'manual', actorId: 'adm-1' })
    expect(audit).toHaveBeenCalledWith(admin, 'service_map.reevaluated', 'ServiceMap', 'map-1', { previousHealth: 'degraded', health: 'down', impactScore: 100, changed: true, stale: false })
    const { NotFoundError } = await import('../../../lib/errors.js')
    vi.mocked(evaluateServiceMap).mockRejectedValueOnce(new NotFoundError('ServiceMap', 'map-x'))
    await expectCode(serviceResolvers.Mutation.reevaluateServiceMap(null, { id: 'map-x' }, admin), 'NOT_FOUND')
    await expectCode(serviceResolvers.Mutation.reevaluateServiceMap(null, { id: 'map-1' }, viewer), 'FORBIDDEN')
  })

  it('setServiceMapStatus: guardia che prende il lock e poi confronta (X1), audit; paused → active e draft → active rivalutano subito; versione diversa → BAD_USER_INPUT; inesistente → NOT_FOUND; status fuori enum → BAD_USER_INPUT', async () => {
    onCypher([[STATUS_RE, { previous: 'paused', version: 2 }], [MAP_RE, mapRow({ status: 'active', version: 2 })]])
    vi.mocked(evaluateServiceMap).mockResolvedValueOnce({ mapId: 'map-1', health: 'degraded', previousHealth: 'degraded', impactScore: 41, changed: false, stale: false, causes: [] })
    const out = await serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-1', expectedVersion: 1, status: 'active' }, admin)
    expect(out).toMatchObject({ status: 'active', version: 2 })
    const q = callMatching(STATUS_RE)!
    expect(q.cypher).toBe(SET_STATUS_CYPHER)
    // X1: il SET prende il lock, il WHERE legge il valore vero; la transazione esplicita annulla l'incremento se il confronto fallisce
    expect(q.cypher).toMatch(/MATCH \(m:ServiceMap \{id: \$id, tenant_id: \$tenantId\}\)\s+SET m\.version = m\.version \+ 1\s+WITH m, m\.status AS previous, m\.version AS version\s+WHERE version = toInteger\(\$expectedVersion\) \+ 1/)
    expect(session.executeWrite).toHaveBeenCalledTimes(1)
    expect(q.params).toMatchObject({ id: 'map-1', tenantId: 'tenant-1', expectedVersion: 1, status: 'active', userId: 'adm-1' })
    expect(evaluateServiceMap).toHaveBeenCalledWith({ tenantId: 'tenant-1', mapId: 'map-1', trigger: 'manual', actorId: 'adm-1' })
    expect(audit).toHaveBeenCalledWith(admin, 'service_map.status_changed', 'ServiceMap', 'map-1', { previousStatus: 'paused', status: 'active', version: 2 })

    // active → paused: nessuna valutazione
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[STATUS_RE, { previous: 'active', version: 3 }], [MAP_RE, mapRow({ status: 'paused', version: 3 })]])
    await serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-1', expectedVersion: 2, status: 'paused' }, admin)
    expect(evaluateServiceMap).not.toHaveBeenCalled()

    // draft → active: rivaluta subito come paused → active (revisione 2)
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[STATUS_RE, { previous: 'draft', version: 4 }], [MAP_RE, mapRow({ status: 'active', version: 4 })]])
    vi.mocked(evaluateServiceMap).mockResolvedValueOnce({ mapId: 'map-1', health: 'degraded', previousHealth: null, impactScore: 41, changed: true, stale: false, healthIfActive: null, causes: [], incident: null })
    await serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-1', expectedVersion: 3, status: 'active' }, admin)
    expect(evaluateServiceMap).toHaveBeenCalledWith({ tenantId: 'tenant-1', mapId: 'map-1', trigger: 'manual', actorId: 'adm-1' })

    // conflitto di versione
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[STATUS_RE, null], [MAP_RE, mapRow({ version: 5, updated_at: 'T9' })]])
    await expectCode(serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-1', expectedVersion: 2, status: 'paused' }, admin), 'BAD_USER_INPUT', /modified by someone else \(expected version 2, current is 5, updated at T9\)/)
    expect(audit).not.toHaveBeenCalled()
    onCypher([[STATUS_RE, null], [MAP_RE, null]])
    await expectCode(serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-x', expectedVersion: 1, status: 'paused' }, admin), 'NOT_FOUND')
    await expectCode(serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-1', expectedVersion: 1, status: 'archived' }, admin), 'BAD_USER_INPUT', /status must be one of: draft, active, paused/)
    await expectCode(serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-1', expectedVersion: 0, status: 'paused' }, admin), 'BAD_USER_INPUT', /expectedVersion/)
    await expectCode(serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-1', expectedVersion: 1, status: 'paused' }, operator), 'FORBIDDEN')
  })

  it('configurazione (ondata 2): ogni mutation chiama il servizio con l\'utente, scrive l\'audit con versione, nota ed esito della rivalutazione, e rilegge la mappa; operator → FORBIDDEN senza toccare il servizio', async () => {
    const written = { mapId: 'map-1', version: 3, status: 'active' as const, note: 'nota', evaluation: { mapId: 'map-1', health: 'down' as const, previousHealth: 'degraded' as const, impactScore: 100, changed: true, stale: false, causes: [] } }
    const expectedAudit = { version: 3, status: 'active', note: 'nota', reevaluated: true, health: 'down', impactScore: 100 }
    const rules = { downSharePct: 70, degradedSharePct: 10, minNodes: 1, unknownNodes: 'ignore' as const, openIncidentFrom: 'never' as const }
    const nodes = [{ ciId: 'db-01', propagate: 'never' as const, weight: 5, critical: true }]

    onCypher([[MAP_RE, mapRow({ version: 3 })]])
    vi.mocked(config.updateServiceImpactRules).mockResolvedValue(written)
    vi.mocked(config.updateServiceMapNodes).mockResolvedValue(written)
    vi.mocked(config.applyServiceMapProposal).mockResolvedValue(written)
    vi.mocked(config.removeServiceMapExclusion).mockResolvedValue(written)

    expect(await serviceResolvers.Mutation.updateServiceImpactRules(null, { id: 'map-1', expectedVersion: 2, rules }, admin)).toMatchObject({ id: 'map-1', version: 3 })
    expect(config.updateServiceImpactRules).toHaveBeenCalledWith({ tenantId: 'tenant-1', mapId: 'map-1', expectedVersion: 2, rules, actorId: 'adm-1' })
    expect(audit).toHaveBeenCalledWith(admin, 'service_map.rules_changed', 'ServiceMap', 'map-1', { ...expectedAudit, rules })

    await serviceResolvers.Mutation.updateServiceMapNodes(null, { id: 'map-1', expectedVersion: 2, nodes }, admin)
    expect(config.updateServiceMapNodes).toHaveBeenCalledWith({ tenantId: 'tenant-1', mapId: 'map-1', expectedVersion: 2, nodes, actorId: 'adm-1' })
    expect(audit).toHaveBeenCalledWith(admin, 'service_map.nodes_changed', 'ServiceMap', 'map-1', { ...expectedAudit, nodes: ['db-01'] })

    await serviceResolvers.Mutation.applyServiceMapProposal(null, { id: 'map-1', expectedVersion: 2, add: ['srv-9'], exclude: ['cert-x'], remove: [] }, admin)
    expect(config.applyServiceMapProposal).toHaveBeenCalledWith({ tenantId: 'tenant-1', mapId: 'map-1', expectedVersion: 2, add: ['srv-9'], exclude: ['cert-x'], remove: [], actorId: 'adm-1' })
    expect(audit).toHaveBeenCalledWith(admin, 'service_map.proposal_applied', 'ServiceMap', 'map-1', { ...expectedAudit, add: ['srv-9'], exclude: ['cert-x'], remove: [] })

    await serviceResolvers.Mutation.removeServiceMapExclusion(null, { id: 'map-1', expectedVersion: 2, ciId: 'cert-x' }, admin)
    expect(config.removeServiceMapExclusion).toHaveBeenCalledWith({ tenantId: 'tenant-1', mapId: 'map-1', expectedVersion: 2, ciId: 'cert-x', actorId: 'adm-1' })
    expect(audit).toHaveBeenCalledWith(admin, 'service_map.exclusion_removed', 'ServiceMap', 'map-1', { ...expectedAudit, ciId: 'cert-x' })

    // mappa in pausa: l'audit dice che non è stata rivalutata
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[MAP_RE, mapRow({ version: 3, status: 'paused' })]])
    vi.mocked(config.updateServiceImpactRules).mockResolvedValueOnce({ ...written, status: 'paused', evaluation: null })
    await serviceResolvers.Mutation.updateServiceImpactRules(null, { id: 'map-1', expectedVersion: 2, rules }, admin)
    expect(audit).toHaveBeenCalledWith(admin, 'service_map.rules_changed', 'ServiceMap', 'map-1', expect.objectContaining({ status: 'paused', reevaluated: false, health: null, impactScore: null }))

    // conflitto di versione: l'errore del servizio propaga così com'è
    const { ValidationError: VErr } = await import('../../../lib/errors.js')
    vi.mocked(config.updateServiceMapNodes).mockRejectedValueOnce(new VErr('ServiceMap map-1 was modified by someone else (expected version 2, current is 5, updated at T9): reload and retry'))
    await expectCode(serviceResolvers.Mutation.updateServiceMapNodes(null, { id: 'map-1', expectedVersion: 2, nodes }, admin), 'BAD_USER_INPUT', /modified by someone else \(expected version 2, current is 5/)

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    await expectCode(serviceResolvers.Mutation.updateServiceImpactRules(null, { id: 'map-1', expectedVersion: 2, rules }, operator), 'FORBIDDEN')
    await expectCode(serviceResolvers.Mutation.updateServiceMapNodes(null, { id: 'map-1', expectedVersion: 2, nodes }, operator), 'FORBIDDEN')
    await expectCode(serviceResolvers.Mutation.applyServiceMapProposal(null, { id: 'map-1', expectedVersion: 2, add: [], exclude: [], remove: ['x'] }, viewer), 'FORBIDDEN')
    await expectCode(serviceResolvers.Mutation.removeServiceMapExclusion(null, { id: 'map-1', expectedVersion: 2, ciId: 'x' }, viewer), 'FORBIDDEN')
    expect(config.updateServiceImpactRules).not.toHaveBeenCalled()
    expect(config.updateServiceMapNodes).not.toHaveBeenCalled()
    expect(config.applyServiceMapProposal).not.toHaveBeenCalled()
    expect(config.removeServiceMapExclusion).not.toHaveBeenCalled()
  })

  it('mappa viva (ondata 5): setServiceMapAutoSync e syncServiceMap chiamano il servizio con l\'utente, scrivono l\'audit e rileggono la mappa; operator → FORBIDDEN', async () => {
    onCypher([[MAP_RE, mapRow({ version: 4, auto_sync: false })]])
    vi.mocked(config.setServiceMapAutoSync).mockResolvedValue({ mapId: 'map-1', version: 4, status: 'active', note: 'Aggiornamento automatico disattivato', evaluation: null })
    const frozen = await serviceResolvers.Mutation.setServiceMapAutoSync(null, { id: 'map-1', expectedVersion: 3, autoSync: false }, admin)
    expect(frozen).toMatchObject({ id: 'map-1', autoSync: false, version: 4 })
    expect(config.setServiceMapAutoSync).toHaveBeenCalledWith({ tenantId: 'tenant-1', mapId: 'map-1', expectedVersion: 3, autoSync: false, actorId: 'adm-1' })
    // cambiare modalità non rivaluta la mappa: `reevaluated: false` nell'audit
    expect(audit).toHaveBeenCalledWith(admin, 'service_map.auto_sync_changed', 'ServiceMap', 'map-1', {
      version: 4, status: 'active', note: 'Aggiornamento automatico disattivato', reevaluated: false, health: null, impactScore: null, autoSync: false,
    })

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[MAP_RE, mapRow({ version: 5 })]])
    vi.mocked(sync.syncServiceMap).mockResolvedValue({
      mapId: 'map-1', version: 5, status: 'active', added: 1, removed: 0, moved: 2, changed: true,
      skipped: null, reason: null, syncedAt: 'T9', note: 'Sincronizzazione richiesta da adm-1: +1, −0, ~2 spostati', evaluation: null,
    })
    // revisione 2: la mutation torna ServiceMapSyncResult (conteggi e rifiuto del tetto), non più la sola mappa
    expect(await serviceResolvers.Mutation.syncServiceMap(null, { id: 'map-1' }, admin)).toMatchObject({
      map: expect.objectContaining({ id: 'map-1', version: 5 }), added: 1, removed: 0, moved: 2, skipped: false, reason: null,
    })
    expect(sync.syncServiceMap).toHaveBeenCalledWith('tenant-1', 'map-1', 'manual', 'adm-1')
    expect(audit).toHaveBeenCalledWith(admin, 'service_map.synced', 'ServiceMap', 'map-1', expect.objectContaining({ trigger: 'manual', added: 1, removed: 0, moved: 2, changed: true, skipped: null }))

    // tetto dei 500: skipped = true con il motivo leggibile, la mappa è comunque quella aggiornata
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[MAP_RE, mapRow({ version: 5, stale: true, stale_reason: 'over_limit' })]])
    vi.mocked(sync.syncServiceMap).mockResolvedValue({
      mapId: 'map-1', version: 5, status: 'active', added: 0, removed: 0, moved: 0, changed: false,
      skipped: 'limit', reason: 'Sincronizzazione saltata: … supera il tetto di 500 componenti', syncedAt: 'T9', note: null, evaluation: null,
    })
    const overLimit = await serviceResolvers.Mutation.syncServiceMap(null, { id: 'map-1' }, admin)
    expect(overLimit).toMatchObject({ added: 0, removed: 0, moved: 0, skipped: true, reason: expect.stringContaining('tetto di 500') })
    expect(overLimit.map).toMatchObject({ stale: true, staleReason: 'over_limit' })

    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    await expectCode(serviceResolvers.Mutation.setServiceMapAutoSync(null, { id: 'map-1', expectedVersion: 3, autoSync: true }, operator), 'FORBIDDEN')
    await expectCode(serviceResolvers.Mutation.syncServiceMap(null, { id: 'map-1' }, viewer), 'FORBIDDEN')
    expect(config.setServiceMapAutoSync).not.toHaveBeenCalled()
    expect(sync.syncServiceMap).not.toHaveBeenCalled()
  })

  it('deleteServiceMap: DETACH DELETE di mappa e cronologia in uno statement, job in attesa rimosso, audit; inesistente → NOT_FOUND; rimozione del job fallita → solo warning', async () => {
    onCypher([[/FOREACH \(x IN entries \| DETACH DELETE x\)\s+DETACH DELETE m/, { name: 'Enterprise Billing', serviceId: 'ba-1', entries: 3 }]])
    expect(await serviceResolvers.Mutation.deleteServiceMap(null, { id: 'map-1' }, admin)).toBe(true)
    // D4.3: il commento sugli incident di servizio ancora aperti PRIMA della cancellazione
    // (dopo, senza mappa, nessuno potrebbe più chiuderli né dire perché)
    expect(noteServiceMapDeletion).toHaveBeenCalledWith('tenant-1', 'map-1')
    expect(vi.mocked(noteServiceMapDeletion).mock.invocationCallOrder[0]!)
      .toBeLessThan(session.executeWrite.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER)
    const q = callMatching(/DETACH DELETE m/)!
    expect(q.cypher).toMatch(/MATCH \(m:ServiceMap \{id: \$id, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(m\)-\[:HAS_HEALTH_HISTORY\]->\(h:ServiceHealthEntry \{tenant_id: \$tenantId\}\)/)
    expect(q.params).toEqual({ id: 'map-1', tenantId: 'tenant-1' })
    // valutazione E sincronizzazione in attesa: dalla revisione 2 i job hanno id libero, si cercano per dati
    expect(forgetServiceMapJobs).toHaveBeenCalledWith('tenant-1', 'map-1')
    expect(audit).toHaveBeenCalledWith(admin, 'service_map.deleted', 'ServiceMap', 'map-1', { name: 'Enterprise Billing', serviceId: 'ba-1', historyEntries: 3, pendingJobsRemoved: 2 })

    vi.mocked(forgetServiceMapJobs).mockResolvedValueOnce(0)
    onCypher([[/DETACH DELETE m/, { name: 'X', serviceId: 'ba-1', entries: 0 }]])
    expect(await serviceResolvers.Mutation.deleteServiceMap(null, { id: 'map-1' }, admin)).toBe(true)
    onCypher([[/DETACH DELETE m/, null]])
    await expectCode(serviceResolvers.Mutation.deleteServiceMap(null, { id: 'map-x' }, admin), 'NOT_FOUND')
    await expectCode(serviceResolvers.Mutation.deleteServiceMap(null, { id: 'map-1' }, operator), 'FORBIDDEN')
  })
})
