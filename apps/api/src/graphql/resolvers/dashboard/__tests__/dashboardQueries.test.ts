/**
 * dashboardQueries.ts — reading dashboards and their widgets.
 *
 * Why these behaviours matter for a user:
 *   - a dashboard is visible to its owner, to everyone (`all`) or to the teams
 *     it is shared with — and only inside the caller's tenant. A query that
 *     lost the tenant or the visibility clause would show someone else's
 *     private dashboard;
 *   - the home page picks "my dashboard" by a precise precedence (default for
 *     my role → default for any role → my first personal one → none); a
 *     wrong order shows the wrong home page to a whole role;
 *   - a widget whose report fails must SAY why (the error field), and the
 *     data/error fields must run the report once, not twice per widget.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../../context.js'
import { perms } from '../../../../lib/__tests__/testPermissions.js'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('../helpers.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../helpers.js')>()
  return { ...orig, loadReportSection: vi.fn() }
})
vi.mock('../../../../lib/reportExecutor.js', () => ({ executeReportSection: vi.fn() }))

const Q = await import('../dashboardQueries.js')
const { getSession } = await import('@opengraphity/neo4j')
const { loadReportSection } = await import('../helpers.js')
const { executeReportSection } = await import('../../../../lib/reportExecutor.js')

const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') }

type Row = Record<string, unknown>
/** A session whose reads answer, in order, with the given row sets; every call is recorded. */
function fakeSession(...answers: Row[][]) {
  const calls: Array<{ q: string; p: Record<string, unknown> }> = []
  let i = 0
  const run = vi.fn(async (q: string, p: Record<string, unknown>) => {
    calls.push({ q, p })
    const rows = answers[i++] ?? []
    return { records: rows.map((r) => ({ get: (k: string) => r[k] })) }
  })
  const s = {
    calls,
    executeRead: vi.fn((fn: (tx: { run: typeof run }) => unknown) => fn({ run })),
    close: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(getSession).mockReturnValue(s as never)
  return s
}

const DASH = { id: 'd1', name: 'Ops', visibility: 'teams', created_at: '2026-01-01' }

beforeEach(() => vi.clearAllMocks())

describe('myDashboards / dashboard — tenant and visibility in the query', () => {
  it('myDashboards returns the mapped dashboards the caller can see', async () => {
    const s = fakeSession([{ props: DASH }, { props: { ...DASH, id: 'd2', visibility: undefined } }])
    const out = await Q.myDashboards(null, null, ctx)
    expect(out.map((d) => d.id)).toEqual(['d1', 'd2'])
    // A dashboard without visibility is private, never "all".
    expect(out[1]!.visibility).toBe('private')
    const { q, p } = s.calls[0]!
    expect(q).toContain('d.tenant_id = $tenantId')
    expect(q).toContain("d.visibility = 'all'")
    expect(q).toContain('[:SHARED_WITH]->(t:Team)<-[:MEMBER_OF]-(u:User {id: $userId})')
    expect(p).toEqual({ tenantId: 't1', userId: 'u1' })
    expect(s.close).toHaveBeenCalled()
  })

  it('dashboard(id): found → mapped; not visible / other tenant → null', async () => {
    const s = fakeSession([{ props: DASH }])
    await expect(Q.dashboard(null, { id: 'd1' }, ctx)).resolves.toMatchObject({ id: 'd1', name: 'Ops' })
    expect(s.calls[0]!.p).toEqual({ id: 'd1', tenantId: 't1', userId: 'u1' })
    expect(s.calls[0]!.q).toContain('d.user_id = $userId')

    fakeSession([])
    await expect(Q.dashboard(null, { id: 'dX' }, ctx)).resolves.toBeNull()
  })
})

describe('myDashboard — home page precedence', () => {
  it('1. the default dashboard for my role wins, and nothing else is queried', async () => {
    const s = fakeSession([{ props: { ...DASH, id: 'role-default' } }])
    await expect(Q.myDashboard(null, null, ctx)).resolves.toMatchObject({ id: 'role-default' })
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]!.p).toEqual({ tenantId: 't1', role: 'operator', userId: 'u1' })
  })

  it('2. else the default with no role restriction', async () => {
    const s = fakeSession([], [{ props: { ...DASH, id: 'any-default' } }])
    await expect(Q.myDashboard(null, null, ctx)).resolves.toMatchObject({ id: 'any-default' })
    expect(s.calls[1]!.q).toContain('d.role IS NULL')
    expect(s.calls).toHaveLength(2)
  })

  it('3. else my first personal dashboard', async () => {
    const s = fakeSession([], [], [{ props: { ...DASH, id: 'mine' } }])
    await expect(Q.myDashboard(null, null, ctx)).resolves.toMatchObject({ id: 'mine' })
    expect(s.calls[2]!.q).toContain('ORDER BY d.created_at ASC')
    expect(s.calls[2]!.p).toEqual({ tenantId: 't1', userId: 'u1' })
  })

  it('4. none at all → null (the page shows its empty state)', async () => {
    fakeSession([], [], [])
    await expect(Q.myDashboard(null, null, ctx)).resolves.toBeNull()
  })
})

