/**
 * resolvers/services.ts — the resolvers and edges the main suite
 * (services.test.ts) does not walk.
 *
 * Why these matter:
 *  - "Create a map" shows the components a new map WOULD have before
 *    creating it (serviceMapCreationPreview): admin-only, same build as the
 *    real creation, never a write;
 *  - the relationship types offered by the dialog are the customer's own;
 *  - a transient database error while changing a map's status must surface
 *    as itself, not be disguised as "modified by someone else";
 *  - partial graph data (a service without name/owner, a cause without
 *    health, a map never updated) must map to explicit nulls/empties, not
 *    crash the Services page or invent values;
 *  - re-admitting a CI on a live map returns the re-read map only when the
 *    sync actually changed something.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('../../../lib/domainMatrix.js', () => import('../../../lib/__tests__/domainMatrixFake.js'))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(), toNumber: (v: unknown) => (v == null ? 0 : Number(v)) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../services/events/policy.js', () => ({ getEventPolicy: vi.fn().mockResolvedValue({ suppress_upstream_hops: 1,
  retired_statuses: ['inactive', 'decommissioned'], maintenance_statuses: ['maintenance'], ignore_lifecycle_statuses: ['decommissioned'] }) }))
vi.mock('../../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../../../lib/bullmq.js', () => ({ getQueue: vi.fn(() => ({})) }))
vi.mock('../../../jobs/serviceImpactWorker.js', () => ({ forgetServiceMapJobs: vi.fn().mockResolvedValue(0) }))
vi.mock('../../../services/serviceImpact/engine.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/serviceImpact/engine.js')>()),
  createServiceMap: vi.fn(),
  evaluateServiceMap: vi.fn(),
}))
vi.mock('../../../services/serviceImpact/build.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/serviceImpact/build.js')>()),
  buildServiceMap: vi.fn(),
}))
vi.mock('../../../services/events/incidentWorkflow.js', () => ({
  incidentStepInfo: vi.fn(async () => ({ resolvedStep: 'resolved', terminalSteps: ['resolved', 'closed'] })),
}))
vi.mock('../../../services/events/cascade.js', () => ({ noteServiceMapDeletion: vi.fn().mockResolvedValue(0) }))
vi.mock('../../../services/serviceImpact/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/serviceImpact/config.js')>()),
  removeServiceMapExclusion: vi.fn(),
}))
vi.mock('../../../services/serviceImpact/sync.js', () => ({ syncServiceMap: vi.fn(), notifyCIGraphChanged: vi.fn() }))
vi.mock('../../../lib/ciMetamodelForTenant.js', () => ({
  serviceRelationshipTypesForTenant: vi.fn(async () => ['DEPENDS_ON', 'HOSTED_ON', 'BALANCES']),
  suppressionRelPatternForTenant:    vi.fn(async () => 'DEPENDS_ON|HOSTED_ON'),
  serviceRolesForTenant:             vi.fn(async () => new Map()),
}))
vi.mock('../../../lib/workflowHelpers.js', () => ({
  getStepNamesByPurpose: vi.fn(async (_s: unknown, _t: unknown, _e: unknown, purposes: readonly string[]) =>
    purposes.includes('implementation') ? ['deployment'] : ['scheduled']),
}))

const { serviceResolvers, mapServiceMap, mapHistoryEntry, parseStoredCauses, worstServiceHealth } = await import('../services.js')
const config = await import('../../../services/serviceImpact/config.js')
const sync = await import('../../../services/serviceImpact/sync.js')
const { buildServiceMap } = await import('../../../services/serviceImpact/build.js')
const { getSession, runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { audit } = await import('../../../lib/audit.js')
const { DEFAULT_SERVICE_IMPACT_RULES_JSON } = await import('../../../lib/serviceVocabularies.js')

const admin:    GraphQLContext = { tenantId: 'tenant-1', userId: 'adm-1', userEmail: 'adm@test.io', role: 'admin', permissions: perms('admin') }
const operator: GraphQLContext = { ...admin, userId: 'op-1', role: 'operator', permissions: perms('operator') }
const viewer:   GraphQLContext = { ...admin, userId: 'v-1', role: 'viewer', permissions: perms('viewer') }
const tx = { run: vi.fn() }
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

const mapRow = (over: Record<string, unknown> = {}, service: Record<string, unknown> | null = { id: 'ba-1', name: 'Billing', criticality: 'mission_critical', owner: null }) => ({
  props: {
    id: 'map-1', tenant_id: 'tenant-1', service_id: 'ba-1', name: 'Billing', status: 'active', version: 1, updated_at: 'T0',
    built_from: 'auto', max_depth: 4, relationship_types: ['DEPENDS_ON'], rules: DEFAULT_SERVICE_IMPACT_RULES_JSON,
    health: 'operational', health_since: 'T1', impact_score: 0, explanation: '[]', stale: false, evaluated_at: 'T2', node_ids: [],
    auto_sync: true, synced_at: 'T3', ...over,
  },
  service,
  nodeCount: 0,
})
const MAP_RE = /MATCH \(m:ServiceMap \{id: \$id, tenant_id: \$tenantId\}\)\s+OPTIONAL MATCH \(ba:BusinessApplication/
const STATUS_RE = /SET m\.status = \$status, m\.updated_at = \$now/

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
})

describe('serviceMapCreationPreview', () => {
  it('admin: the components a new map would have, built like the real creation, without writing', async () => {
    vi.mocked(buildServiceMap).mockResolvedValue({
      serviceName: 'Billing', maxDepth: 3, relationshipTypes: ['DEPENDS_ON'],
      nodes: [
        { ciId: 'app-1', name: 'APP-1', labels: ['Application'], status: 'active', health: 'operational', level: 1, via: null, role: 'entry', propagate: 'weighted', weight: 8, critical: true },
        { ciId: 'db-1', name: null, labels: ['Database'], status: null, health: null, level: 2, via: 'app-1', role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false },
      ],
    } as never)
    const out = await serviceResolvers.Query.serviceMapCreationPreview(null, { serviceId: 'ba-1', maxDepth: 3, relationshipTypes: ['DEPENDS_ON'] }, admin)
    // Scoped to the caller's tenant: the build never sees another tenant id.
    expect(buildServiceMap).toHaveBeenCalledWith(session, 'tenant-1', 'ba-1', 3, ['DEPENDS_ON'])
    expect(out).toEqual({
      serviceName: 'Billing', maxDepth: 3, relationshipTypes: ['DEPENDS_ON'],
      nodes: [
        { ci: { id: 'app-1', name: 'APP-1', type: 'application', status: 'active', health: 'operational' }, level: 1, role: 'entry', propagate: 'weighted', weight: 8, critical: true, via: null },
        // A CI without a name maps to '' (the field is non-null in the SDL), never null.
        { ci: { id: 'db-1', name: '', type: 'database', status: null, health: null }, level: 2, role: 'infrastructure', propagate: 'weighted', weight: 5, critical: false, via: 'app-1' },
      ],
    })
    expect(session.executeWrite).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('operator → FORBIDDEN without building anything', async () => {
    await expectCode(serviceResolvers.Query.serviceMapCreationPreview(null, { serviceId: 'ba-1', maxDepth: 3, relationshipTypes: ['DEPENDS_ON'] }, operator), 'FORBIDDEN')
    expect(buildServiceMap).not.toHaveBeenCalled()
  })

  it('the session is closed even when the build fails', async () => {
    vi.mocked(buildServiceMap).mockRejectedValue(new Error('over 500 nodes'))
    await expect(serviceResolvers.Query.serviceMapCreationPreview(null, { serviceId: 'ba-1', maxDepth: 3, relationshipTypes: ['DEPENDS_ON'] }, admin)).rejects.toThrow('over 500 nodes')
    expect(session.close).toHaveBeenCalledTimes(1)
  })
})

describe('serviceRelationshipTypes', () => {
  it('returns the relationship types this tenant can traverse, including its own', async () => {
    await expect(serviceResolvers.Query.serviceRelationshipTypes(null, {}, viewer)).resolves.toEqual(['DEPENDS_ON', 'HOSTED_ON', 'BALANCES'])
  })
})

describe('serviceMaps — impossible page result', () => {
  it('a page query with no row is an error, not an empty list', async () => {
    onCypher([[/countTotal/, null]])
    await expect(serviceResolvers.Query.serviceMaps(null, {}, viewer)).rejects.toThrow(/the page query returned no row/)
    expect(session.close).toHaveBeenCalledTimes(1)
  })
})

describe('serviceMapCandidates — defaults', () => {
  it('without search or limit: no filter and 20 candidates; missing name/criticality map to explicit values', async () => {
    onCypher([[/HAS_SERVICE_MAP/, [{ id: 'ba-9', name: null, criticality: null, owner: { id: 'team-1', tenant_id: 'tenant-1', name: 'Ops', created_at: 'T' } }]]])
    const out = await serviceResolvers.Query.serviceMapCandidates(null, { search: '   ' }, admin)
    expect(out).toEqual([{ id: 'ba-9', name: '', criticality: null, ownerGroup: expect.objectContaining({ id: 'team-1', name: 'Ops' }) }])
    expect(calls()[0]!.params).toEqual({ tenantId: 'tenant-1', search: null, limit: 20 })
  })

  it('a limit below 1 is raised to 1', async () => {
    onCypher([[/HAS_SERVICE_MAP/, []]])
    await serviceResolvers.Query.serviceMapCandidates(null, { limit: 0 }, admin)
    expect(calls()[0]!.params['limit']).toBe(1)
  })
})

describe('setServiceMapStatus — errors that are not a version conflict', () => {
  it('a database error inside the transaction surfaces as itself, never as "modified by someone else"', async () => {
    vi.mocked(runQueryOne).mockRejectedValue(new Error('neo4j: transaction terminated'))
    await expect(serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-1', expectedVersion: 1, status: 'paused' }, admin))
      .rejects.toThrow('neo4j: transaction terminated')
    expect(audit).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('a conflict on a map never updated reports "n/a" as the last update', async () => {
    onCypher([[STATUS_RE, null], [MAP_RE, mapRow({ version: 4, updated_at: null })]])
    await expectCode(serviceResolvers.Mutation.setServiceMapStatus(null, { id: 'map-1', expectedVersion: 1, status: 'paused' }, admin),
      'BAD_USER_INPUT', /current is 4, updated at n\/a/)
  })
})

describe('removeServiceMapExclusion — live map sync outcome', () => {
  const written = { mapId: 'map-1', version: 3, status: 'active' as const, note: 'n', evaluation: null }
  const synced = (changed: boolean) => ({ mapId: 'map-1', version: 4, status: 'active', added: changed ? 1 : 0, removed: 0, moved: 0, retired: 0, changed, skipped: null, reason: null, syncedAt: 'T', note: null, evaluation: null })

  it('sync changed nothing: the map read before the sync is returned (no second read)', async () => {
    vi.mocked(config.removeServiceMapExclusion).mockResolvedValue(written)
    vi.mocked(sync.syncServiceMap).mockResolvedValue(synced(false) as never)
    onCypher([[MAP_RE, mapRow({ version: 3 })]])
    const out = await serviceResolvers.Mutation.removeServiceMapExclusion(null, { id: 'map-1', expectedVersion: 2, ciId: 'cert-x' }, admin)
    expect(out).toMatchObject({ id: 'map-1', version: 3 })
    expect(calls().filter((c) => MAP_RE.test(c.cypher))).toHaveLength(1)
  })

  it('sync changed the components: the map is read again so the page shows them', async () => {
    vi.mocked(config.removeServiceMapExclusion).mockResolvedValue(written)
    vi.mocked(sync.syncServiceMap).mockResolvedValue(synced(true) as never)
    let reads = 0
    onCypher([[MAP_RE, () => mapRow({ version: reads++ === 0 ? 3 : 4 })]])
    const out = await serviceResolvers.Mutation.removeServiceMapExclusion(null, { id: 'map-1', expectedVersion: 2, ciId: 'cert-x' }, admin)
    expect(out).toMatchObject({ version: 4 })
  })

  it('a paused map is not synchronized', async () => {
    vi.mocked(config.removeServiceMapExclusion).mockResolvedValue({ ...written, status: 'paused' })
    onCypher([[MAP_RE, mapRow({ version: 3, status: 'paused' })]])
    await serviceResolvers.Mutation.removeServiceMapExclusion(null, { id: 'map-1', expectedVersion: 2, ciId: 'cert-x' }, admin)
    expect(sync.syncServiceMap).not.toHaveBeenCalled()
  })
})

describe('mappers — partial graph data', () => {
  it('a service without name, criticality or owner maps to explicit empties', () => {
    const m = mapServiceMap(mapRow({ unhealthy_count: 2 }, { id: 'ba-1', name: null, criticality: null, owner: null }) as never)
    expect(m.service).toEqual({ id: 'ba-1', name: '', criticality: null, ownerGroup: null })
    expect(m.unhealthyCount).toBe(2)
  })

  it('a stored cause without health maps it to null (snapshot, never invented)', () => {
    const raw = JSON.stringify([{ ciId: 'db', health: 'down', weight: 5, critical: false, ci: { id: 'db', name: 'DB', type: 'database' }, path: [] }])
    expect(parseStoredCauses(raw, 'x')[0]!.ci).toEqual({ id: 'db', name: 'DB', type: 'database', status: null, health: null })
  })

  it('a history entry with a previous health keeps it; one outside the vocabulary is an error', () => {
    const entry = { id: 'h1', at: 'T', health: 'down', previous_health: 'degraded', impact_score: 70, trigger: 'ci_health', cause: '[]', note: null }
    expect(mapHistoryEntry(entry).previousHealth).toBe('degraded')
    expect(() => mapHistoryEntry({ ...entry, previous_health: 'broken' })).toThrow(/ServiceHealthEntry h1 previous_health is "broken"/)
  })

  it('malformed JSON is reported as corrupt, naming the field', () => {
    expect(() => parseStoredCauses('{', 'ServiceMap m explanation')).toThrow(/ServiceMap m explanation is corrupt JSON/)
  })

  it('worstServiceHealth ignores unknown and keeps the worst known health', () => {
    expect(worstServiceHealth(['operational', 'unknown', 'maintenance'])).toBe('maintenance')
    expect(worstServiceHealth(['unknown'])).toBe('unknown')
  })
})

describe('businessCapabilitiesHealth — ties and missing names', () => {
  it('services with the same health are ordered by name; a capability or service without a name maps to ""', async () => {
    onCypher([[/MATCH \(c:BusinessCapability \{tenant_id: \$tenantId\}\)/, [
      { id: 'cap-1', name: null, services: [
        { id: 'ba-2', name: 'Zeta', criticality: null, health: 'down', owner: null },
        { id: 'ba-1', name: null, criticality: null, health: 'down', owner: null },
      ] },
    ]]])
    const out = await serviceResolvers.Query.businessCapabilitiesHealth(null, {}, viewer)
    expect(out[0]!.name).toBe('')
    expect(out[0]!.services.map((s) => s.id)).toEqual(['ba-1', 'ba-2'])
  })
})
