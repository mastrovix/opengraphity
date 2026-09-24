/**
 * Global search (the bar on top of every page) — the cases the main suite
 * did not pin:
 *  - generic workflow tasks (`TASK…`) share numbering with change tasks, so a
 *    code read over the phone must find them, badged with the TICKET number
 *    (a generic task has no page of its own); and they are gated by the same
 *    `change.read` as change tasks;
 *  - a logically deleted change never shows up in the results;
 *  - direct id matches fill the CI group first, and text hits never push it
 *    past the limit;
 *  - input with no searchable token (only punctuation) returns empty groups
 *    without running a malformed Lucene query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('../../../lib/ciLabelsForTenant.js', () => ({
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Server)`),
}))
vi.mock('../ci-utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ci-utils.js')>()
  return {
    ...actual,
    withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn({})),
    runQuery: vi.fn().mockResolvedValue([]),
    ciTypeFromLabels: vi.fn(() => 'server'),
  }
})

const { globalSearchResolvers } = await import('../globalSearch.js')
const { withSession, runQuery } = await import('../ci-utils.js')
const globalSearch = globalSearchResolvers.Query.globalSearch

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'u@test.io', role: 'operator', permissions: perms('operator') }

type Row = Record<string, unknown>
function prime(q: { fulltext?: Row[]; ciById?: Row[]; changeTasks?: Row[]; genericTasks?: Row[] }) {
  vi.mocked(runQuery).mockImplementation(async (_s, cypher: string) => {
    if (cypher.includes('db.index.fulltext.queryNodes')) return (q.fulltext ?? []) as never
    if (cypher.includes('STARTS WITH $q')) return (q.ciById ?? []) as never
    if (cypher.includes('HAS_ASSESSMENT|HAS_DEPLOY_PLAN')) return (q.changeTasks ?? []) as never
    if (cypher.includes('[:HAS_TASK]')) return (q.genericTasks ?? []) as never
    return [] as never
  })
}

const ciRow = (id: string, name: string): Row => ({ props: { id, name, tenant_id: 'tenant-1' }, labels: ['Server', 'ConfigurationItem'] })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runQuery).mockResolvedValue([])
})

describe('generic workflow tasks', () => {
  it('are found by code and badged with the ticket number, after the change tasks', async () => {
    prime({
      changeTasks: [{ id: 'ct-1', code: 'TASK00000041', label: 'ReviewTask', status: 'pending', changeCode: 'CHG00000003', changeId: 'chg-3', ciName: 'db-01' }],
      genericTasks: [{ id: 'k-1', code: 'TASK00000042', state: 'open', titolo: 'Call the vendor', entityNumber: 'INC00000007', entityId: 'inc-7', entityType: 'incident' }],
    })
    const res = await globalSearch(null, { query: 'TASK0000004' }, ctx)
    expect(res.tasks).toEqual([
      { id: 'ct-1', code: 'TASK00000041', taskType: 'review', status: 'pending', changeCode: 'CHG00000003', changeId: 'chg-3', ciName: 'db-01', entityType: 'change' },
      // The ticket's type: the web leads a generic task to its ticket (review of 23 Sep 2026).
      { id: 'k-1', code: 'TASK00000042', taskType: 'task', status: 'open', changeCode: 'INC00000007', changeId: 'inc-7', ciName: 'Call the vendor', entityType: 'incident' },
    ])
    const [, , params] = vi.mocked(runQuery).mock.calls.find(([, c]) => String(c).includes('[:HAS_TASK]'))!
    expect(params).toMatchObject({ tenantId: 'tenant-1', q: 'TASK0000004' })
  })

  it('an unknown task label falls back to its lowercase name', async () => {
    prime({ changeTasks: [{ id: 'x', code: 'TASK1', label: 'CustomTask', status: '', changeCode: 'C', changeId: 'c', ciName: '' }] })
    const res = await globalSearch(null, { query: 'TASK1' }, ctx)
    expect(res.tasks[0]!.taskType).toBe('customtask')
  })

  it('without change.read the generic-task query does not even run', async () => {
    const noChange = { ...ctx, permissions: new Set([...ctx.permissions].filter((p) => p !== 'change.read')) } as GraphQLContext
    prime({ genericTasks: [{ id: 'k-1', code: 'TASK1', state: 'open', titolo: 't', entityNumber: 'INC1', entityId: 'i' }] })
    const res = await globalSearch(null, { query: 'TASK1' }, noChange)
    expect(res.tasks).toEqual([])
    expect(vi.mocked(runQuery).mock.calls.some(([, c]) => String(c).includes('[:HAS_TASK]'))).toBe(false)
  })
})

describe('result hygiene', () => {
  it('a logically deleted change is skipped', async () => {
    prime({ fulltext: [
      { props: { id: 'chg-del', code: 'CHG1', title: 'gone', deleted: true, tenant_id: 'tenant-1' }, labels: ['Change'] },
      { props: { id: 'chg-ok', code: 'CHG2', title: 'alive', tenant_id: 'tenant-1' }, labels: ['Change'] },
    ] })
    const res = await globalSearch(null, { query: 'CHG' }, ctx)
    expect(res.changes.map((c) => (c as { id: string }).id)).toEqual(['chg-ok'])
  })

  it('direct id hits fill the CI group first; text hits never push it past the limit', async () => {
    prime({
      ciById: [ciRow('abc-1', 'by-id-1'), ciRow('abc-2', 'by-id-2')],
      fulltext: [ciRow('zzz-1', 'text-1'), ciRow('zzz-2', 'text-2')],
    })
    const res = await globalSearch(null, { query: 'abc', limit: 2 }, ctx)
    expect(res.cis.map((c) => c.id)).toEqual(['abc-1', 'abc-2'])
  })

  it('only punctuation → empty groups and no query at all', async () => {
    const res = await globalSearch(null, { query: '--//' }, ctx)
    expect(res).toEqual({ cis: [], changes: [], incidents: [], problems: [], serviceRequests: [], tasks: [], kbArticles: [], teams: [] })
    expect(withSession).not.toHaveBeenCalled()
  })
})