describe('DashboardConfig field resolvers', () => {
  it('widgets: ordered, mapped with defaults, session closed', async () => {
    const s = fakeSession([
      { w: { id: 'w1', order: 0, col_span: 6, report_template_id: 'rt', report_section_id: 'rs' } },
      { w: { id: 'w2' } },
    ])
    const out = await Q.dashboardWidgets({ id: 'd1' }, null, ctx)
    expect(out[0]).toMatchObject({ id: 'w1', colSpan: 6, reportSectionId: 'rs' })
    // A widget saved without size/order gets the default 4 columns, first place.
    expect(out[1]).toMatchObject({ id: 'w2', order: 0, colSpan: 4 })
    expect(s.calls[0]!.p).toEqual({ id: 'd1', tenantId: 't1' })
    expect(s.close).toHaveBeenCalled()
  })

  it('widgets: the session is closed even when the read fails', async () => {
    const s = fakeSession()
    s.executeRead.mockRejectedValueOnce(new Error('db down'))
    await expect(Q.dashboardWidgets({ id: 'd1' }, null, ctx)).rejects.toThrow('db down')
    expect(s.close).toHaveBeenCalled()
  })

  it('createdBy: mapped user, or null when the author is gone', async () => {
    const s = fakeSession([{ u: { id: 'u9', tenant_id: 't1', email: 'x@y', role: 'admin', created_at: 'x' } }])
    await expect(Q.dashboardCreatedBy({ id: 'd1' }, null, ctx)).resolves.toMatchObject({ id: 'u9', tenantId: 't1' })
    expect(s.calls[0]!.p).toEqual({ id: 'd1', tenantId: 't1' })
    fakeSession([])
    await expect(Q.dashboardCreatedBy({ id: 'd1' }, null, ctx)).resolves.toBeNull()
  })

  it('sharedWith: mapped teams', async () => {
    fakeSession([{ t: { id: 'team-1', tenant_id: 't1', name: 'Net', created_at: 'x' } }])
    await expect(Q.dashboardSharedWith({ id: 'd1' }, null, ctx)).resolves.toEqual([
      expect.objectContaining({ id: 'team-1', name: 'Net' }),
    ])
  })

  it('customWidgets: full mapping, and defaults for the optional fields', async () => {
    const s = fakeSession([
      { w: { id: 'c1', title: 'Open', widget_type: 'counter', entity_type: 'incident', metric: 'count',
        group_by_field: 'status', filter_field: 'priority', filter_value: 'high', time_range: '7d',
        size: 'large', color: '#111111', position: 2.4, dashboard_id: 'd1' } },
      { w: { id: 'c2', title: 'Bare', widget_type: 'chart', entity_type: 'change', metric: 'count', dashboard_id: 'd1' } },
    ])
    const out = await Q.dashboardCustomWidgets({ id: 'd1' }, null, ctx)
    expect(out[0]).toEqual({
      id: 'c1', title: 'Open', widgetType: 'counter', entityType: 'incident', metric: 'count',
      groupByField: 'status', filterField: 'priority', filterValue: 'high', timeRange: '7d',
      size: 'large', color: '#111111', position: 2, dashboardId: 'd1',
    })
    expect(out[1]).toMatchObject({ groupByField: null, filterField: null, filterValue: null, timeRange: null, size: 'medium', color: '#0EA5E9', position: 0 })
    expect(s.calls[0]!.p).toEqual({ id: 'd1', tenantId: 't1' })
    expect(s.close).toHaveBeenCalled()
  })
})

