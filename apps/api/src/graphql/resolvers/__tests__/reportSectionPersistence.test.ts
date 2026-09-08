import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { SectionInput } from '../customReports.js'

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
}))
vi.mock('../../../lib/navigableGraph.js', () => ({
  getNavigableEntities: vi.fn().mockResolvedValue([
    { entityType: 'custom_box', label: 'Custom Box', neo4jLabel: 'CustomBox', fields: [],
      relations: [{ relationshipType: 'CONTAINS_BOX', direction: 'outgoing', label: '', targetEntityType: 'server', targetLabel: 'Server', targetNeo4jLabel: 'Server' }] },
  ]),
  getNavigableRelations: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../../lib/reportExecutor.js', () => ({
  executeReportSection: vi.fn().mockResolvedValue({ sectionId: 'preview', title: '', chartType: 'kpi', data: '{}', total: 0, error: null }),
}))

const { createSectionWithNodesEdges, sectionInputToDef } = await import('../customReports.js')
const { clearReportWhitelistCache, getReportWhitelist } = await import('../../../lib/reportWhitelist.js')

function makeWriteSession() {
  return {
    executeRead:  vi.fn().mockResolvedValue({ records: [] }),
    executeWrite: vi.fn().mockResolvedValue({ records: [] }),
    close:        vi.fn().mockResolvedValue(undefined),
  }
}

function input(overrides: Partial<SectionInput> = {}): SectionInput {
  return {
    title: 'Sezione', chartType: 'bar', metric: 'count', groupByField: 'status',
    nodes: [{ id: 'node_1', entityType: 'Incident', neo4jLabel: 'Incident', label: 'Incident', isResult: true, isRoot: true, positionX: 0, positionY: 0, selectedFields: [] }],
    edges: [],
    ...overrides,
  }
}

describe('createSectionWithNodesEdges — validation before persistence (C-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearReportWhitelistCache()
  })

  it('persists a valid section (writes happen)', async () => {
    const session = makeWriteSession()
    await createSectionWithNodesEdges(session as never, 'tpl-1', 'sec-1', 0, input(), 'tenant-1')
    expect(session.executeWrite).toHaveBeenCalled()
  })

  it('metamodel label + relation from getNavigableEntities are accepted', async () => {
    const session = makeWriteSession()
    await createSectionWithNodesEdges(session as never, 'tpl-1', 'sec-1', 0, input({
      nodes: [
        { id: 'a', entityType: 'custom_box', neo4jLabel: 'CustomBox', label: 'Box', isResult: true, isRoot: true, positionX: 0, positionY: 0 },
        { id: 'b', entityType: 'server', neo4jLabel: 'Server', label: 'Server', isResult: false, isRoot: false, positionX: 0, positionY: 0 },
      ],
      edges: [{ id: 'e', sourceNodeId: 'a', targetNodeId: 'b', relationshipType: 'CONTAINS_BOX', direction: 'outgoing', label: '' }],
    }), 'tenant-1')
    expect(session.executeWrite).toHaveBeenCalled()
  })

  const malicious: Array<[string, Partial<SectionInput>]> = [
    ['groupByField UNION PoC', { groupByField: 'status as label, count(n_x) as value union match (u:User) return u.email as label, 1 as value //' }],
    ['label not reportable', { nodes: [{ id: 'n', entityType: 'ApiKey', neo4jLabel: 'ApiKey', label: 'x', isResult: true, isRoot: true, positionX: 0, positionY: 0 }] }],
    ['filters field injection', { nodes: [{ id: 'n', entityType: 'Incident', neo4jLabel: 'Incident', label: 'x', isResult: true, isRoot: true, positionX: 0, positionY: 0, filters: JSON.stringify([{ field: 'x) RETURN 1 //', operator: 'eq', value: 1 }]) }] }],
    ['sortDir injection', { sortDir: 'DESC; MATCH (u:User) RETURN u' }],
    ['relationship injection', {
      nodes: [
        { id: 'a', entityType: 'Incident', neo4jLabel: 'Incident', label: 'x', isResult: true, isRoot: true, positionX: 0, positionY: 0 },
        { id: 'b', entityType: 'Team', neo4jLabel: 'Team', label: 'y', isResult: false, isRoot: false, positionX: 0, positionY: 0 },
      ],
      edges: [{ id: 'e', sourceNodeId: 'a', targetNodeId: 'b', relationshipType: 'X]->(u:User) RETURN u //', direction: 'outgoing', label: '' }],
    }],
  ]

  it.each(malicious)('rejects %s with BAD_USER_INPUT and writes nothing', async (_name, patch) => {
    const session = makeWriteSession()
    let thrown: unknown
    try { await createSectionWithNodesEdges(session as never, 'tpl-1', 'sec-1', 0, input(patch), 'tenant-1') }
    catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(GraphQLError)
    expect((thrown as GraphQLError).extensions?.code).toBe('BAD_USER_INPUT')
    expect(session.executeWrite).not.toHaveBeenCalled()
  })
})

describe('getReportWhitelist', () => {
  it('merges static sets with metamodel entities and caches per tenant', async () => {
    clearReportWhitelistCache()
    const { getNavigableEntities } = await import('../../../lib/navigableGraph.js')
    vi.mocked(getNavigableEntities).mockClear()

    const wl1 = await getReportWhitelist('tenant-1')
    const wl2 = await getReportWhitelist('tenant-1')
    expect(getNavigableEntities).toHaveBeenCalledTimes(1)
    expect(wl1).toBe(wl2)
    expect(wl1.labels.has('Incident')).toBe(true)
    expect(wl1.labels.has('CustomBox')).toBe(true)
    expect(wl1.relationshipTypes.has('CONTAINS_BOX')).toBe(true)
    expect(wl1.relationshipTypes.has('ASSIGNED_TO_TEAM')).toBe(true)
    expect(wl1.labels.has('ApiKey')).toBe(false)
  })
})

describe('sectionInputToDef', () => {
  it('normalises optional fields to null / []', () => {
    const def = sectionInputToDef(input({ groupByField: undefined, nodes: [{ id: 'n', entityType: 'Incident', neo4jLabel: 'Incident', label: 'x', isResult: true, isRoot: true, positionX: 1, positionY: 2 }] }), 'preview')
    expect(def.id).toBe('preview')
    expect(def.groupByField).toBeNull()
    expect(def.nodes[0]!.filters).toBeNull()
    expect(def.nodes[0]!.selectedFields).toEqual([])
  })
})
