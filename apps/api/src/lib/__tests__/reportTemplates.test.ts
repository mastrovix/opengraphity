import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'path'
import os from 'os'
import { GraphQLError } from 'graphql'

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('../../lib/reportExecutor.js', () => ({
  executeReportSection: vi.fn().mockResolvedValue({ sectionId: 's1', title: 'T', chartType: 'kpi', data: '{"value":1}', total: 1, error: null }),
}))
vi.mock('../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../graphql/resolvers/reportAccess.js', () => ({
  assertReportTemplateAccess: vi.fn().mockResolvedValue({}),
  assertDashboardAccess: vi.fn().mockResolvedValue({}),
}))

// reportExport creates REPORT_DIR at import time: keep test artefacts out of the repo.
process.env['REPORT_DIR'] = path.join(os.tmpdir(), 'opengraphity-reports-test')

const { mapSection, mapNode, mapEdge, parseSelectedFields, loadTemplateSections, loadSectionById } = await import('../reportTemplates.js')
const { executeReportSection } = await import('../../lib/reportExecutor.js')
const { getSession } = await import('@opengraphity/neo4j')

// ── Fixtures: what Neo4j returns for the single loader query ──────────────────

const SECTION_PROPS = {
  id: 's1', order: { toNumber: () => 2 }, title: 'Incidenti per team', chart_type: 'table',
  group_by_node_id: null, group_by_field: null, metric: 'count', metric_field: null,
  limit_val: 50, sort_dir: 'ASC',
}
const NODE_ROOT = {
  id: 'n-root', entity_type: 'Incident', neo4jLabel: undefined, neo4j_label: 'Incident', label: 'Incident',
  is_result: true, is_root: true, position_x: 10, position_y: 20, filters: null,
  selected_fields: JSON.stringify(['title', 'status']),
}
const NODE_TEAM = {
  id: 'n-team', entity_type: 'Team', neo4j_label: 'Team', label: 'Team',
  is_result: true, is_root: false, position_x: 0, position_y: 0, filters: null,
  selected_fields: JSON.stringify(['name']),
}
const EDGE = { edgeProps: { id: 'e1', relationship_type: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: '→ ASSIGNED_TO_TEAM' }, sourceId: 'n-root', targetId: 'n-team' }

function loaderRow(section = SECTION_PROPS, nodes: unknown[] = [NODE_ROOT, NODE_TEAM], edges: unknown[] = [EDGE]) {
  const row: Record<string, unknown> = { section, nodes, edges }
  return { get: (k: string) => row[k] }
}

/** Fake session dispatching on the Cypher text. */
function fakeSession(dispatch: (query: string, params: Record<string, unknown>) => unknown[]) {
  const run = vi.fn().mockImplementation((query: string, params: Record<string, unknown>) =>
    Promise.resolve({ records: dispatch(query, params) }))
  return {
    run,
    executeRead:  vi.fn().mockImplementation((fn: (tx: { run: typeof run }) => unknown) => fn({ run })),
    executeWrite: vi.fn().mockImplementation((fn: (tx: { run: typeof run }) => unknown) => fn({ run })),
    close:        vi.fn().mockResolvedValue(undefined),
  }
}

// ── Mappers ────────────────────────────────────────────────────────────────────

describe('reportTemplates mappers — one semantics for every consumer', () => {
  it('mapSection reads limit_val (not `limit`), converts Neo4j Integers, defaults metric', () => {
    const s = mapSection(SECTION_PROPS)
    expect(s).toMatchObject({ id: 's1', order: 2, limit: 50, sortDir: 'ASC', chartType: 'table', metric: 'count', nodes: [], edges: [] })
    expect(mapSection({ ...SECTION_PROPS, limit_val: { toNumber: () => 7 } }).limit).toBe(7)
    expect(mapSection({ ...SECTION_PROPS, limit_val: null, metric: undefined }).limit).toBeNull()
    expect(mapSection({ ...SECTION_PROPS, metric: undefined }).metric).toBe('count')
  })

  it('mapNode parses selected_fields from the persisted JSON string', () => {
    const n = mapNode(NODE_ROOT)
    expect(n.selectedFields).toEqual(['title', 'status'])
    expect(n).toMatchObject({ id: 'n-root', neo4jLabel: 'Incident', isRoot: true, isResult: true, positionX: 10, positionY: 20, filters: null })
  })

  it('mapNode: is_result/is_root are strict booleans (missing → false)', () => {
    const n = mapNode({ ...NODE_ROOT, is_result: undefined, is_root: 'true' })
    expect(n.isResult).toBe(false)
    expect(n.isRoot).toBe(false)
  })

  it('parseSelectedFields: null/empty → [], native list accepted, corrupt JSON throws BAD_USER_INPUT', () => {
    expect(parseSelectedFields(null, 'x')).toEqual([])
    expect(parseSelectedFields('', 'x')).toEqual([])
    expect(parseSelectedFields(['a', 'b'], 'x')).toEqual(['a', 'b'])
    let thrown: unknown
    try { parseSelectedFields('["a"', 'node n1') } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(GraphQLError)
    expect((thrown as GraphQLError).extensions?.code).toBe('BAD_USER_INPUT')
    expect((thrown as GraphQLError).message).toContain('node n1')
    expect(() => parseSelectedFields('{"a":1}', 'x')).toThrow('must be a JSON array')
  })

  it('mapEdge keeps source/target as given and defaults label', () => {
    expect(mapEdge({ id: 'e', relationship_type: 'R', direction: 'incoming' }, 'a', 'b'))
      .toEqual({ id: 'e', sourceNodeId: 'a', targetNodeId: 'b', relationshipType: 'R', direction: 'incoming', label: '' })
  })
})

