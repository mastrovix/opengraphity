import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn() }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../reportAccess.js', () => ({
  assertDashboardAccess: vi.fn().mockResolvedValue({}),
  assertReportTemplateAccess: vi.fn().mockResolvedValue({}),
  assertDashboardOwnerByWidget: vi.fn(),
}))

const { saveDashboardLayout } = await import('../dashboard/widgetMutations.js')
const { getSession } = await import('@opengraphity/neo4j')
const { assertDashboardAccess, assertReportTemplateAccess } = await import('../reportAccess.js')

const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator' }
const DASH = { id: 'd1', tenant_id: 't1', user_id: 'u1', name: 'Home', visibility: 'private', created_at: 'x' }

/** Session whose executeWrite hands a tx to the callback; tx.run dispatches on Cypher. */
function fakeSession(dispatch: (q: string, p: Record<string, unknown>) => Array<Record<string, unknown>>) {
  const calls: Array<{ q: string; p: Record<string, unknown> }> = []
  const run = vi.fn().mockImplementation(async (q: string, p: Record<string, unknown>) => {
    calls.push({ q, p })
    return { records: dispatch(q, p).map(r => ({ get: (k: string) => r[k] })) }
  })
  const s = {
    calls,
    executeRead:  vi.fn().mockImplementation((fn: (tx: { run: typeof run }) => unknown) => fn({ run })),
    executeWrite: vi.fn().mockImplementation((fn: (tx: { run: typeof run }) => unknown) => fn({ run })),
    close: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(getSession).mockReturnValue(s as never)
  return s
}

const kind = (q: string) =>
  q.includes('DETACH DELETE w') ? 'delete'
  : q.includes('SET w.col_span') ? 'update'
  : q.includes('CREATE (w:DashboardWidget') ? 'create'
  : q.includes('SET d.updated_at') ? 'touch'
  : 'other'

describe('saveDashboardLayout (F-08) — one transaction for the whole layout', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes unlisted, updates kept (colSpan + order = list position), creates new, in ONE executeWrite', async () => {
    const s = fakeSession((q) => {
      if (kind(q) === 'update') return [{ n: 2 }]
      if (kind(q) === 'touch')  return [{ d: DASH }]
      return []
    })

    const out = await saveDashboardLayout(null, {
      dashboardId: 'd1',
      widgets: [
        { id: 'w-b', reportTemplateId: 'r1', reportSectionId: 's1', colSpan: 6 },
        { reportTemplateId: 'r2', reportSectionId: 's2', colSpan: 4 },           // new
        { id: 'w-a', reportTemplateId: 'r1', reportSectionId: 's3', colSpan: 12 },
      ],
    }, ctx)

    expect(out.id).toBe('d1')
    expect(assertDashboardAccess).toHaveBeenCalledWith(expect.anything(), 'd1', ctx, 'write')
    expect(assertReportTemplateAccess).toHaveBeenCalledWith(expect.anything(), 'r2', ctx, 'read')  // only NEW widgets' reports
    expect(assertReportTemplateAccess).toHaveBeenCalledTimes(1)
    expect(s.executeWrite).toHaveBeenCalledTimes(1)

    expect(s.calls.map(c => kind(c.q))).toEqual(['delete', 'update', 'create', 'touch'])
    const del = s.calls[0]!
    expect(del.q).toContain('DashboardConfig {id: $dashboardId, tenant_id: $tenantId}')
    expect(del.q).toContain('WHERE NOT w.id IN $keepIds')
    expect(del.p['keepIds']).toEqual(['w-b', 'w-a'])

    const upd = s.calls[1]!
    expect(upd.p['updates']).toEqual([{ id: 'w-b', colSpan: 6, order: 0 }, { id: 'w-a', colSpan: 12, order: 2 }])

    const cre = s.calls[2]!
    expect(cre.p['creates']).toEqual([{ reportTemplateId: 'r2', reportSectionId: 's2', colSpan: 4, order: 1 }])
    expect(cre.q).toContain('CREATE (d)-[:HAS_WIDGET]->(w)')
  })

  it('an id that does not belong to the dashboard aborts the transaction BEFORE creating anything', async () => {
    const s = fakeSession((q) => (kind(q) === 'update' ? [{ n: 0 }] : [{ d: DASH }]))
    let thrown: unknown
    try {
      await saveDashboardLayout(null, {
        dashboardId: 'd1',
        widgets: [{ id: 'foreign', reportTemplateId: 'r1', reportSectionId: 's1', colSpan: 4 }, { reportTemplateId: 'r1', reportSectionId: 's9', colSpan: 4 }],
      }, ctx)
    } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(GraphQLError)
    expect((thrown as GraphQLError).extensions?.code).toBe('NOT_FOUND')
    expect(s.calls.map(c => kind(c.q))).toEqual(['delete', 'update'])   // no create, no touch → tx rolled back by the throw
    expect(s.close).toHaveBeenCalled()
  })

  it('empty layout removes every widget', async () => {
    const s = fakeSession((q) => (kind(q) === 'touch' ? [{ d: DASH }] : []))
    await saveDashboardLayout(null, { dashboardId: 'd1', widgets: [] }, ctx)
    expect(s.calls.map(c => kind(c.q))).toEqual(['delete', 'touch'])
    expect(s.calls[0]!.p['keepIds']).toEqual([])
  })

  it.each([
    ['duplicate id',       [{ id: 'w', reportTemplateId: 'r', reportSectionId: 's', colSpan: 4 }, { id: 'w', reportTemplateId: 'r', reportSectionId: 's', colSpan: 4 }], 'appears twice'],
    ['colSpan out of range', [{ reportTemplateId: 'r', reportSectionId: 's', colSpan: 13 }], 'colSpan must be between 1 and 12'],
  ])('rejects %s with BAD_USER_INPUT before touching the DB', async (_n, widgets, msg) => {
    const s = fakeSession(() => [])
    let thrown: unknown
    try { await saveDashboardLayout(null, { dashboardId: 'd1', widgets }, ctx) } catch (e) { thrown = e }
    expect((thrown as GraphQLError).extensions?.code).toBe('BAD_USER_INPUT')
    expect((thrown as GraphQLError).message).toContain(msg)
    expect(s.executeWrite).not.toHaveBeenCalled()
  })
})
