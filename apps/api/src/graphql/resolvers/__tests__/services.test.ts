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

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => (v == null ? 0 : Number(v)) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
const queueRemove = vi.fn().mockResolvedValue(1)
vi.mock('../../../lib/bullmq.js', () => ({ getQueue: vi.fn(() => ({ remove: queueRemove })) }))
vi.mock('../../../services/serviceImpact/engine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/serviceImpact/engine.js')>()),
  createServiceMap: vi.fn(),
  evaluateServiceMap: vi.fn(),
}))

const { serviceResolvers, mapServiceMap, parseStoredCauses, SERVICE_MAP_ORDER } = await import('../services.js')
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { audit } = await import('../../../lib/audit.js')
const { createServiceMap, evaluateServiceMap } = await import('../../../services/serviceImpact/engine.js')
const { DEFAULT_SERVICE_IMPACT_RULES_JSON, SERVICE_RELATIONSHIP_TYPES } = await import('../../../lib/serviceVocabularies.js')
const { CHANGE_WINDOW_STEPS } = await import('../../../services/events/suppression.js')

const admin:    GraphQLContext = { tenantId: 'tenant-1', userId: 'adm-1', userEmail: 'adm@test.io', role: 'admin' }
const operator: GraphQLContext = { ...admin, userId: 'op-1', role: 'operator' }
const viewer:   GraphQLContext = { ...admin, userId: 'v-1', role: 'viewer' }
const session = { close: vi.fn().mockResolvedValue(undefined) }

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
    health: 'degraded', health_since: 'T1', impact_score: 41, explanation: JSON.stringify([cause]), stale: false, evaluated_at: 'T2', node_ids: ['app-3', 'db-01'], ...over,
  },
  service: { id: 'ba-1', name: 'Enterprise Billing', criticality: 'mission_critical', owner: { id: 'team-1', tenant_id: 'tenant-1', name: 'Finance IT', created_at: 'T' } },
  nodeCount: 2,
})
const MAP_RE = /MATCH \(m:ServiceMap \{id: \$id, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(ba:BusinessApplication/

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
  queueRemove.mockResolvedValue(1)
})

// ── Mapper ───────────────────────────────────────────────────────────────────

describe('mapServiceMap / parseStoredCauses', () => {
  it('snake_case → camelCase, regole e spiegazione dal JSON (istantanee: status null), servizio con owner Team, nodeCount', () => {
    const out = mapServiceMap(mapRow())
    expect(out).toMatchObject({
      id: 'map-1', name: 'Enterprise Billing', status: 'active', version: 1, updatedAt: 'T0', maxDepth: 4, relationshipTypes: ['DEPENDS_ON', 'HOSTED_ON'], builtFrom: 'auto', stale: false,
      rules: { version: 1, downSharePct: 50, degradedSharePct: 1, minNodes: 1, unknownNodes: 'operational', openIncidentFrom: 'down' },
      health: 'degraded', healthSince: 'T1', impactScore: 41, evaluatedAt: 'T2', nodeCount: 2,
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
    expect(runQueryOne).not.toHaveBeenCalled()
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
    props: { id: 'map-1', rules: DEFAULT_SERVICE_IMPACT_RULES_JSON, node_ids: ['app-3', 'db-01', 'cert-1'] },
    nodes: [
      { ciId: 'db-01', name: 'DB-01', labels: ['Database'], level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'app-3', addedBy: 'auto', health: 'down', healthSource: 'monitoring', status: 'active', changes: [] },
      { ciId: 'app-3', name: 'APP-003', labels: ['Application'], level: 1, role: 'entry', propagate: 'weighted', weight: 8, critical: true, via: null, addedBy: 'auto', health: 'operational', healthSource: 'monitoring', status: 'active', changes: [{ step: 'deployment', plans: [] }] },
      { ciId: 'cert-1', name: 'CERT-01', labels: ['Certificate'], level: 2, role: 'certificate', propagate: 'never', weight: 3, critical: false, via: 'app-3', addedBy: 'auto', health: null, healthSource: null, status: 'active', changes: [] },
    ],
  }

  it('nodes: stessa lettura del motore (finestra di change inclusa), per livello poi nome, con ci ref, inMaintenance e contributes', async () => {
    onCypher([[/OPTIONAL MATCH \(m\)-\[inc:INCLUDES\]->/, stateRow]])
    const out = await serviceResolvers.ServiceMap.nodes({ id: 'map-1' }, null, viewer)
    expect(out).toEqual([
      { ci: { id: 'app-3', name: 'APP-003', type: 'application', status: 'active', health: 'operational' }, level: 1, role: 'entry', propagate: 'weighted', weight: 8, critical: true, via: null, addedBy: 'auto', health: 'operational', inMaintenance: true, contributes: false },
      { ci: { id: 'cert-1', name: 'CERT-01', type: 'certificate', status: 'active', health: null }, level: 2, role: 'certificate', propagate: 'never', weight: 3, critical: false, via: 'app-3', addedBy: 'auto', health: null, inMaintenance: false, contributes: false },
      { ci: { id: 'db-01', name: 'DB-01', type: 'database', status: 'active', health: 'down' }, level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'app-3', addedBy: 'auto', health: 'down', inMaintenance: false, contributes: true },
    ])
    expect(callMatching(/inc:INCLUDES/)!.params).toEqual({ mapId: 'map-1', tenantId: 'tenant-1', windowSteps: CHANGE_WINDOW_STEPS })
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

// ── Mutation ─────────────────────────────────────────────────────────────────

describe('createServiceMap', () => {
  it('admin: default del contratto (maxDepth 4, tutte le relazioni), motore chiamato con l\'utente, audit, restituisce la mappa riletta', async () => {
    vi.mocked(createServiceMap).mockResolvedValueOnce({ mapId: 'map-1', proposal: { serviceName: 'Enterprise Billing', maxDepth: 4, relationshipTypes: [...SERVICE_RELATIONSHIP_TYPES], nodes: [{}, {}] }, evaluation: { health: 'degraded', impactScore: 41 } } as never)
    onCypher([[MAP_RE, mapRow()]])
    const out = await serviceResolvers.Mutation.createServiceMap(null, { serviceId: 'ba-1' }, admin)
    expect(out).toMatchObject({ id: 'map-1', health: 'degraded' })
    expect(createServiceMap).toHaveBeenCalledWith({ tenantId: 'tenant-1', serviceId: 'ba-1', maxDepth: 4, relationshipTypes: [...SERVICE_RELATIONSHIP_TYPES], actorId: 'adm-1' })
    expect(audit).toHaveBeenCalledWith(admin, 'service_map.created', 'ServiceMap', 'map-1', expect.objectContaining({ serviceId: 'ba-1', serviceName: 'Enterprise Billing', nodes: 2, health: 'degraded', impactScore: 41 }))
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

  it('setServiceMapStatus: SET con versione attesa nel WHERE, version + 1, audit; paused → active rivaluta subito; versione diversa → BAD_USER_INPUT; inesistente → NOT_FOUND; status fuori enum → BAD_USER_INPUT', async () => {
    onCypher([[/SET m\.status = \$status, m\.version = version \+ 1/, { previous: 'paused', version: 2 }], [MAP_RE, mapRow({ status: 'active', version: 2 })]])
    vi.mocked(evaluateServiceMap).mockResolvedValueOnce({ mapId: 'map-1', health: 'degraded', previousHealth: 'degraded', impactScore: 41, changed: false, stale: false, causes: [] })
    const out = await serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-1', expectedVersion: 1, status: 'active' }, admin)
    expect(out).toMatchObject({ status: 'active', version: 2 })
    const q = callMatching(/version \+ 1/)!
    expect(q.cypher).toMatch(/MATCH \(m:ServiceMap \{id: \$id, tenant_id: \$tenantId\}\)\s+WITH m, m\.status AS previous, m\.version AS version\s+WHERE version = toInteger\(\$expectedVersion\)/)
    expect(q.params).toMatchObject({ id: 'map-1', tenantId: 'tenant-1', expectedVersion: 1, status: 'active', userId: 'adm-1' })
    expect(evaluateServiceMap).toHaveBeenCalledWith({ tenantId: 'tenant-1', mapId: 'map-1', trigger: 'manual', actorId: 'adm-1' })
    expect(audit).toHaveBeenCalledWith(admin, 'service_map.status_changed', 'ServiceMap', 'map-1', { previousStatus: 'paused', status: 'active', version: 2 })

    // active → paused: nessuna valutazione
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[/version \+ 1/, { previous: 'active', version: 3 }], [MAP_RE, mapRow({ status: 'paused', version: 3 })]])
    await serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-1', expectedVersion: 2, status: 'paused' }, admin)
    expect(evaluateServiceMap).not.toHaveBeenCalled()

    // conflitto di versione
    vi.clearAllMocks(); vi.mocked(getSession).mockReturnValue(session as never)
    onCypher([[/version \+ 1/, null], [MAP_RE, mapRow({ version: 5, updated_at: 'T9' })]])
    await expectCode(serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-1', expectedVersion: 2, status: 'paused' }, admin), 'BAD_USER_INPUT', /modified by someone else \(expected version 2, current is 5, updated at T9\)/)
    expect(audit).not.toHaveBeenCalled()
    onCypher([[/version \+ 1/, null], [MAP_RE, null]])
    await expectCode(serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-x', expectedVersion: 1, status: 'paused' }, admin), 'NOT_FOUND')
    await expectCode(serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-1', expectedVersion: 1, status: 'archived' }, admin), 'BAD_USER_INPUT', /status must be one of: draft, active, paused/)
    await expectCode(serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-1', expectedVersion: 0, status: 'paused' }, admin), 'BAD_USER_INPUT', /expectedVersion/)
    await expectCode(serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-1', expectedVersion: 1, status: 'paused' }, operator), 'FORBIDDEN')
  })

  it('deleteServiceMap: DETACH DELETE di mappa e cronologia in uno statement, job in attesa rimosso, audit; inesistente → NOT_FOUND; rimozione del job fallita → solo warning', async () => {
    onCypher([[/FOREACH \(x IN entries \| DETACH DELETE x\)\s+DETACH DELETE m/, { name: 'Enterprise Billing', serviceId: 'ba-1', entries: 3 }]])
    expect(await serviceResolvers.Mutation.deleteServiceMap(null, { id: 'map-1' }, admin)).toBe(true)
    const q = callMatching(/DETACH DELETE m/)!
    expect(q.cypher).toMatch(/MATCH \(m:ServiceMap \{id: \$id, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(m\)-\[:HAS_HEALTH_HISTORY\]->\(h:ServiceHealthEntry \{tenant_id: \$tenantId\}\)/)
    expect(q.params).toEqual({ id: 'map-1', tenantId: 'tenant-1' })
    expect(queueRemove).toHaveBeenCalledWith('svc-tenant-1-map-1')
    expect(audit).toHaveBeenCalledWith(admin, 'service_map.deleted', 'ServiceMap', 'map-1', { name: 'Enterprise Billing', serviceId: 'ba-1', historyEntries: 3 })

    queueRemove.mockRejectedValueOnce(new Error('locked'))
    onCypher([[/DETACH DELETE m/, { name: 'X', serviceId: 'ba-1', entries: 0 }]])
    expect(await serviceResolvers.Mutation.deleteServiceMap(null, { id: 'map-1' }, admin)).toBe(true)
    onCypher([[/DETACH DELETE m/, null]])
    await expectCode(serviceResolvers.Mutation.deleteServiceMap(null, { id: 'map-x' }, admin), 'NOT_FOUND')
    await expectCode(serviceResolvers.Mutation.deleteServiceMap(null, { id: 'map-1' }, operator), 'FORBIDDEN')
  })
})
