/**
 * Tenant roles: the parts roles.test.ts does not reach.
 *
 * Why these behaviours matter to a user:
 *  - `roleHasPermission` decides whether ANOTHER person may receive something
 *    (an approval, a notification): a role the tenant does not have must say
 *    "no", never throw and never default to yes.
 *  - Role data read from the graph is trusted for authorization, so a role
 *    without a permission list is an integrity error, not an empty role.
 *  - The Roles page lists factory roles first in their canonical order, then
 *    the customer's roles by name; user counts come from the graph.
 *  - Every write invalidates the roles cache: otherwise a permission removed
 *    on the Roles page keeps working until the cache expires.
 *  - Deleting a role that is still the recipient of notification rules,
 *    workflow steps or automations would leave them notifying nobody.
 *  - Deactivating a person: never yourself, never the last person who can
 *    manage people and roles, and a no-op when the state is already right.
 *  - "Per role" recipients must name roles the tenant has, or the notification
 *    job fails on every event.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQuery = vi.fn()
const txRun = vi.fn()
const close = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close, executeWrite: (fn: (tx: unknown) => unknown) => fn({ run: txRun }) })),
  runQuery: (...a: unknown[]) => runQuery(...a),
}))
vi.mock('../schemaInvalidator.js', () => ({ invalidateSchema: vi.fn(), registerMetamodelCacheClearer: vi.fn() }))

const {
  roleHasPermission, rolePermissions, tenantRoles, invalidateRoles, clearRolesCache, listRoles, createRole,
  updateRole, deleteRole, setUserRole, setUserActiveInGraph, roleKeysInActions, assertRolesExist, roleKeyFromName,
} = await import('../roles.js')

const rec = (row: Record<string, unknown>) => ({ records: [{ get: (k: string) => row[k] }] })
const none = { records: [] }
const errKey = async (p: Promise<unknown>) => p.then(() => null, (e: { extensions?: { i18n?: { key?: string } } }) => e.extensions?.i18n?.key ?? String(e))

beforeEach(() => { clearRolesCache(); runQuery.mockReset(); txRun.mockReset(); close.mockReset() })

describe('reading roles', () => {
  it('roleHasPermission: yes, no, and "no" for a role the tenant does not have', async () => {
    runQuery.mockResolvedValue([{ key: 'desk', name: 'Desk', permissions: ['incident.read'], isFactory: null }])
    expect(await roleHasPermission('t1', 'desk', 'incident.read')).toBe(true)
    expect(await roleHasPermission('t1', 'desk', 'admin.users')).toBe(false)
    expect(await roleHasPermission('t1', 'ghost', 'incident.read')).toBe(false)
  })

  it('reads roles of THAT tenant only, and closes the session', async () => {
    runQuery.mockResolvedValue([])
    await tenantRoles('t-scope')
    expect(runQuery.mock.calls[0]![2]).toEqual({ tenantId: 't-scope' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('a role without a permission list is an integrity error', async () => {
    runQuery.mockResolvedValue([{ key: 'broken', name: null, permissions: null, isFactory: false }])
    await expect(rolePermissions('t1', 'broken')).rejects.toThrow(/role 'broken' has no permission list/)
  })

  it('a missing is_factory reads as a customer role, a missing name as null', async () => {
    runQuery.mockResolvedValue([{ key: 'desk', name: undefined, permissions: [], isFactory: undefined }])
    const role = (await tenantRoles('t1')).get('desk')!
    expect(role.isFactory).toBe(false)
    expect(role.name).toBeNull()
  })

  it('invalidateRoles forces a fresh read for that tenant', async () => {
    runQuery.mockResolvedValue([{ key: 'desk', name: null, permissions: [], isFactory: false }])
    await tenantRoles('t1')
    invalidateRoles('t1')
    await tenantRoles('t1')
    expect(runQuery).toHaveBeenCalledTimes(2)
  })

  it('a role write invalidates the cache: a new role is visible at once', async () => {
    runQuery.mockResolvedValueOnce([])
    expect((await tenantRoles('t1')).has('desk_lead')).toBe(false)
    txRun.mockResolvedValueOnce(none).mockResolvedValueOnce(rec({ keys: [] })).mockResolvedValueOnce(none)
    await createRole('t1', { name: 'Desk Lead', permissions: [] })
    runQuery.mockResolvedValueOnce([{ key: 'desk_lead', name: 'Desk Lead', permissions: [], isFactory: false }])
    expect((await tenantRoles('t1')).has('desk_lead')).toBe(true)
  })
})

describe('listRoles', () => {
  it('factory roles first in canonical order, then customer roles by name; counts are numbers', async () => {
    runQuery.mockResolvedValue([
      { key: 'zeta', name: 'Zeta', permissions: [], isFactory: false, userCount: 2 },
      { key: 'viewer', name: null, permissions: ['incident.read'], isFactory: true, userCount: { low: 1 } },
      { key: 'alpha', name: null, permissions: [], isFactory: false, userCount: null },
      { key: 'admin', name: null, permissions: ['admin.users'], isFactory: true, userCount: 1 },
      { key: 'beta', name: 'Beta', permissions: ['change.write', 'change.read'], isFactory: false, userCount: 0 },
    ])
    const roles = await listRoles('t1')
    // A customer role without a name sorts by its key.
    expect(roles.map((r) => r.key)).toEqual(['admin', 'viewer', 'alpha', 'beta', 'zeta'])
    expect(roles.find((r) => r.key === 'alpha')!.userCount).toBe(0)
    expect(roles.find((r) => r.key === 'zeta')!.userCount).toBe(2)
    // Catalogue order, whatever order the graph holds them in.
    expect(roles.find((r) => r.key === 'beta')!.permissions).toEqual(['change.read', 'change.write'])
    expect(runQuery.mock.calls[0]![2]).toEqual({ tenantId: 't1' })
  })

  it('an unknown permission stored on a role fails the listing instead of hiding it', async () => {
    runQuery.mockResolvedValue([{ key: 'x', name: 'X', permissions: ['root.all'], isFactory: false, userCount: 0 }])
    await expect(listRoles('t1')).rejects.toThrow(/Unknown permissions: root\.all/)
  })

  it('a non-list permissions value is refused', async () => {
    runQuery.mockResolvedValue([{ key: 'x', name: 'X', permissions: 'incident.read', isFactory: false, userCount: 0 }])
    await expect(listRoles('t1')).rejects.toThrow(/must be a list/)
  })
})

describe('writing roles', () => {
  it('createRole: a name longer than the limit is refused', async () => {
    expect(await errKey(createRole('t1', { name: 'x'.repeat(61), permissions: [] }))).toBe('errors.role.name')
    expect(await errKey(createRole('t1', { name: 42, permissions: [] }))).toBe('errors.role.name')
  })

  it('createRole: an empty key list from the graph still yields a key', async () => {
    txRun.mockResolvedValueOnce(none).mockResolvedValueOnce(none).mockResolvedValueOnce(none)
    const role = await createRole('t1', { name: 'Desk', permissions: [] })
    expect(role.key).toBe('desk')
  })

  it('updateRole: an unknown role is NotFound', async () => {
    txRun.mockResolvedValueOnce(none)
    expect(await errKey(updateRole('t1', 'ghost', { name: 'Ghost', permissions: [] }))).toBe('errors.notFound')
  })

  it('updateRole: renaming to a name another role already has is refused', async () => {
    txRun
      .mockResolvedValueOnce(rec({ name: 'Desk', permissions: [], isFactory: false, userCount: 0 }))
      .mockResolvedValueOnce(rec({ key: 'other' }))
    expect(await errKey(updateRole('t1', 'desk', { name: 'Other', permissions: [] }))).toBe('errors.role.nameTaken')
    // The duplicate check excludes the role itself, so keeping your own name is allowed.
    expect(txRun.mock.calls[1]![1]).toMatchObject({ exceptKey: 'desk', tenantId: 't1' })
  })

  it('updateRole: removing admin.users is allowed while someone else still has it', async () => {
    txRun
      .mockResolvedValueOnce(rec({ name: 'Leads', permissions: ['admin.users'], isFactory: false, userCount: 2 }))
      .mockResolvedValueOnce(none)                 // name free
      .mockResolvedValueOnce(rec({ n: 1 }))        // one admin remains
      .mockResolvedValueOnce(none)                 // SET
    const { before, after } = await updateRole('t1', 'leads', { name: 'Leads', permissions: [] })
    expect(before).toEqual({ key: 'leads', name: 'Leads', permissions: ['admin.users'], isFactory: false, userCount: 2 })
    expect(after).toEqual({ key: 'leads', name: 'Leads', permissions: [], isFactory: false, userCount: 2 })
    // The "what if" count is computed on this role with its NEW permissions.
    expect(txRun.mock.calls[2]![1]).toMatchObject({ roleKey: 'leads', permissions: [], perm: 'admin.users', tenantId: 't1' })
  })

  it('updateRole: a missing user count reads as zero', async () => {
    txRun
      .mockResolvedValueOnce(rec({ name: null, permissions: [], isFactory: true, userCount: null }))
      .mockResolvedValueOnce(none)
    // A factory role may be left without a name: undefined counts as "not renamed".
    const out = await updateRole('t1', 'viewer', { permissions: [] })
    expect(out.after).toEqual({ key: 'viewer', name: null, permissions: [], isFactory: true, userCount: 0 })
  })

  it('deleteRole: a role that is still a recipient somewhere is refused, naming the count', async () => {
    txRun
      .mockResolvedValueOnce(rec({ name: 'Desk', permissions: [], isFactory: false, userCount: 0 }))
      .mockResolvedValueOnce(rec({ n: 3 }))
    const err = await deleteRole('t1', 'desk').catch((e: unknown) => e) as { extensions: { i18n: { key: string; params: Record<string, unknown> } } }
    expect(err.extensions.i18n).toMatchObject({ key: 'errors.role.usedAsRecipient', params: { count: 3 } })
    // Both the plain target and the quoted JSON form are searched.
    expect(txRun.mock.calls[1]![1]).toEqual({ tenantId: 't1', target: 'role:desk', quoted: '"role:desk"' })
  })

  it('deleteRole: an unused customer role is deleted and returned', async () => {
    txRun
      .mockResolvedValueOnce(rec({ name: null, permissions: ['incident.read'], isFactory: false, userCount: null }))
      .mockResolvedValueOnce(none)
      .mockResolvedValueOnce(none)
    await expect(deleteRole('t1', 'desk')).resolves.toEqual({ key: 'desk', name: null, permissions: ['incident.read'], isFactory: false, userCount: 0 })
    expect(String(txRun.mock.calls[2]![0])).toContain('DETACH DELETE r')
    expect(txRun.mock.calls[2]![1]).toEqual({ tenantId: 't1', key: 'desk' })
  })

  it('setUserRole: an unknown person is NotFound; a missing previous role reads as empty', async () => {
    txRun.mockResolvedValueOnce(none)
    expect(await errKey(setUserRole('t1', 'ghost', 'viewer'))).toBe('errors.notFound')
    txRun.mockResolvedValueOnce(rec({ previousRole: null, roleExists: true, wasUsersAdmin: false })).mockResolvedValueOnce(none)
    await expect(setUserRole('t1', 'u1', 'viewer')).resolves.toEqual({ previousRole: '' })
  })

  it('setUserRole: moving an admin is fine while another admin remains', async () => {
    txRun
      .mockResolvedValueOnce(rec({ previousRole: 'admin', roleExists: true, wasUsersAdmin: true }))
      .mockResolvedValueOnce(rec({ n: 2 }))
      .mockResolvedValueOnce(none)
    await expect(setUserRole('t1', 'u1', 'viewer')).resolves.toEqual({ previousRole: 'admin' })
    expect(txRun.mock.calls[1]![1]).toMatchObject({ movedUserId: 'u1', movedToRole: 'viewer' })
  })
})

describe('setUserActiveInGraph', () => {
  it('you cannot deactivate yourself, and nothing is read', async () => {
    expect(await errKey(setUserActiveInGraph('t1', 'u1', false, 'u1'))).toBe('errors.user.deactivateSelf')
    expect(txRun).not.toHaveBeenCalled()
  })

  it('an unknown person is NotFound', async () => {
    txRun.mockResolvedValueOnce(none)
    expect(await errKey(setUserActiveInGraph('t1', 'ghost', false, 'u1'))).toBe('errors.notFound')
  })

  it('already in the requested state: no write, changed=false, name falls back to the e-mail', async () => {
    txRun.mockResolvedValueOnce(rec({ email: 'a@x.io', name: null, active: true }))
    await expect(setUserActiveInGraph('t1', 'u2', true, 'u1')).resolves.toEqual({ email: 'a@x.io', name: 'a@x.io', changed: false })
    expect(txRun).toHaveBeenCalledTimes(1)
  })

  it('deactivating the last person who manages people and roles is refused', async () => {
    txRun.mockResolvedValueOnce(rec({ email: 'a@x.io', name: 'Ann', active: true })).mockResolvedValueOnce(rec({ n: 0 }))
    expect(await errKey(setUserActiveInGraph('t1', 'u2', false, 'u1'))).toBe('errors.role.lastUsersAdmin')
    expect(txRun.mock.calls[1]![1]).toMatchObject({ deactivatedUserId: 'u2', tenantId: 't1' })
  })

  it('deactivation records who did it; reactivation needs no admin check', async () => {
    txRun.mockResolvedValueOnce(rec({ email: 'a@x.io', name: 'Ann', active: true })).mockResolvedValueOnce(rec({ n: 1 })).mockResolvedValueOnce(none)
    await expect(setUserActiveInGraph('t1', 'u2', false, 'u1')).resolves.toEqual({ email: 'a@x.io', name: 'Ann', changed: true })
    expect(txRun.mock.calls[2]![1]).toMatchObject({ tenantId: 't1', userId: 'u2', active: false, actorId: 'u1' })

    txRun.mockReset()
    txRun.mockResolvedValueOnce(rec({ email: 'a@x.io', name: 'Ann', active: false })).mockResolvedValueOnce(none)
    await expect(setUserActiveInGraph('t1', 'u2', true, 'u1')).resolves.toMatchObject({ changed: true })
    expect(txRun).toHaveBeenCalledTimes(2)
  })
})

describe('roles as recipients', () => {
  it('roleKeysInActions finds each quoted role once, and nothing in empty input', () => {
    expect(roleKeysInActions(null)).toEqual([])
    expect(roleKeysInActions('')).toEqual([])
    expect(roleKeysInActions(JSON.stringify([
      { type: 'notify', params: { to: 'role:desk' } },
      { type: 'notify', params: { to: 'role:desk' } },
      { type: 'notify', params: { to: 'role:change_manager' } },
      { type: 'notify', params: { to: 'user:u1' } },
    ]))).toEqual(['desk', 'change_manager'])
  })

  it('assertRolesExist: nothing to check reads nothing; a missing role is named', async () => {
    await assertRolesExist('t1', [])
    expect(runQuery).not.toHaveBeenCalled()
    runQuery.mockResolvedValue([{ key: 'desk', name: null, permissions: [], isFactory: false }])
    await expect(assertRolesExist('t1', ['desk'])).resolves.toBeUndefined()
    await expect(assertRolesExist('t1', ['desk', 'ghost', 'phantom'])).rejects.toThrow(/ghost, phantom/)
  })
})

describe('roleKeyFromName edge cases', () => {
  it('a name with no usable letters becomes "role", and a one-letter name is padded', () => {
    expect(roleKeyFromName('123 !!', new Set())).toBe('role')
    expect(roleKeyFromName('X', new Set())).toBe('x_role')
    expect(roleKeyFromName('Desk', new Set(['desk', 'desk_2']))).toBe('desk_3')
  })
})
