/**
 * TOPOLOGY — THE GRAPH THE USER ACTUALLY SEES.
 *
 * `topology.test.ts` pins where the CI labels come from; this file pins what
 * comes back once the queries return rows:
 *  - the ego-network of a selected CI: depth clamped to 1..10 (a client
 *    asking 50 hops must not launch an unbounded traversal), environment and
 *    status filters passed through, the origin always kept, edges limited to
 *    the loaded nodes of this tenant;
 *  - the full topology: environment/status filters, counts of open tickets as
 *    numbers, edges only between CIs of this tenant;
 *  - an empty result is an empty graph (never a second query with different
 *    semantics), and the result is cached per tenant and per filter set, so
 *    two tenants or two filters never share a cached graph.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'
import neo4j from 'neo4j-driver'

vi.mock('../../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:         vi.fn(async () => ['Application', 'Server']),
  ciLabelPredicateForTenant: vi.fn(async () => '(ci:Application OR ci:Server)'),
  apocLabelFilterForTenant:  vi.fn(async () => '+Application|+Server'),
  ciTypeNameForLabel:        vi.fn(async () => null),
  clearCILabelCache:         vi.fn(),
}))

vi.mock('@opengraphity/schema-generator', () => ({
  loadMetamodel: vi.fn(async () => [
    { name: 'application', neo4jLabel: 'Application', scope: 'base', active: true },
    { name: 'server',      neo4jLabel: 'Server',      scope: 'base', active: true },
  ]),
}))

vi.mock('../../../lib/ciLifecycle.js', () => ({
  resolveCILifecycleSemantics: vi.fn(async () => ({ retired: new Set(), maintenance: new Set(['maintenance']), ignored: new Set() })),
  isMaintenanceLifecycle: (status: string | null | undefined, s: { maintenance: Set<string> }) => status != null && s.maintenance.has(status),
}))

const h = vi.hoisted(() => ({
  queries: [] as { cypher: string; params: Record<string, unknown> }[],
  reach: [] as string[],
  nodes: [] as Record<string, unknown>[],
  edges: [] as Record<string, unknown>[],
  cache: new Map<string, unknown>(),
  ttl: [] as number[],
}))

const neo4jInt = (n: number) => neo4j.int(n)
const row = (m: Record<string, unknown>) => ({ get: (k: string) => m[k] })

const mockSession = {
  executeRead: vi.fn(async (fn: (tx: unknown) => unknown) =>
    fn({
      run: (cypher: string, params: Record<string, unknown>) => {
        h.queries.push({ cypher, params })
        if (cypher.includes('apoc.path.subgraphNodes')) return Promise.resolve({ records: h.reach.map((id) => row({ id })) })
        if (cypher.includes('AS incidentCount')) return Promise.resolve({ records: h.nodes.map(row) })
        if (cypher.includes('AS relType')) return Promise.resolve({ records: h.edges.map(row) })
        return Promise.resolve({ records: [] })
      },
    })),
}

vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
}))

vi.mock('../../../lib/workflowHelpers.js', () => ({
  getTerminalStepNames: vi.fn(async (_s: unknown, _t: string, kind: string) => (kind === 'incident' ? ['closed'] : ['completed'])),
}))

vi.mock('../../../lib/cache.js', () => ({
  cache: {
    get: (k: string) => h.cache.get(k),
    set: (k: string, v: unknown, ttl: number) => { h.cache.set(k, v); h.ttl.push(ttl) },
  },
}))

const { topologyResolvers } = await import('../topology.js')
const topology = topologyResolvers.Query.topology

const ctx = (tenantId = 'tenant-1'): GraphQLContext => ({ tenantId, userId: 'user-1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') })

type Graph = { nodes: Array<Record<string, unknown>>; edges: unknown[]; truncated: boolean; nodeLimit: number }

const q = (needle: string) => h.queries.find((x) => x.cypher.includes(needle))

const srv = (id: string, over: Record<string, unknown> = {}) => ({
  id, name: id, type: 'Server', status: 'active', health: 'ok', environment: 'production', ownerGroup: 'Ops',
  // Neo4j integers are converted to plain numbers by the real toNumber.
  incidentCount: neo4jInt(2), changeCount: 0, ...over,
})

beforeEach(() => {
  h.queries.length = 0
  h.reach = []; h.nodes = []; h.edges = []
  h.cache.clear(); h.ttl.length = 0
})

describe('topology — ego-network of a selected CI', () => {
  it('returns nodes and edges of the reachable CIs, with ticket counts as numbers', async () => {
    h.reach = ['ci-1', 'ci-2']
    h.nodes = [srv('ci-1'), srv('ci-2', { status: 'maintenance', health: undefined, incidentCount: 0 })]
    h.edges = [{ source: 'ci-1', target: 'ci-2', relType: 'DEPENDS_ON' }]

    const out = await topology(null, { selectedCiId: 'ci-1', maxHops: 2 }, ctx()) as Graph

    expect(out.truncated).toBe(false)
    expect(out.edges).toEqual([{ source: 'ci-1', target: 'ci-2', type: 'DEPENDS_ON' }])
    expect(out.nodes[0]).toMatchObject({ id: 'ci-1', type: 'server', incidentCount: 2, changeCount: 0, ownerGroup: 'Ops', inMaintenance: false })
    // A missing health is null, not undefined: the web tells "unknown" from "not loaded".
    expect(out.nodes[1]).toMatchObject({ id: 'ci-2', health: null, inMaintenance: true })

    // Nodes and edges are read only among the reachable ids, in this tenant.
    expect(q('AS incidentCount')!.params).toMatchObject({ nodeIds: ['ci-1', 'ci-2'], tenantId: 'tenant-1', ciId: 'ci-1', incidentTerminal: ['closed'], changeTerminal: ['completed'] })
    expect(q('AS relType')!.params).toEqual({ nodeIds: ['ci-1', 'ci-2'], tenantId: 'tenant-1' })
  })

  it.each([
    [undefined, 10], [null, 10], [0, 1], [-3, 1], [2.9, 2], [50, 10],
  ])('maxHops %s traverses %s levels', async (maxHops, depth) => {
    await topology(null, { selectedCiId: 'ci-1', maxHops }, ctx())
    expect(q('apoc.path.subgraphNodes')!.params['depth']).toBe(depth)
  })

  it('passes environment and status to both the traversal and the node query', async () => {
    h.reach = ['ci-1']
    h.nodes = [srv('ci-1')]
    await topology(null, { selectedCiId: 'ci-1', environment: 'staging', status: 'active' }, ctx())
    for (const needle of ['apoc.path.subgraphNodes', 'AS incidentCount']) {
      expect(q(needle)!.params).toMatchObject({ environment: 'staging', status: 'active' })
    }
  })

  it('an unknown origin is an empty graph, and nothing else is queried', async () => {
    const out = await topology(null, { selectedCiId: 'ghost' }, ctx()) as Graph
    expect(out).toEqual({ nodes: [], edges: [], truncated: false, nodeLimit: 2000 })
    expect(q('AS incidentCount')).toBeUndefined()
  })

  it('flags the graph as truncated when the traversal hits the node limit', async () => {
    h.reach = Array.from({ length: 2000 }, (_, i) => `ci-${String(i)}`)
    const out = await topology(null, { selectedCiId: 'ci-0' }, ctx()) as Graph
    expect(out.truncated).toBe(true)
    expect(out.nodeLimit).toBe(2000)
  })
})

describe('topology — full graph', () => {
  it('applies environment and status filters and reads edges between CIs of this tenant only', async () => {
    h.nodes = [srv('a'), srv('b')]
    h.edges = [{ source: 'a', target: 'b', relType: 'RUNS_ON' }]
    const out = await topology(null, { environment: 'production', status: 'active' }, ctx()) as Graph

    const nodesQ = q('AS incidentCount')!
    expect(nodesQ.cypher).toContain('AND ci.environment = $environment AND ci.status = $status')
    expect(nodesQ.params).toMatchObject({ tenantId: 'tenant-1', environment: 'production', status: 'active' })
    expect(q('AS relType')!.params).toEqual({ tenantId: 'tenant-1', nodeIds: ['a', 'b'], ciLabels: ['Application', 'Server'] })
    expect(out.edges).toEqual([{ source: 'a', target: 'b', type: 'RUNS_ON' }])
    expect(out.truncated).toBe(false)
  })

  it('without filters the node query has no extra conditions', async () => {
    await topology(null, { types: [] }, ctx())
    const nodesQ = q('AS incidentCount')!
    expect(nodesQ.cypher).not.toContain('$environment')
    expect(nodesQ.params['environment']).toBeUndefined()
  })

  it('no CI: empty graph, no edge query', async () => {
    const out = await topology(null, {}, ctx()) as Graph
    expect(out).toEqual({ nodes: [], edges: [], truncated: false, nodeLimit: 2000 })
    expect(q('AS relType')).toBeUndefined()
  })
})

describe('topology — cache', () => {
  it('serves a repeated request from the cache for 30 seconds', async () => {
    h.nodes = [srv('a')]
    const first = await topology(null, { environment: 'production' }, ctx())
    expect(h.ttl).toEqual([30])
    h.queries.length = 0
    const second = await topology(null, { environment: 'production' }, ctx())
    expect(second).toBe(first)
    expect(h.queries).toEqual([])
  })

  it('never shares a cached graph across tenants or filters', async () => {
    h.nodes = [srv('a')]
    await topology(null, { selectedCiId: undefined }, ctx('tenant-1'))
    h.reach = ['a']
    await topology(null, { selectedCiId: 'a', maxHops: 3 }, ctx('tenant-1'))
    await topology(null, {}, ctx('tenant-2'))
    await topology(null, { status: 'active' }, ctx('tenant-1'))
    expect([...h.cache.keys()]).toEqual([
      'topology:tenant-1::all:::',
      'topology:tenant-1:a:3:::',
      'topology:tenant-2::all:::',
      'topology:tenant-1::all::active:',
    ])
  })
})
