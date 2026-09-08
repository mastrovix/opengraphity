import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
  // Stub of the real helper (D-22): plain numbers and Integer-like objects.
  toNumber: (v: unknown) => (v == null ? 0 : typeof v === 'object' && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : Number(v)),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../../lib/reportExecutor.js', () => ({ executeReportSection: vi.fn() }))
vi.mock('../../../lib/navigableGraph.js', () => ({
  getNavigableEntities: vi.fn().mockResolvedValue([]),
  getNavigableRelations: vi.fn().mockResolvedValue([]),
}))
vi.mock('../reportAccess.js', () => ({
  assertReportTemplateAccess: vi.fn().mockResolvedValue({}),
}))

const { Mutation } = await import('../reportMutations.js')
const { getSession } = await import('@opengraphity/neo4j')
const { assertReportTemplateAccess } = await import('../reportAccess.js')

const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator' }

const SRC_SECTION = {
  id: 'sec-old', order: 3, title: 'Per team', chart_type: 'bar', group_by_node_id: 'n-team', group_by_field: 'name',
  metric: 'count', metric_field: null, limit_val: 5, sort_dir: 'DESC',
}
const NODES = [
  { id: 'n-root', entity_type: 'Incident', neo4j_label: 'Incident', label: 'Incident', is_result: true, is_root: true, position_x: 1, position_y: 2, filters: null, selected_fields: '[]' },
  { id: 'n-team', entity_type: 'Team', neo4j_label: 'Team', label: 'Team', is_result: true, is_root: false, position_x: 3, position_y: 4, filters: null, selected_fields: '[]' },
]
const EDGES = [{ edgeProps: { id: 'e-old', relationship_type: 'ASSIGNED_TO_TEAM', direction: 'outgoing', label: '→ ASSIGNED_TO_TEAM' }, sourceId: 'n-root', targetId: 'n-team' }]

function fakeSession() {
  const calls: Array<{ q: string; p: Record<string, unknown>; inTx: boolean }> = []
  let inTx = false
  const run = vi.fn().mockImplementation(async (q: string, p: Record<string, unknown>) => {
    calls.push({ q, p, inTx })
    if (q.includes('HAS_SECTION]->(s:ReportSection)') && q.includes('collect(DISTINCT')) {
      const row: Record<string, unknown> = { section: SRC_SECTION, nodes: NODES, edges: EDGES }
      return { records: [{ get: (k: string) => row[k] }] }
    }
    if (q.includes('CREATE (r:ReportTemplate')) return { records: [{ get: () => 'new' }] }
    if (q.includes('RETURN properties(r) AS props')) {
      return { records: [{ get: () => ({ id: p['id'], name: 'X (copia)', visibility: 'private', created_at: 'now' }) }] }
    }
    return { records: [] }
  })
  const s = {
    calls,
    executeRead:  vi.fn().mockImplementation((fn: (tx: { run: typeof run }) => unknown) => fn({ run })),
    executeWrite: vi.fn().mockImplementation(async (fn: (tx: { run: typeof run }) => unknown) => {
      inTx = true
      try { return await fn({ run }) } finally { inTx = false }
    }),
    close: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(getSession).mockReturnValue(s as never)
  return s
}

describe('duplicateReportTemplate (F-07)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('clones template + sections + nodes + edges with new ids inside ONE executeWrite, as a private copy', async () => {
    const s = fakeSession()
    const out = await Mutation.duplicateReportTemplate(null, { id: 'tpl-src' }, ctx)

    expect(assertReportTemplateAccess).toHaveBeenCalledWith(expect.anything(), 'tpl-src', ctx, 'read')
    expect(out?.name).toBe('X (copia)')

    // Exactly one write transaction for the whole clone
    expect(s.executeWrite).toHaveBeenCalledTimes(1)

    const txCalls = s.calls.filter(c => c.inTx)
    const tplCreate = txCalls.find(c => c.q.includes('CREATE (r:ReportTemplate'))!
    expect(tplCreate.q).toContain("visibility:          'private'")
    expect(tplCreate.q).toContain('schedule_enabled:    false')
    expect(tplCreate.p).toMatchObject({ srcId: 'tpl-src', tenantId: 't1', userId: 'u1', name: null })
    const newId = tplCreate.p['newId'] as string
    expect(newId).not.toBe('tpl-src')

    const secCreate = txCalls.find(c => c.q.includes('CREATE (s:ReportSection'))!
    expect(secCreate.p).toMatchObject({ templateId: newId, order: 3, title: 'Per team', chartType: 'bar', groupByField: 'name', limit: 5, sortDir: 'DESC' })
    expect(secCreate.p['id']).not.toBe('sec-old')

    const nodeCreates = txCalls.filter(c => c.q.includes('CREATE (s)-[:HAS_NODE]->(n:ReportNode'))
    expect(nodeCreates.map(c => c.p['tempId'])).toEqual(['n-root', 'n-team'])   // old ids become temp_id
    for (const c of nodeCreates) {
      expect(c.p['id']).not.toBe(c.p['tempId'])
      expect(c.p['sectionId']).toBe(secCreate.p['id'])
    }

    const edgeCreates = txCalls.filter(c => c.q.includes('CREATE (src)-[:REPORT_EDGE'))
    expect(edgeCreates).toHaveLength(1)
    expect(edgeCreates[0]!.p).toMatchObject({ sourceTempId: 'n-root', targetTempId: 'n-team', relType: 'ASSIGNED_TO_TEAM', direction: 'outgoing' })
  })

  it('custom name overrides the "(copia)" default', async () => {
    const s = fakeSession()
    await Mutation.duplicateReportTemplate(null, { id: 'tpl-src', name: 'Copia mia' }, ctx)
    const tplCreate = s.calls.find(c => c.q.includes('CREATE (r:ReportTemplate'))!
    expect(tplCreate.p['name']).toBe('Copia mia')
    expect(tplCreate.q).toContain("coalesce($name, src.name + ' (copia)')")
  })
})
