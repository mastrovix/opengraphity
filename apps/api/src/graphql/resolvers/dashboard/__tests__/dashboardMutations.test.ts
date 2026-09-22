/**
 * Dashboard mutations: update, delete and clone (create has its own file).
 *
 * What a user loses if these regress:
 * - update/delete match the dashboard by id AND tenant AND owner: without the
 *   owner a user could rename or delete a colleague's dashboard, without the
 *   tenant another customer's;
 * - «set as default» leaves exactly one default per user;
 * - the last dashboard cannot be deleted (the home page would be empty), and
 *   deleting one takes its widgets with it (orphans stay in the graph forever);
 * - deleting something that is not yours / does not exist is an error, not a
 *   fake «deleted» (defect fixed here);
 * - clone is gated by dashboard access and copies both widget kinds into the
 *   caller's tenant, as the caller's personal, non-default dashboard.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../../lib/__tests__/testPermissions.js'

type Call = { mode: 'read' | 'write'; cypher: string; params: Record<string, unknown> }
const calls: Call[] = []
// Per-test answer for each query: records as plain objects.
let answer: (cypher: string, params: Record<string, unknown>) => Array<Record<string, unknown>> = () => []
const close = vi.fn(async () => {})

function tx(mode: Call['mode']) {
  return {
    run: async (cypher: string, params: Record<string, unknown>) => {
      calls.push({ mode, cypher, params })
      return { records: answer(cypher, params).map((r) => ({ get: (k: string) => r[k] })) }
    },
  }
}
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async (fn: (t: unknown) => unknown) => fn(tx('read')),
    executeWrite: async (fn: (t: unknown) => unknown) => fn(tx('write')),
    close,
  }),
}))
const audit = vi.fn()
vi.mock('../../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))
const assertDashboardAccess = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => ({}))
vi.mock('../../reportAccess.js', () => ({ assertDashboardAccess: (...a: unknown[]) => assertDashboardAccess(...a) }))

const { updateDashboard, deleteDashboard, cloneDashboard } = await import('../dashboardMutations.js')

const ctx = { tenantId: 'c-test', userId: 'u-1', userEmail: 'a@x', role: 'operator', permissions: perms('operator') } as never
const find = (re: RegExp) => calls.filter((c) => re.test(c.cypher))

beforeEach(() => {
  calls.length = 0
  answer = () => []
  vi.clearAllMocks()
  assertDashboardAccess.mockImplementation(async () => ({}))
})

describe('updateDashboard', () => {
  it('only sets the provided fields, scoped to tenant and owner, and returns the refetched dashboard', async () => {
    answer = (c) => c.includes('RETURN properties(d)') ? [{ props: { id: 'd-1', name: 'New', visibility: 'teams' } }] : []
    const r = await updateDashboard(null, { id: 'd-1', input: { name: 'New', visibility: 'teams', description: null } }, ctx)
    const [upd] = find(/SET d\.updated_at/)
    expect(upd!.cypher).toMatch(/\{id: \$id, tenant_id: \$tenantId, user_id: \$userId\}/)
    expect(upd!.cypher).toContain('d.name = $name')
    expect(upd!.cypher).toContain('d.visibility = $visibility')
    // Why: a null field means «unchanged», it must not blank the description.
    expect(upd!.cypher).not.toContain('d.description')
    expect(upd!.params).toMatchObject({ id: 'd-1', tenantId: 'c-test', userId: 'u-1', name: 'New', visibility: 'teams' })
    expect(r).toMatchObject({ id: 'd-1', name: 'New', visibility: 'teams' })
    expect(audit).toHaveBeenCalledWith(ctx, 'dashboard.updated', 'DashboardConfig', 'd-1')
    expect(close).toHaveBeenCalled()
  })

  it('sets every optional field when given', async () => {
    answer = (c) => c.includes('RETURN properties(d)') ? [{ props: { id: 'd-1' } }] : []
    await updateDashboard(null, { id: 'd-1', input: { description: 'D', role: 'ops', isShared: false } }, ctx)
    const [upd] = find(/SET d\.updated_at/)
    expect(upd!.cypher).toContain('d.description = $description')
    expect(upd!.cypher).toContain('d.role = $role')
    // Why: `false` is a value, not «unchanged».
    expect(upd!.cypher).toContain('d.is_shared = $isShared')
  })

  it('someone else\'s (or unknown) dashboard is NOT_FOUND and nothing else is written', async () => {
    await expect(updateDashboard(null, { id: 'd-x', input: { name: 'Hijack', isDefault: true, sharedWithTeamIds: ['t'] } }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(calls).toHaveLength(1)
    expect(audit).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalled()
  })

  it('set as default clears the default of the user\'s other dashboards first', async () => {
    answer = (c) => c.includes('RETURN properties(d)') ? [{ props: { id: 'd-1', is_default: true } }] : []
    const r = await updateDashboard(null, { id: 'd-1', input: { isDefault: true } }, ctx)
    const unset = find(/SET d\.is_default = false/)
    const set = find(/SET d\.is_default = true/)
    expect(unset[0]!.params).toEqual({ tenantId: 'c-test', userId: 'u-1' })
    expect(set[0]!.params).toEqual({ id: 'd-1', tenantId: 'c-test' })
    expect(calls.indexOf(unset[0]!)).toBeLessThan(calls.indexOf(set[0]!))
    expect(r.isDefault).toBe(true)
  })

  it('replaces the team sharing: removes the old relations, then links the new teams of the tenant', async () => {
    answer = (c) => c.includes('RETURN properties(d)') ? [{ props: { id: 'd-1' } }] : []
    await updateDashboard(null, { id: 'd-1', input: { sharedWithTeamIds: ['t-1', 't-2'] } }, ctx)
    expect(find(/-\[r:SHARED_WITH\]->\(\) DELETE r/)).toHaveLength(1)
    const [merge] = find(/MERGE \(d\)-\[:SHARED_WITH\]->\(t\)/)
    expect(merge!.cypher).toMatch(/MATCH \(t:Team \{id: teamId, tenant_id: \$tenantId\}\)/)
    expect(merge!.params).toEqual({ id: 'd-1', teamIds: ['t-1', 't-2'], tenantId: 'c-test' })
  })

  it('an empty team list un-shares without linking anything', async () => {
    answer = (c) => c.includes('RETURN properties(d)') ? [{ props: { id: 'd-1' } }] : []
    await updateDashboard(null, { id: 'd-1', input: { sharedWithTeamIds: [] } }, ctx)
    expect(find(/DELETE r/)).toHaveLength(1)
    expect(find(/MERGE/)).toHaveLength(0)
  })
})

describe('deleteDashboard', () => {
  it('refuses to delete the user\'s only dashboard', async () => {
    answer = (c) => c.includes('count(d)') ? [{ cnt: 1 }] : []
    await expect(deleteDashboard(null, { id: 'd-1' }, ctx)).rejects.toMatchObject({
      extensions: { code: 'CONFLICT', i18n: { key: 'errors.dashboard.lastOne' } },
    })
    expect(calls.filter((c) => c.mode === 'write')).toHaveLength(0)
    expect(close).toHaveBeenCalled()
  })

  it('deletes the owner\'s dashboard together with both kinds of widgets', async () => {
    answer = (c) => c.includes('count(d)') ? [{ cnt: 3 }] : c.includes('DETACH DELETE d') ? [{ ok: 1 }] : []
    await expect(deleteDashboard(null, { id: 'd-1' }, ctx)).resolves.toBe(true)
    const [del] = find(/DETACH DELETE d/)
    expect(del!.cypher).toMatch(/\{id: \$id, tenant_id: \$tenantId, user_id: \$userId\}/)
    expect(del!.cypher).toMatch(/DashboardWidget \{tenant_id: \$tenantId, dashboard_id: d\.id\}/)
    expect(del!.cypher).toMatch(/CustomWidget \{tenant_id: \$tenantId, dashboard_id: d\.id\}/)
    expect(del!.params).toEqual({ id: 'd-1', tenantId: 'c-test', userId: 'u-1' })
    expect(audit).toHaveBeenCalledWith(ctx, 'dashboard.deleted', 'DashboardConfig', 'd-1')
  })

  it('a dashboard that is not the caller\'s (or does not exist) is NOT_FOUND, not a fake success', async () => {
    // Fails without the fix: the resolver returned true and audited a deletion that never happened.
    answer = (c) => c.includes('count(d)') ? [{ cnt: 3 }] : []
    await expect(deleteDashboard(null, { id: 'd-other' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('cloneDashboard', () => {
  it('is gated by write access to the source dashboard', async () => {
    assertDashboardAccess.mockRejectedValueOnce(new Error('forbidden'))
    await expect(cloneDashboard(null, { id: 'd-1', newName: 'Copy' }, ctx)).rejects.toThrow('forbidden')
    expect(assertDashboardAccess).toHaveBeenCalledWith(expect.anything(), 'd-1', ctx, 'write')
    expect(calls).toHaveLength(0)
    expect(close).toHaveBeenCalled()
  })

  it('an unknown source dashboard is NOT_FOUND', async () => {
    await expect(cloneDashboard(null, { id: 'd-1', newName: 'Copy' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })

  it('creates a personal, non-default copy for the caller and clones both widget kinds into it', async () => {
    let newId = ''
    answer = (c, p) => {
      if (c.includes('RETURN properties(d) AS p') && p['id'] === 'd-1') {
        return [{ p: { id: 'd-1', name: 'Ops', description: 'desc', role: 'ops', visibility: 'teams', is_shared: true, user_id: 'u-other' } }]
      }
      if (c.includes('RETURN properties(d) AS p') && p['id'] === newId) return [{ p: { id: newId, name: 'Copy', is_default: false } }]
      return []
    }
    const origRun = answer
    answer = (c, p) => {
      if (c.includes('CREATE (d:DashboardConfig')) newId = p['newId'] as string
      return origRun(c, p)
    }
    const r = await cloneDashboard(null, { id: 'd-1', newName: 'Copy' }, ctx)
    const [create] = find(/CREATE \(d:DashboardConfig/)
    // Why: the copy belongs to the caller, in the caller's tenant, even if the source was a colleague's.
    expect(create!.params).toMatchObject({
      tenantId: 'c-test', userId: 'u-1', name: 'Copy', description: 'desc', role: 'ops', visibility: 'teams', isShared: true,
    })
    expect(create!.cypher).toContain('is_default: false')
    const [legacy] = find(/HAS_WIDGET\]->\(w:DashboardWidget\)/)
    const [custom] = find(/HAS_CUSTOM_WIDGET\]->\(w:CustomWidget\)/)
    expect(legacy!.params).toMatchObject({ srcId: 'd-1', dstId: newId, tenantId: 'c-test' })
    expect(custom!.params).toMatchObject({ srcId: 'd-1', dstId: newId, tenantId: 'c-test', userId: 'u-1' })
    expect(r).toMatchObject({ id: newId, name: 'Copy', isDefault: false })
    expect(audit).toHaveBeenCalledWith(ctx, 'dashboard.cloned', 'DashboardConfig', newId, { sourceDashboardId: 'd-1' })
  })

  it('a source with missing optional props gets the documented defaults (private, not shared)', async () => {
    answer = (c, p) => c.includes('RETURN properties(d) AS p') ? [{ p: { id: p['id'], name: 'X' } }] : []
    await cloneDashboard(null, { id: 'd-1', newName: 'Copy' }, ctx)
    const [create] = find(/CREATE \(d:DashboardConfig/)
    expect(create!.params).toMatchObject({ description: null, role: null, visibility: 'private', isShared: false })
  })
})
