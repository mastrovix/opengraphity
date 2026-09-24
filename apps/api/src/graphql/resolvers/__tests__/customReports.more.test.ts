/**
 * Custom report templates: loading, execution, schedule and AI proposal
 * (graphql/resolvers/customReports.ts), beyond the reachableEntities whitelist
 * and the section-persistence validation covered elsewhere.
 *
 * Why these behaviours matter:
 *  - a report template can hold private questions about the customer's data:
 *    reading, executing and re-scheduling one goes through the access check
 *    FIRST, and a refused check must stop the load, the execution and the write;
 *  - every read of the template, its teams and its author is matched on the
 *    caller's tenant;
 *  - the list query only returns templates the caller may see (public, own, or
 *    shared with one of their teams) — the visibility rule lives in the query;
 *  - scheduling defaults (PDF, no recipients) are what the scheduler relies on;
 *    null would make it skip or crash the run;
 *  - a section whose group node is not among its nodes must never be stored
 *    (it breaks the first Run), even if the upstream validator lets it through;
 *  - the AI proposal only fills the builder: it returns data, it never writes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { SectionInput } from '../customReports.js'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('../../../lib/navigableGraph.js', () => ({
  getNavigableEntities: vi.fn(),
  getNavigableRelations: vi.fn(),
}))
vi.mock('../../../lib/reportExecutor.js', () => ({ executeReportSection: vi.fn() }))
vi.mock('../../../lib/reportTemplates.js', () => ({ loadTemplateSections: vi.fn() }))
vi.mock('../reportAccess.js', () => ({ assertReportTemplateAccess: vi.fn() }))
vi.mock('../../../services/reportDesignerService.js', () => ({ proponiSezioneDiReport: vi.fn() }))
vi.mock('../../../lib/reportQueryBuilder.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/reportQueryBuilder.js')>()
  return { ...real, validateReportSection: vi.fn(real.validateReportSection) }
})

const { customReportResolvers, loadFullTemplate, createSectionWithNodesEdges, sectionInputToDef } = await import('../customReports.js')
const { getSession } = await import('@opengraphity/neo4j')
const { getNavigableEntities, getNavigableRelations } = await import('../../../lib/navigableGraph.js')
const { executeReportSection } = await import('../../../lib/reportExecutor.js')
const { loadTemplateSections } = await import('../../../lib/reportTemplates.js')
const { assertReportTemplateAccess } = await import('../reportAccess.js')
const { proponiSezioneDiReport } = await import('../../../services/reportDesignerService.js')
const { validateReportSection } = await import('../../../lib/reportQueryBuilder.js')

type Row = Record<string, unknown>
const result = (rows: Row[]) => ({ records: rows.map((r) => ({ get: (k: string) => r[k] })) })

/** A session whose reads and writes return the queued results, in order. */
function makeSession(reads: Row[][] = [], writes: Row[][] = []) {
  const readRun = vi.fn()
  const writeRun = vi.fn()
  let r = 0, w = 0
  return {
    readRun, writeRun,
    executeRead: vi.fn(async (fn: (tx: { run: typeof readRun }) => unknown) => {
      const rows = reads[r++] ?? []
      readRun.mockResolvedValueOnce(result(rows))
      return fn({ run: readRun })
    }),
    executeWrite: vi.fn(async (fn: (tx: { run: typeof writeRun }) => unknown) => {
      const rows = writes[w++] ?? []
      writeRun.mockResolvedValueOnce(result(rows))
      return fn({ run: writeRun })
    }),
    close: vi.fn(async () => {}),
  }
}

const ctx = { tenantId: 'tenant-1', userId: 'user-1', role: 'operator', permissions: new Set<string>() } as never
const TPL = { id: 'tpl-1', name: 'Open P1', visibility: 'all', created_at: '2026-09-01' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(assertReportTemplateAccess).mockResolvedValue({ createdBy: 'user-1', visibility: 'all', isOwner: true, isTeamMember: false })
  vi.mocked(loadTemplateSections).mockResolvedValue([])
})

