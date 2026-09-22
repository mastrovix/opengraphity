/**
 * widgetMutations.ts — adding, removing, resizing and reordering the report
 * widgets of a dashboard (the atomic layout save has its own test file,
 * `resolvers/__tests__/saveDashboardLayout.test.ts`).
 *
 * Why these behaviours matter for a user:
 *   - only the owner (or an admin) of a dashboard may change its widgets, and
 *     a new widget may only point to a report the caller can read: otherwise a
 *     widget would expose someone else's private report on a shared dashboard;
 *   - every read and write carries the caller's tenant: a widget id from
 *     another tenant must never be matched;
 *   - a new widget goes AFTER the existing ones unless a position is given,
 *     and the permission check runs before anything is written.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../../context.js'
import { perms } from '../../../../lib/__tests__/testPermissions.js'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), toNumber: (v: unknown) => Number(v ?? 0) }))
vi.mock('../../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../reportAccess.js', () => ({
  assertDashboardAccess:        vi.fn().mockResolvedValue({}),
  assertReportTemplateAccess:   vi.fn().mockResolvedValue({}),
  assertDashboardOwnerByWidget: vi.fn().mockResolvedValue({}),
}))

const W = await import('../widgetMutations.js')
const { getSession } = await import('@opengraphity/neo4j')
const { assertDashboardAccess, assertReportTemplateAccess, assertDashboardOwnerByWidget } = await import('../../reportAccess.js')

const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') }
const DASH = { id: 'd1', name: 'Home', created_at: 'x' }

type Row = Record<string, unknown>
/** Session whose reads and writes share one ordered list of answers; every run is recorded with its kind. */
function fakeSession(...answers: Row[][]) {
  const calls: Array<{ kind: 'read' | 'write'; q: string; p: Record<string, unknown> }> = []
  let i = 0
  const runner = (kind: 'read' | 'write') => ({
    run: async (q: string, p: Record<string, unknown>) => {
      calls.push({ kind, q, p })
      const rows = answers[i++] ?? []
      return { records: rows.map((r) => ({ get: (k: string) => r[k] })) }
    },
  })
  const s = {
    calls,
    executeRead:  vi.fn((fn: (tx: unknown) => unknown) => fn(runner('read'))),
    executeWrite: vi.fn((fn: (tx: unknown) => unknown) => fn(runner('write'))),
    close: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(getSession).mockReturnValue(s as never)
  return s
}

const denied = () => Object.assign(new Error('Forbidden'), { extensions: { code: 'FORBIDDEN' } })

beforeEach(() => vi.clearAllMocks())

describe('addDashboardWidget', () => {
  const input = { dashboardId: 'd1', reportTemplateId: 'rt', reportSectionId: 'rs', colSpan: 6 }

  it('checks write access on the dashboard AND read access on the report, then appends after the last widget', async () => {
    const s = fakeSession([{ maxOrder: 2 }], [{ d: DASH }], [])
    const out = await W.addDashboardWidget(null, { input }, ctx)

    expect(assertDashboardAccess).toHaveBeenCalledWith(s, 'd1', ctx, 'write')
    expect(assertReportTemplateAccess).toHaveBeenCalledWith(s, 'rt', ctx, 'read')
    const create = s.calls[2]!
    expect(create.kind).toBe('write')
    expect(create.q).toContain('CREATE (w:DashboardWidget')
    expect(create.p).toMatchObject({ dashId: 'd1', tenantId: 't1', reportTemplateId: 'rt', reportSectionId: 'rs', colSpan: 6, order: 3 })
    for (const c of s.calls) expect(c.p['tenantId']).toBe('t1')
    expect(out).toMatchObject({ id: 'd1', name: 'Home' })
    expect(s.close).toHaveBeenCalled()
  })

  it('first widget on an empty dashboard goes to position 0; an explicit order wins', async () => {
    let s = fakeSession([{ maxOrder: null }], [{ d: DASH }], [])
    await W.addDashboardWidget(null, { input }, ctx)
    expect(s.calls[2]!.p['order']).toBe(0)

    s = fakeSession([], [{ d: DASH }], [])
    await W.addDashboardWidget(null, { input: { ...input, order: 7.6 } }, ctx)
    expect(s.calls[2]!.p['order']).toBe(8)
  })

  it('a missing colSpan falls back to 4 columns', async () => {
    const s = fakeSession([{ maxOrder: 0 }], [{ d: DASH }], [])
    await W.addDashboardWidget(null, { input: { ...input, colSpan: undefined as unknown as number } }, ctx)
    expect(s.calls[2]!.p['colSpan']).toBe(4)
  })

  it('a private report of someone else → refused before any read or write', async () => {
    const s = fakeSession()
    vi.mocked(assertReportTemplateAccess).mockRejectedValueOnce(denied())
    await expect(W.addDashboardWidget(null, { input }, ctx)).rejects.toThrow('Forbidden')
    expect(s.calls).toHaveLength(0)
    expect(s.close).toHaveBeenCalled()
  })

  it('dashboard not found in this tenant → NOT_FOUND and no widget created', async () => {
    const s = fakeSession([{ maxOrder: 1 }], [])
    await expect(W.addDashboardWidget(null, { input }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(s.executeWrite).not.toHaveBeenCalled()
  })
})

describe('removeDashboardWidget', () => {
  it('owner check first, then deletes only the widget in this tenant and returns its dashboard', async () => {
    const s = fakeSession([{ d: DASH }], [])
    const out = await W.removeDashboardWidget(null, { widgetId: 'w1' }, ctx)
    expect(assertDashboardOwnerByWidget).toHaveBeenCalledWith(s, 'w1', 'widget', ctx)
    const del = s.calls[1]!
    expect(del.kind).toBe('write')
    expect(del.q).toContain('DETACH DELETE w')
    expect(del.p).toEqual({ widgetId: 'w1', tenantId: 't1' })
    expect(out).toMatchObject({ id: 'd1' })
  })

  it('not the owner → refused, nothing deleted', async () => {
    const s = fakeSession()
    vi.mocked(assertDashboardOwnerByWidget).mockRejectedValueOnce(denied())
    await expect(W.removeDashboardWidget(null, { widgetId: 'w1' }, ctx)).rejects.toThrow('Forbidden')
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('widget without a dashboard in this tenant → NOT_FOUND, nothing deleted', async () => {
    const s = fakeSession([])
    await expect(W.removeDashboardWidget(null, { widgetId: 'wX' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(s.executeWrite).not.toHaveBeenCalled()
    expect(s.close).toHaveBeenCalled()
  })
})

describe('updateDashboardWidget', () => {
  it('sets only the fields sent (colSpan and/or order) and returns the parent dashboard', async () => {
    let s = fakeSession([], [{ d: DASH }])
    const out = await W.updateDashboardWidget(null, { widgetId: 'w1', input: { colSpan: 8, order: 2 } }, ctx)
    expect(s.calls[0]!.q).toContain('w.col_span = $colSpan')
    expect(s.calls[0]!.q).toContain('w.order = $order')
    expect(s.calls[0]!.p).toMatchObject({ widgetId: 'w1', tenantId: 't1', colSpan: 8, order: 2 })
    expect(out).toMatchObject({ id: 'd1' })

    s = fakeSession([], [{ d: DASH }])
    await W.updateDashboardWidget(null, { widgetId: 'w1', input: { colSpan: null } }, ctx)
    // Resizing nothing must not reset the position (null is "leave as is").
    expect(s.calls[0]!.q).not.toContain('w.col_span')
    expect(s.calls[0]!.q).not.toContain('w.order')
    expect(s.calls[0]!.q).toContain('w.updated_at = $now')
  })

  it('not the owner → refused before the write', async () => {
    const s = fakeSession()
    vi.mocked(assertDashboardOwnerByWidget).mockRejectedValueOnce(denied())
    await expect(W.updateDashboardWidget(null, { widgetId: 'w1', input: { order: 1 } }, ctx)).rejects.toThrow('Forbidden')
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('no parent dashboard after the update → NOT_FOUND', async () => {
    fakeSession([], [])
    await expect(W.updateDashboardWidget(null, { widgetId: 'w1', input: { order: 1 } }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })
})

describe('reorderDashboardWidgets', () => {
  it('order = position in the list, only on widgets of this dashboard in this tenant', async () => {
    const s = fakeSession([], [{ d: DASH }])
    const out = await W.reorderDashboardWidgets(null, { dashboardId: 'd1', widgetIds: ['w3', 'w1', 'w2'] }, ctx)
    expect(assertDashboardAccess).toHaveBeenCalledWith(s, 'd1', ctx, 'write')
    expect(s.calls[0]!.p).toEqual({
      items: [{ id: 'w3', order: 0 }, { id: 'w1', order: 1 }, { id: 'w2', order: 2 }],
      dashboardId: 'd1', tenantId: 't1',
    })
    expect(s.calls[0]!.q).toContain('MATCH (d:DashboardConfig {id: $dashboardId, tenant_id: $tenantId})-[:HAS_WIDGET]->')
    expect(out).toMatchObject({ id: 'd1' })
  })

  it('no write access → refused, nothing reordered', async () => {
    const s = fakeSession()
    vi.mocked(assertDashboardAccess).mockRejectedValueOnce(denied())
    await expect(W.reorderDashboardWidgets(null, { dashboardId: 'd1', widgetIds: ['w1'] }, ctx)).rejects.toThrow('Forbidden')
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('dashboard missing afterwards → NOT_FOUND, session closed', async () => {
    const s = fakeSession([], [])
    await expect(W.reorderDashboardWidgets(null, { dashboardId: 'dX', widgetIds: [] }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(s.close).toHaveBeenCalled()
  })
})

describe('saveDashboardLayout — the dashboard vanishing mid-transaction', () => {
  it('no dashboard to touch at the end → NOT_FOUND thrown INSIDE the write (rolls back), no audit', async () => {
    const { audit } = await import('../../../../lib/audit.js')
    // delete → [], create → [], touch → [] (dashboard gone)
    const s = fakeSession([], [], [])
    await expect(W.saveDashboardLayout(null, {
      dashboardId: 'd1', widgets: [{ reportTemplateId: 'rt', reportSectionId: 'rs', colSpan: 4 }],
    }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(s.calls.every((c) => c.kind === 'write')).toBe(true)
    expect(audit).not.toHaveBeenCalled()
  })
})