describe('DashboardWidget field resolvers', () => {
  it('reportTemplate: null without id (no query), null when missing, mapped otherwise', async () => {
    await expect(Q.widgetReportTemplate({ reportTemplateId: '' }, null, ctx)).resolves.toBeNull()
    expect(getSession).not.toHaveBeenCalled()

    fakeSession([])
    await expect(Q.widgetReportTemplate({ reportTemplateId: 'rt' }, null, ctx)).resolves.toBeNull()

    const s = fakeSession([{ t: { id: 'rt', name: 'Weekly' } }])
    await expect(Q.widgetReportTemplate({ reportTemplateId: 'rt' }, null, ctx))
      .resolves.toEqual({ id: 'rt', name: 'Weekly', description: null, visibility: null })
    expect(s.calls[0]!.p).toEqual({ id: 'rt', tenantId: 't1' })
  })

  it('reportSection: null without id; otherwise loaded in the caller tenant', async () => {
    await expect(Q.widgetReportSection({ reportSectionId: '' }, null, ctx)).resolves.toBeNull()
    vi.mocked(loadReportSection).mockResolvedValue({ id: 'rs' } as never)
    await expect(Q.widgetReportSection({ reportSectionId: 'rs' }, null, ctx)).resolves.toEqual({ id: 'rs' })
    expect(loadReportSection).toHaveBeenCalledWith('rs', 't1')
  })

  it('data + error run the report ONCE per widget, in the viewer language', async () => {
    vi.mocked(loadReportSection).mockResolvedValue({ id: 'rs' } as never)
    vi.mocked(executeReportSection).mockResolvedValue({ data: '{"n":3}', error: null } as never)
    const parent = { reportSectionId: 'rs' }
    await expect(Q.widgetData(parent, { language: 'it' }, ctx)).resolves.toBe('{"n":3}')
    await expect(Q.widgetError(parent, { language: 'it' }, ctx)).resolves.toBeNull()
    expect(executeReportSection).toHaveBeenCalledTimes(1)
    expect(executeReportSection).toHaveBeenCalledWith({ id: 'rs' }, 't1', { language: 'it' })
  })

  it('a failing section: no data, and the error says why (never an empty widget without reason)', async () => {
    vi.mocked(loadReportSection).mockResolvedValue({ id: 'rs' } as never)
    vi.mocked(executeReportSection).mockResolvedValue({ data: '[]', error: 'Field "x" unknown' } as never)
    const parent = { reportSectionId: 'rs' }
    await expect(Q.widgetData(parent, {}, ctx)).resolves.toBeNull()
    await expect(Q.widgetError(parent, {}, ctx)).resolves.toBe('Field "x" unknown')
    expect(executeReportSection).toHaveBeenCalledWith({ id: 'rs' }, 't1', { language: undefined })
  })

  it('a deleted section → "Report section not found"', async () => {
    vi.mocked(loadReportSection).mockResolvedValue(null)
    await expect(Q.widgetError({ reportSectionId: 'gone' }, {}, ctx)).resolves.toBe('Report section not found')
    expect(executeReportSection).not.toHaveBeenCalled()
  })

  it('a thrown error (Error or not) becomes the widget error, not a failed page', async () => {
    vi.mocked(loadReportSection).mockRejectedValueOnce(new Error('boom'))
    await expect(Q.widgetError({ reportSectionId: 'rs' }, {}, ctx)).resolves.toBe('boom')
    vi.mocked(loadReportSection).mockRejectedValueOnce('plain failure')
    await expect(Q.widgetData({ reportSectionId: 'rs' }, {}, ctx)).resolves.toBeNull()
  })

  it('an unknown language is reported as the widget error', async () => {
    vi.mocked(loadReportSection).mockResolvedValue({ id: 'rs' } as never)
    const err = await Q.widgetError({ reportSectionId: 'rs' }, { language: 'klingon' }, ctx)
    expect(err).toContain('klingon')
    expect(executeReportSection).not.toHaveBeenCalled()
  })

  it('data / error without a section id → null, no execution', async () => {
    await expect(Q.widgetData({ reportSectionId: '' }, {}, ctx)).resolves.toBeNull()
    await expect(Q.widgetError({ reportSectionId: '' }, {}, ctx)).resolves.toBeNull()
    expect(loadReportSection).not.toHaveBeenCalled()
  })
})