describe('loadFullTemplate', () => {
  it('returns null for a template that is not in the tenant, without further reads', async () => {
    const s = makeSession([[]])
    vi.mocked(getSession).mockReturnValue(s as never)
    await expect(loadFullTemplate('tpl-x', 'tenant-1')).resolves.toBeNull()
    expect(s.readRun.mock.calls[0]![1]).toEqual({ id: 'tpl-x', tenantId: 'tenant-1' })
    expect(loadTemplateSections).not.toHaveBeenCalled()
    expect(s.close).toHaveBeenCalledTimes(1)
  })

  it('assembles template, sections, teams and author, all tenant-scoped, with safe defaults', async () => {
    const s = makeSession([
      [{ props: TPL }],
      [{ props: { id: 'team-1', name: 'NOC', extra: 1 } }],
      [{ props: { id: 'user-1', name: 'Ada', email: 'ada@example.com' } }],
    ])
    vi.mocked(getSession).mockReturnValue(s as never)
    const sections = [{ id: 'sec-1' }] as never
    vi.mocked(loadTemplateSections).mockResolvedValueOnce(sections)

    const out = await loadFullTemplate('tpl-1', 'tenant-1')
    expect(out).toEqual({
      id: 'tpl-1', name: 'Open P1', description: null, icon: null, visibility: 'all',
      // Absent schedule properties are "not scheduled", never undefined.
      scheduleEnabled: false, scheduleCron: null, scheduleChannelId: null, scheduleRecipients: [],
      scheduleFormat: null, lastScheduledRun: null, createdAt: '2026-09-01', updatedAt: null,
      sections, sharedWith: [{ id: 'team-1', name: 'NOC' }],
      createdBy: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
    })
    expect(loadTemplateSections).toHaveBeenCalledWith(s, 'tpl-1', 'tenant-1')
    for (const call of s.readRun.mock.calls) expect(call[1]).toEqual({ id: 'tpl-1', tenantId: 'tenant-1' })
  })

  it('a template whose author was removed has createdBy null', async () => {
    const s = makeSession([[{ props: { ...TPL, schedule_enabled: true, schedule_recipients: ['a@x'] } }], [], []])
    vi.mocked(getSession).mockReturnValue(s as never)
    const out = await loadFullTemplate('tpl-1', 'tenant-1')
    expect(out).toMatchObject({ createdBy: null, sharedWith: [], scheduleEnabled: true, scheduleRecipients: ['a@x'] })
  })
})

describe('Query.reportTemplates', () => {
  it('filters by visibility for the caller and loads each visible template', async () => {
    const list = makeSession([[{ props: { id: 'tpl-1' } }]])
    const full = makeSession([[{ props: TPL }], [], []])
    vi.mocked(getSession).mockReturnValueOnce(list as never).mockReturnValueOnce(full as never)
    const out = await customReportResolvers.Query.reportTemplates(null, null, ctx)
    const [cypher, params] = list.readRun.mock.calls[0]!
    expect(params).toEqual({ tenantId: 'tenant-1', userId: 'user-1' })
    // The visibility rule: public, own, or shared with one of the caller's teams.
    expect(cypher).toContain("r.visibility = 'all'")
    expect(cypher).toContain('r.created_by = $userId')
    expect(cypher).toContain("r.visibility = 'groups'")
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'tpl-1' })
    expect(list.close).toHaveBeenCalled()
  })
})

describe('Query.reportTemplate', () => {
  it('checks read access before loading', async () => {
    const access = makeSession()
    const full = makeSession([[{ props: TPL }], [], []])
    vi.mocked(getSession).mockReturnValueOnce(access as never).mockReturnValueOnce(full as never)
    await expect(customReportResolvers.Query.reportTemplate(null, { id: 'tpl-1' }, ctx)).resolves.toMatchObject({ id: 'tpl-1' })
    expect(assertReportTemplateAccess).toHaveBeenCalledWith(access, 'tpl-1', ctx, 'read')
  })

  it('a refused access loads nothing', async () => {
    const access = makeSession()
    vi.mocked(getSession).mockReturnValue(access as never)
    vi.mocked(assertReportTemplateAccess).mockRejectedValueOnce(new GraphQLError('Forbidden'))
    await expect(customReportResolvers.Query.reportTemplate(null, { id: 'tpl-1' }, ctx)).rejects.toThrow('Forbidden')
    expect(access.executeRead).not.toHaveBeenCalled()
    expect(access.close).toHaveBeenCalled()
  })
})

describe('Query.navigableEntities / navigableRelations', () => {
  it('are asked for the caller tenant', async () => {
    vi.mocked(getNavigableEntities).mockResolvedValueOnce([])
    vi.mocked(getNavigableRelations).mockResolvedValueOnce([])
    await customReportResolvers.Query.navigableEntities(null, null, ctx)
    await customReportResolvers.Query.navigableRelations(null, { entityType: 'Incident', neo4jLabel: 'Incident' }, ctx)
    expect(getNavigableEntities).toHaveBeenCalledWith('tenant-1')
    expect(getNavigableRelations).toHaveBeenCalledWith('Incident', 'Incident', 'tenant-1')
  })
})

