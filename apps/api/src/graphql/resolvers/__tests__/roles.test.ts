/**
 * roleResolvers — the Roles page (list, create, edit, delete).
 *
 * Why it matters: the rules live in `lib/roles.ts`; this layer must (1) always
 * scope to the caller's tenant — a role key is only unique within a tenant, so
 * using anything but `ctx.tenantId` would edit another customer's role — and
 * (2) write an Audit Log entry that says precisely what changed. For an update
 * the entry carries the permissions ADDED and REMOVED: that diff is what an
 * auditor reads to answer "who gave this role the right to delete tickets".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const audit = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../lib/audit.js', () => ({ audit }))
vi.mock('../../../lib/roles.js', () => ({
  listRoles: vi.fn(), createRole: vi.fn(), updateRole: vi.fn(), deleteRole: vi.fn(),
}))

const lib = await import('../../../lib/roles.js')
const { roleResolvers } = await import('../roles.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'admin-1', userEmail: 'adm@test.io', role: 'admin', permissions: perms('admin') }
const role = (key: string, name: string, permissions: string[]) => ({ key, name, permissions }) as never

beforeEach(() => { vi.clearAllMocks() })

describe('Query.roles', () => {
  it('lists the roles of the caller tenant', async () => {
    vi.mocked(lib.listRoles).mockResolvedValue([role('agent', 'Agent', [])])
    expect(await roleResolvers.Query.roles(null, null, ctx)).toEqual([{ key: 'agent', name: 'Agent', permissions: [] }])
    expect(lib.listRoles).toHaveBeenCalledWith('tenant-1')
  })
})

describe('Mutation.createRole', () => {
  it('creates in the caller tenant and audits name and permissions', async () => {
    vi.mocked(lib.createRole).mockResolvedValue(role('night_shift', 'Night shift', ['incident.read']))
    const out = await roleResolvers.Mutation.createRole(null, { input: { name: 'Night shift', permissions: ['incident.read'] } }, ctx)
    expect(out).toMatchObject({ key: 'night_shift' })
    expect(lib.createRole).toHaveBeenCalledWith('tenant-1', { name: 'Night shift', permissions: ['incident.read'] })
    expect(audit).toHaveBeenCalledWith(ctx, 'role.created', 'Role', 'night_shift', { name: 'Night shift', permissions: ['incident.read'] })
  })

  it('a rejected creation is not audited', async () => {
    vi.mocked(lib.createRole).mockRejectedValue(new Error('name taken'))
    await expect(roleResolvers.Mutation.createRole(null, { input: { name: 'Agent', permissions: [] } }, ctx)).rejects.toThrow('name taken')
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('Mutation.updateRole', () => {
  it('audits exactly the permissions added and removed, with the old and new name', async () => {
    vi.mocked(lib.updateRole).mockResolvedValue({
      before: role('ops', 'Ops', ['incident.read', 'incident.write']),
      after:  role('ops', 'Operations', ['incident.read', 'change.write']),
    } as never)
    const out = await roleResolvers.Mutation.updateRole(null, { key: 'ops', input: { name: 'Operations', permissions: ['incident.read', 'change.write'] } }, ctx)
    expect(out).toMatchObject({ name: 'Operations' })
    expect(lib.updateRole).toHaveBeenCalledWith('tenant-1', 'ops', { name: 'Operations', permissions: ['incident.read', 'change.write'] })
    expect(audit).toHaveBeenCalledWith(ctx, 'role.updated', 'Role', 'ops', {
      previousName: 'Ops', name: 'Operations', added: ['change.write'], removed: ['incident.write'],
    })
  })

  it('an unchanged permission set audits empty diffs', async () => {
    vi.mocked(lib.updateRole).mockResolvedValue({ before: role('ops', 'Ops', ['a']), after: role('ops', 'Ops 2', ['a']) } as never)
    await roleResolvers.Mutation.updateRole(null, { key: 'ops', input: { name: 'Ops 2', permissions: ['a'] } }, ctx)
    expect(audit.mock.calls[0]![4]).toMatchObject({ added: [], removed: [] })
  })
})

describe('Mutation.deleteRole', () => {
  it('deletes in the caller tenant, audits what the role granted, returns true', async () => {
    vi.mocked(lib.deleteRole).mockResolvedValue(role('ops', 'Ops', ['incident.read']))
    expect(await roleResolvers.Mutation.deleteRole(null, { key: 'ops' }, ctx)).toBe(true)
    expect(lib.deleteRole).toHaveBeenCalledWith('tenant-1', 'ops')
    // The deleted role's permissions are kept in the log: after deletion they exist nowhere else.
    expect(audit).toHaveBeenCalledWith(ctx, 'role.deleted', 'Role', 'ops', { name: 'Ops', permissions: ['incident.read'] })
  })

  it('a role still in use is refused by the rules and nothing is audited', async () => {
    vi.mocked(lib.deleteRole).mockRejectedValue(new Error('role in use'))
    await expect(roleResolvers.Mutation.deleteRole(null, { key: 'ops' }, ctx)).rejects.toThrow('role in use')
    expect(audit).not.toHaveBeenCalled()
  })
})