// ── Loaders ────────────────────────────────────────────────────────────────────

describe('loadTemplateSections / loadSectionById', () => {
  it('loadTemplateSections: one tenant-scoped query, sections carry nodes AND edges', async () => {
    const session = fakeSession(() => [loaderRow()])
    const sections = await loadTemplateSections(session as never, 'tpl-1', 'tenant-1')

    expect(session.run).toHaveBeenCalledTimes(1)
    const [query, params] = session.run.mock.calls[0]! as [string, Record<string, unknown>]
    expect(query).toContain('ReportTemplate {id: $templateId, tenant_id: $tenantId}')
    expect(params).toEqual({ templateId: 'tpl-1', tenantId: 'tenant-1' })

    expect(sections).toHaveLength(1)
    const s = sections[0]!
    expect(s.limit).toBe(50)
    expect(s.nodes.map(n => n.id)).toEqual(['n-root', 'n-team'])
    expect(s.nodes[0]!.selectedFields).toEqual(['title', 'status'])
    expect(s.edges).toEqual([{ id: 'e1', sourceNodeId: 'n-root', targetNodeId: 'n-team', relationshipType: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: '→ ASSIGNED_TO_TEAM' }])
  })

  it('drops null placeholders produced by OPTIONAL MATCH (section without nodes/edges)', async () => {
    const session = fakeSession(() => [loaderRow(SECTION_PROPS, [null], [null, { edgeProps: {}, sourceId: null, targetId: null }])])
    const [s] = await loadTemplateSections(session as never, 'tpl-1', 't')
    expect(s!.nodes).toEqual([])
    expect(s!.edges).toEqual([])
  })

  it('loadSectionById reaches the section THROUGH its tenant template; null when absent', async () => {
    const session = fakeSession((q, p) => (q.includes('ReportSection {id: $sectionId}') && p['tenantId'] === 't1' ? [loaderRow()] : []))
    const s = await loadSectionById(session as never, 's1', 't1')
    expect(s?.id).toBe('s1')
    expect(s?.nodes).toHaveLength(2)
    const [query] = session.run.mock.calls[0]! as [string]
    expect(query).toContain('ReportTemplate {tenant_id: $tenantId}')
    expect(await loadSectionById(session as never, 's1', 'other-tenant')).toBeNull()
  })

  it('accepts a ManagedTransaction (no executeRead) and runs on it directly', async () => {
    const run = vi.fn().mockResolvedValue({ records: [loaderRow()] })
    const sections = await loadTemplateSections({ run } as never, 'tpl-1', 't')
    expect(run).toHaveBeenCalledTimes(1)
    expect(sections[0]!.edges).toHaveLength(1)
  })
})

// ── Consumers: export and dashboard widgets now get nodes/edges (C-04, C-05) ──

describe('consumers of the single loader', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reportExport.loadTemplateForExport returns sections with nodes/edges (previously nodes: [], edges: [] → "No root node found")', async () => {
    const session = fakeSession((q) => {
      if (q.includes('RETURN r.name AS name')) return [{ get: () => 'Il mio report' }]
      if (q.includes('HAS_SECTION')) return [loaderRow()]
      return []
    })
    vi.mocked(getSession).mockReturnValue(session as never)

    const { loadTemplateForExport } = await import('../../graphql/resolvers/reportExport.js')
    const tpl = await loadTemplateForExport('tpl-1', 'tenant-1')

    expect(tpl?.name).toBe('Il mio report')
    expect(tpl?.sections[0]?.nodes.filter(n => n.isRoot)).toHaveLength(1)
    expect(tpl?.sections[0]?.edges).toHaveLength(1)
    expect(session.close).toHaveBeenCalled()
  })

  it('dashboard widgetData executes the section loaded with parsed selectedFields, limit_val and edges', async () => {
    const session = fakeSession((q) => (q.includes('ReportSection {id: $sectionId}') ? [loaderRow()] : []))
    vi.mocked(getSession).mockReturnValue(session as never)

    const { widgetData, widgetError } = await import('../../graphql/resolvers/dashboard/dashboardQueries.js')
    const parent = { reportSectionId: 's1' }
    const ctx = { tenantId: 'tenant-1', userId: 'u1', userEmail: 'u@x', role: 'operator' } as never

    const data  = await widgetData(parent, {}, ctx)
    const error = await widgetError(parent, {}, ctx)

    expect(error).toBeNull()
    expect(data).toBe('{"value":1}')
    expect(executeReportSection).toHaveBeenCalledTimes(1)  // memoised across data/error
    const [section, tenantId] = vi.mocked(executeReportSection).mock.calls[0]!
    expect(tenantId).toBe('tenant-1')
    expect(section.limit).toBe(50)
    expect(section.nodes[0]!.selectedFields).toEqual(['title', 'status'])  // not a char-iterated JSON string
    expect(section.edges).toHaveLength(1)
  })

  it('dashboard widget of a section outside the tenant → "Sezione non trovata"', async () => {
    const session = fakeSession(() => [])
    vi.mocked(getSession).mockReturnValue(session as never)
    const { widgetError } = await import('../../graphql/resolvers/dashboard/dashboardQueries.js')
    expect(await widgetError({ reportSectionId: 'ghost' }, {}, { tenantId: 't', userId: 'u', userEmail: 'e', role: 'admin' } as never)).toBe('Sezione non trovata')
    expect(executeReportSection).not.toHaveBeenCalled()
  })
})