describe('Query.reachableEntities', () => {
  it('rejects a syntactically invalid label before any lookup (Cypher injection guard)', async () => {
    await expect(customReportResolvers.Query.reachableEntities(null, { fromNeo4jLabel: 'Incident) DETACH DELETE (n' }, ctx))
      .rejects.toThrow('Invalid Neo4j label')
    expect(getNavigableEntities).not.toHaveBeenCalled()
  })

  it('rejects a well-formed label that is neither static nor in the metamodel', async () => {
    vi.mocked(getNavigableEntities).mockResolvedValueOnce([])
    await expect(customReportResolvers.Query.reachableEntities(null, { fromNeo4jLabel: 'SecretThing' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    expect(getSession).not.toHaveBeenCalled()
  })

  it('accepts a metamodel-only label and converts Neo4j integer counts', async () => {
    vi.mocked(getNavigableEntities).mockResolvedValue([
      { entityType: 'custom_box', label: 'Box', neo4jLabel: 'CustomBox', fields: [{ name: 'f' }], relations: [] },
      { entityType: 'server', label: 'Server', neo4jLabel: 'Server', fields: [], relations: [] },
    ] as never)
    const s = makeSession([
      // The kinds of link, discovered on the first nodes of the label…
      [
        { targetLabel: 'custom_box', relType: 'CONTAINS', direction: 'incoming' },
        { targetLabel: 'Server', relType: 'RUNS_ON', direction: 'outgoing' },
        { targetLabel: null, relType: 'X', direction: 'outgoing' },
        // A technical node the builder cannot describe is not offered, nor counted.
        { targetLabel: 'ChangeAuditEntry', relType: 'HAS_AUDIT', direction: 'outgoing' },
      ],
      // …then only the offered ones counted, exactly, in that order.
      [{ cnt: 2 }],
      [{ cnt: { toNumber: () => 4 } }],
    ])
    vi.mocked(getSession).mockReturnValue(s as never)
    const out = await customReportResolvers.Query.reachableEntities(null, { fromNeo4jLabel: 'CustomBox' }, ctx)
    expect(out).toEqual([
      { entityType: 'server', label: 'Server', neo4jLabel: 'Server', fields: [], relationshipType: 'RUNS_ON', direction: 'outgoing', count: 4 },
      { entityType: 'custom_box', label: 'Box', neo4jLabel: 'CustomBox', fields: [{ name: 'f' }], relationshipType: 'CONTAINS', direction: 'incoming', count: 2 },
    ])
    // Review of 23 Sep 2026: the discovery reads a sample, and each count has its typed pattern.
    expect(s.readRun.mock.calls[0]![1]).toEqual({ tenantId: 'tenant-1', sample: 1_000 })
    expect(s.readRun.mock.calls[0]![0]).toContain('WITH n LIMIT toInteger($sample)')
    expect(s.readRun.mock.calls).toHaveLength(3)
    expect(s.readRun.mock.calls[1]![0]).toContain('MATCH (n:CustomBox {tenant_id: $tenantId})<-[:CONTAINS]-(d:custom_box)')
    expect(s.readRun.mock.calls[2]![0]).toContain('MATCH (n:CustomBox {tenant_id: $tenantId})-[:RUNS_ON]->(d:Server)')
  })
})

describe('Query.executeReport', () => {
  it('checks access, then runs every section for the tenant in the viewer language', async () => {
    const access = makeSession()
    const full = makeSession([[{ props: TPL }], [], []])
    vi.mocked(getSession).mockReturnValueOnce(access as never).mockReturnValueOnce(full as never)
    const sections = [{ id: 's1' }, { id: 's2' }] as never[]
    vi.mocked(loadTemplateSections).mockResolvedValueOnce(sections as never)
    vi.mocked(executeReportSection).mockImplementation(async (sec) => ({ sectionId: (sec as { id: string }).id }) as never)
    const out = await customReportResolvers.Query.executeReport(null, { templateId: 'tpl-1', language: 'en' }, ctx)
    expect(out).toEqual({ sections: [{ sectionId: 's1' }, { sectionId: 's2' }] })
    expect(assertReportTemplateAccess).toHaveBeenCalledWith(access, 'tpl-1', ctx, 'read')
    // With the viewer's permissions: a section on data their role cannot read is refused (review of 23 Sep 2026).
    expect(executeReportSection).toHaveBeenCalledWith(sections[0], 'tenant-1', { language: 'en', permissions: ctx.permissions })
  })

  it('an unknown language is refused before touching the template', async () => {
    await expect(customReportResolvers.Query.executeReport(null, { templateId: 'tpl-1', language: 'xx' }, ctx))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.enum.unknownLanguage' } } })
    expect(getSession).not.toHaveBeenCalled()
  })

  it('a template that vanished after the access check is not found', async () => {
    const access = makeSession()
    const full = makeSession([[]])
    vi.mocked(getSession).mockReturnValueOnce(access as never).mockReturnValueOnce(full as never)
    await expect(customReportResolvers.Query.executeReport(null, { templateId: 'tpl-1' }, ctx)).rejects.toThrow(/ReportTemplate/)
    expect(executeReportSection).not.toHaveBeenCalled()
  })
})

describe('Query.previewReportSection', () => {
  it('runs the unsaved section for the caller tenant, with the tenant language when none is given', async () => {
    vi.mocked(executeReportSection).mockResolvedValueOnce({ sectionId: 'preview' } as never)
    const input: SectionInput = { title: 'T', chartType: 'kpi', metric: 'count', nodes: [], edges: [] }
    await expect(customReportResolvers.Query.previewReportSection(null, { input }, ctx)).resolves.toEqual({ sectionId: 'preview' })
    expect(executeReportSection).toHaveBeenCalledWith(sectionInputToDef(input, 'preview'), 'tenant-1', { language: undefined, permissions: ctx.permissions })
  })
})

describe('sectionInputToDef', () => {
  it('fills every optional field with null (never undefined) and tolerates missing lists', () => {
    const def = sectionInputToDef({ title: 'T', chartType: 'bar', metric: 'count' } as unknown as SectionInput, 'id-1', 3)
    expect(def).toEqual({
      id: 'id-1', order: 3, title: 'T', chartType: 'bar', groupByNodeId: null, groupByField: null, groupByGranularity: null,
      metric: 'count', metricField: null, limit: null, sortDir: null, nodes: [], edges: [],
    })
  })
})

describe('createSectionWithNodesEdges', () => {
  const node = { id: 'node_1', entityType: 'Incident', neo4jLabel: 'Incident', label: 'Incident', isResult: true, isRoot: true, positionX: 1, positionY: 2 }

  it('inside a caller transaction every write joins that transaction', async () => {
    vi.mocked(validateReportSection).mockImplementationOnce(() => {})
    const tx = { run: vi.fn(async () => result([])) }
    await createSectionWithNodesEdges(tx as never, 'tpl-1', 'sec-1', 0, {
      title: 'T', chartType: 'bar', metric: 'count', groupByNodeId: 'node_1', groupByField: 'status', nodes: [node], edges: [],
    }, 'tenant-1')
    // Section + one node, both through tx.run (atomic duplicate).
    expect(tx.run).toHaveBeenCalledTimes(2)
    const sectionParams = (tx.run.mock.calls[0] as unknown[])[1] as Record<string, unknown>
    const nodeParams = (tx.run.mock.calls[1] as unknown[])[1] as Record<string, unknown>
    // The group node is stored under the node's definitive id, not the client one.
    expect(sectionParams['groupByNodeId']).toBe(nodeParams['id'])
    expect(nodeParams).toMatchObject({ tempId: 'node_1', tenantId: 'tenant-1', filters: null, selectedFields: '[]' })
  })

  it('with a plain session each write is its own transaction, and edges link the client ids in the tenant', async () => {
    vi.mocked(validateReportSection).mockImplementationOnce(() => {})
    const s = makeSession()
    await createSectionWithNodesEdges(s as never, 'tpl-1', 'sec-1', 1, {
      title: 'T', chartType: 'bar', metric: 'count',
      nodes: [node, { ...node, id: 'node_2', isRoot: false, filters: '{"a":1}', selectedFields: ['title'] }],
      edges: [{ id: 'e1', sourceNodeId: 'node_1', targetNodeId: 'node_2', relationshipType: 'AFFECTED_BY', direction: 'outgoing', label: 'affects' }],
    }, 'tenant-1')
    // Section + 2 nodes + 1 edge.
    expect(s.executeWrite).toHaveBeenCalledTimes(4)
    expect(s.writeRun.mock.calls[2]![1]).toMatchObject({ filters: '{"a":1}', selectedFields: '["title"]' })
    const [edgeCypher, edgeParams] = s.writeRun.mock.calls[3]!
    // Edges match both endpoints within the tenant (A-20), by the client (temp) id.
    expect(edgeCypher).toMatch(/src:ReportNode \{temp_id: \$sourceTempId, section_id: \$sectionId, tenant_id: \$tenantId\}/)
    expect(edgeParams).toEqual({ sectionId: 'sec-1', tenantId: 'tenant-1', sourceTempId: 'node_1', targetTempId: 'node_2', relType: 'AFFECTED_BY', direction: 'outgoing', label: 'affects' })
  })

  it('refuses a group node that is not one of the section nodes, before writing', async () => {
    // Defence in depth: even if the validator let it through, the section is not stored.
    vi.mocked(validateReportSection).mockImplementationOnce(() => {})
    const tx = { run: vi.fn() }
    await expect(createSectionWithNodesEdges(tx as never, 'tpl-1', 'sec-1', 0, {
      title: 'T', chartType: 'bar', metric: 'count', groupByNodeId: 'ghost', nodes: [node], edges: [],
    }, 'tenant-1')).rejects.toThrow(/groupByNodeId "ghost" is not one of the section nodes/)
    expect(tx.run).not.toHaveBeenCalled()
  })
})

describe('Mutation.updateReportSchedule', () => {
  it('requires write access and stores the scheduler defaults', async () => {
    const s = makeSession([], [[{ p: { ...TPL, schedule_enabled: true, schedule_format: 'pdf', schedule_recipients: [] } }]])
    vi.mocked(getSession).mockReturnValue(s as never)
    const out = await customReportResolvers.Mutation.updateReportSchedule(null, { templateId: 'tpl-1', enabled: true }, ctx)
    expect(assertReportTemplateAccess).toHaveBeenCalledWith(s, 'tpl-1', ctx, 'write')
    expect(getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(s.writeRun.mock.calls[0]![1]).toMatchObject({ id: 'tpl-1', tenantId: 'tenant-1', enabled: true, cron: null, recipients: [], format: 'pdf' })
    expect(out).toMatchObject({ id: 'tpl-1', scheduleEnabled: true, scheduleFormat: 'pdf' })
  })

  it('keeps the values the caller chose', async () => {
    const s = makeSession([], [[{ p: TPL }]])
    vi.mocked(getSession).mockReturnValue(s as never)
    await customReportResolvers.Mutation.updateReportSchedule(null, { templateId: 'tpl-1', enabled: true, cron: '0 8 * * 1', recipients: ['a@x'], format: 'xlsx' }, ctx)
    expect(s.writeRun.mock.calls[0]![1]).toMatchObject({ cron: '0 8 * * 1', recipients: ['a@x'], format: 'xlsx' })
  })

  it('a refused access writes nothing', async () => {
    const s = makeSession()
    vi.mocked(getSession).mockReturnValue(s as never)
    vi.mocked(assertReportTemplateAccess).mockRejectedValueOnce(new GraphQLError('Forbidden'))
    await expect(customReportResolvers.Mutation.updateReportSchedule(null, { templateId: 'tpl-1', enabled: false }, ctx)).rejects.toThrow('Forbidden')
    expect(s.executeWrite).not.toHaveBeenCalled()
    expect(s.close).toHaveBeenCalled()
  })

  it('a template that disappeared is not found', async () => {
    const s = makeSession([], [[]])
    vi.mocked(getSession).mockReturnValue(s as never)
    await expect(customReportResolvers.Mutation.updateReportSchedule(null, { templateId: 'tpl-1', enabled: false }, ctx)).rejects.toThrow(/ReportTemplate/)
  })
})

describe('Mutation.proposeReportSection', () => {
  it('asks the designer for the caller tenant and returns the proposal without writing', async () => {
    vi.mocked(proponiSezioneDiReport).mockResolvedValueOnce({
      prompt: 'P1 by team', title: 'P1 by team', chartType: 'bar', metric: 'count', metricField: null,
      groupByNodeId: 'n1', groupByField: 'team', groupByGranularity: null, limit: 10, sortDir: 'desc',
      nodes: [], edges: [], why: 'because',
      scartati: [{ what: 'Unicorn', key: 'reportProposal.discard.entityUnknown', params: { name: 'Unicorn' } }],
      note: ['n'],
    } as never)
    const out = await customReportResolvers.Mutation.proposeReportSection(null, { prompt: 'P1 by team' }, ctx)
    expect(proponiSezioneDiReport).toHaveBeenCalledWith({ tenantId: 'tenant-1', prompt: 'P1 by team' })
    // Open-ended params travel as JSON strings.
    expect(out.discarded).toEqual([{ what: 'Unicorn', key: 'reportProposal.discard.entityUnknown', params: '{"name":"Unicorn"}' }])
    expect(out).toMatchObject({ title: 'P1 by team', groupByField: 'team', limit: 10, why: 'because', notes: ['n'] })
    expect(getSession).not.toHaveBeenCalled()
  })
})
