/**
 * resolvers/index.ts — the people resolvers that live in the root map
 * (users, user, createUser, setUserActive, setUserRole, updateUserTeams and
 * the User field resolvers), exercised through `buildResolvers` so the real
 * authorization policy wraps them exactly as in production.
 *
 * Why these matter for a user:
 * - Every read and write is scoped to the caller's tenant: a person of one
 *   organization must never be listed, read or edited from another.
 * - Only `admin.users` may create, (de)activate, re-role or re-team people;
 *   for setUserRole and updateUserTeams the policy is the ONLY check.
 * - createUser must never leave half a person: a duplicate e-mail touches
 *   nothing, and when the graph refuses after the realm account was created,
 *   that realm account is removed again.
 * - Deactivation goes graph first (the API refuses the token from then on),
 *   reactivation goes realm first (without an account the person cannot log in).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

type Tx = { run: ReturnType<typeof vi.fn> }
const tx: Tx = { run: vi.fn(async () => ({ records: [] })) }
const session = {
  executeWrite: vi.fn(async (fn: (t: Tx) => unknown) => fn(tx)),
  close: vi.fn(async () => undefined),
}
const getSession = vi.fn((..._a: unknown[]) => session)
const runQuery = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => [])
const runQueryOne = vi.fn(async (..._a: unknown[]): Promise<unknown> => null)

vi.mock('@opengraphity/neo4j', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opengraphity/neo4j')>()
  return {
    ...actual,
    getSession: (...a: unknown[]) => getSession(...a),
    runQuery: (...a: unknown[]) => runQuery(...a),
    runQueryOne: (...a: unknown[]) => runQueryOne(...a),
  }
})
vi.mock('../../../lib/roles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/roles.js')>()
  return {
    ...actual,
    tenantRoles: vi.fn(async () => new Map([
      ['admin', { key: 'admin', name: 'Administrator', permissions: ['admin.users', 'incident.read'] }],
      ['viewer', { key: 'viewer', name: 'Viewer', permissions: ['incident.read'] }],
    ])),
    setUserActiveInGraph: vi.fn(async () => ({ email: 'ann@test.io', name: 'Ann', changed: true })),
    setUserRole: vi.fn(async () => ({ previousRole: 'viewer' })),
  }
})
vi.mock('../../../lib/tenantUsers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/tenantUsers.js')>()
  return {
    ...actual,
    createRealmUser: vi.fn(async () => 'kc-1'),
    deleteRealmUser: vi.fn(async () => undefined),
    setRealmUserEnabled: vi.fn(async () => 'updated'),
  }
})
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn(async () => undefined) }))
vi.mock('../../../lib/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), trace: vi.fn() }
  return { logger: { ...l, child: () => l } }
})

const { buildResolvers, USER_SORT_WHITELIST } = await import('../index.js')
const { QueryError } = await import('@opengraphity/neo4j')
const roles = await import('../../../lib/roles.js')
const tenantUsers = await import('../../../lib/tenantUsers.js')
const { audit } = await import('../../../lib/audit.js')
const { logger } = await import('../../../lib/logger.js')

type Fn = (parent: unknown, args: unknown, ctx: GraphQLContext, info?: unknown) => Promise<unknown>
const resolvers = buildResolvers([]) as unknown as Record<string, Record<string, Fn>>
const Q = resolvers['Query']!
const M = resolvers['Mutation']!
const U = resolvers['User']!

const admin: GraphQLContext = { tenantId: 't1', userId: 'adm-1', userEmail: 'adm@test.io', role: 'admin', permissions: perms('admin') }
const operator: GraphQLContext = { ...admin, userId: 'op-1', role: 'operator', permissions: perms('operator') }

/** The policy wrapper throws synchronously, before the resolver's promise exists. */
const viaPolicy = (fn: () => unknown) => Promise.resolve().then(fn)

const annProps = { id: 'u-1', tenant_id: 't1', email: 'ann@test.io', name: 'Ann', role: 'viewer', created_at: '2026-01-01T00:00:00.000Z' }

beforeEach(() => {
  vi.clearAllMocks()
  tx.run.mockImplementation(async () => ({ records: [] }))
  runQuery.mockImplementation(async () => [])
  runQueryOne.mockImplementation(async () => null)
})

describe('Query.users / Query.user', () => {
  it('lists the people of the tenant, sorted by a whitelisted column', async () => {
    runQuery.mockResolvedValueOnce([{ props: { ...annProps, active: false, first_name: 'Ann', slack_id: 'S1' }, teamId: null }])
    const res = await Q['users']!(null, { sortField: 'email', sortDirection: 'DESC' }, admin)
    const [, cypher, params] = runQuery.mock.calls[0]!
    expect(cypher).toContain('ORDER BY u.email DESC')
    expect(params).toEqual({ tenantId: 't1' })
    // `active: false` must survive the mapping; missing optional fields become null.
    expect(res).toEqual([expect.objectContaining({ id: 'u-1', active: false, firstName: 'Ann', lastName: null, slackId: 'S1', code: 'Ann' })])
    expect(session.close).toHaveBeenCalled()
  })

  it('defaults to the name order and treats a missing `active` as active', async () => {
    runQuery.mockResolvedValueOnce([{ props: annProps, teamId: null }])
    const res = await Q['users']!(null, {}, admin) as Array<{ active: boolean }>
    expect(runQuery.mock.calls[0]![1]).toContain('ORDER BY u.name ASC')
    expect(res[0]!.active).toBe(true)
  })

  it('a non-sortable column is an error, not a silently different order (A-22)', async () => {
    await expect(Q['users']!(null, { sortField: 'password' }, admin)).rejects.toThrow()
    expect(runQuery).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalled()
    expect(Object.keys(USER_SORT_WHITELIST)).not.toContain('password')
  })

  it('reads one person in the tenant, or null when absent', async () => {
    runQueryOne.mockResolvedValueOnce({ props: annProps })
    expect(await Q['user']!(null, { id: 'u-1' }, admin)).toMatchObject({ id: 'u-1', email: 'ann@test.io' })
    expect(runQueryOne.mock.calls[0]![2]).toEqual({ id: 'u-1', tenantId: 't1' })
    expect(await Q['user']!(null, { id: 'ghost' }, admin)).toBeNull()
  })
})

describe('User field resolvers', () => {
  it('permissions of the signed-in person are the ones the API authorizes them with', async () => {
    const res = await U['permissions']!({ id: 'adm-1', role: 'viewer' }, {}, admin) as string[]
    expect(new Set(res)).toEqual(new Set(admin.permissions))
  })

  it('permissions of someone else come from their role in the tenant; unknown role → none', async () => {
    expect(await U['permissions']!({ id: 'u-1', role: 'viewer' }, {}, admin)).toEqual(['incident.read'])
    expect(await U['permissions']!({ id: 'u-1', role: 'gone' }, {}, admin)).toEqual([])
    expect(roles.tenantRoles).toHaveBeenCalledWith('t1')
  })

  it('roleName is the tenant name of the role, null for an unknown role', async () => {
    expect(await U['roleName']!({ role: 'admin' }, {}, admin)).toBe('Administrator')
    expect(await U['roleName']!({ role: 'gone' }, {}, admin)).toBeNull()
  })

  it('teams are read within the tenant only', async () => {
    runQuery.mockResolvedValueOnce([
      { props: { id: 'tm-1', tenant_id: 't1', name: 'Ops', description: null, type: 'support', created_at: '2026-02-02T00:00:00.000Z' } },
      { props: { id: 'tm-2', tenant_id: 't1', name: 'Dev' } },
    ])
    const res = await U['teams']!({ id: 'u-1' }, {}, admin)
    expect(runQuery.mock.calls[0]![1]).toContain('WHERE t.tenant_id = $tenantId')
    expect(runQuery.mock.calls[0]![2]).toEqual({ id: 'u-1', tenantId: 't1' })
    // A team without a creation date still gets a (non-null) string.
    expect(res).toEqual([
      expect.objectContaining({ id: 'tm-1', name: 'Ops', createdAt: '2026-02-02T00:00:00.000Z' }),
      expect.objectContaining({ id: 'tm-2', createdAt: '' }),
    ])
    expect(session.close).toHaveBeenCalled()
  })
})

describe('Mutation.createUser', () => {
  const input = { email: '  Ann@Test.IO ', name: ' Ann ', password: 'pw', role: 'viewer', teamIds: ['tm-1', 'tm-2'] }

  it('creates the person with a lower-case e-mail, trimmed name and the teams, in one transaction', async () => {
    runQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ n: 2 })
    const res = await M['createUser']!(null, { input }, admin)
    expect(tenantUsers.createRealmUser).toHaveBeenCalledWith('t1', { email: 'ann@test.io', name: 'Ann', password: 'pw' })
    expect(session.executeWrite).toHaveBeenCalledTimes(1)
    expect(tx.run).toHaveBeenCalledTimes(2)
    expect(tx.run.mock.calls[0]![1]).toMatchObject({ email: 'ann@test.io', name: 'Ann', role: 'viewer', tenantId: 't1' })
    expect(tx.run.mock.calls[1]![1]).toMatchObject({ teamIds: ['tm-1', 'tm-2'], tenantId: 't1' })
    expect(res).toMatchObject({ email: 'ann@test.io', name: 'Ann', role: 'viewer', active: true, tenantId: 't1' })
  })

  it('without teams only the person is written', async () => {
    await M['createUser']!(null, { input: { ...input, teamIds: [] } }, admin)
    expect(tx.run).toHaveBeenCalledTimes(1)
    // The team existence check is skipped too: only the e-mail lookup ran.
    expect(runQueryOne).toHaveBeenCalledTimes(1)
  })

  it('requires admin.users (policy wrapper)', async () => {
    await expect(viaPolicy(() => M['createUser']!(null, { input }, operator))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
    expect(tenantUsers.createRealmUser).not.toHaveBeenCalled()
  })

  it('a blank name is refused before anything is written', async () => {
    await expect(M['createUser']!(null, { input: { ...input, name: '   ' } }, admin)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    expect(getSession).not.toHaveBeenCalled()
  })

  it('an unknown role of the tenant is BAD_USER_INPUT', async () => {
    await expect(M['createUser']!(null, { input: { ...input, role: 'superuser' } }, admin))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.authz.invalidRole' } } })
    expect(tenantUsers.createRealmUser).not.toHaveBeenCalled()
  })

  it('an e-mail already in the graph touches nothing (no realm account, no password reset)', async () => {
    runQueryOne.mockResolvedValueOnce({ id: 'u-9' })
    await expect(M['createUser']!(null, { input }, admin)).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.user.emailExists' } } })
    expect(tenantUsers.createRealmUser).not.toHaveBeenCalled()
    expect(session.close).toHaveBeenCalled()
  })

  it('a team that is not in the tenant is NOT_FOUND (duplicates in the list count once)', async () => {
    runQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ n: 1 })
    await expect(M['createUser']!(null, { input: { ...input, teamIds: ['tm-1', 'tm-x'] } }, admin)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(tenantUsers.createRealmUser).not.toHaveBeenCalled()

    runQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ n: 1 })
    await M['createUser']!(null, { input: { ...input, teamIds: ['tm-1', 'tm-1'] } }, admin)
    expect(tenantUsers.createRealmUser).toHaveBeenCalledTimes(1)
  })

  it('a missing count row is treated as zero teams found', async () => {
    runQueryOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    await expect(M['createUser']!(null, { input }, admin)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })

  it('graph refuses with a uniqueness violation: realm account removed, reported as e-mail taken', async () => {
    const dup = new QueryError(new Error('exists'), 'CREATE (u:User)')
    Object.defineProperty(dup, 'code', { value: 'Neo.ClientError.Schema.ConstraintValidationFailed' })
    session.executeWrite.mockRejectedValueOnce(dup)
    await expect(M['createUser']!(null, { input: { ...input, teamIds: undefined } }, admin))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.user.emailExists' } } })
    expect(tenantUsers.deleteRealmUser).toHaveBeenCalledWith('t1', 'kc-1')
  })

  it('any other graph failure propagates as is, after removing the realm account; a failed cleanup is logged', async () => {
    session.executeWrite.mockRejectedValueOnce(new Error('db down'))
    vi.mocked(tenantUsers.deleteRealmUser).mockRejectedValueOnce(new Error('kc down'))
    await expect(M['createUser']!(null, { input: { ...input, teamIds: undefined } }, admin)).rejects.toThrow('db down')
    expect(tenantUsers.deleteRealmUser).toHaveBeenCalledWith('t1', 'kc-1')
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', email: 'ann@test.io' }), expect.any(String))
    expect(session.close).toHaveBeenCalled()
  })
})

describe('Mutation.setUserActive', () => {
  it('reactivation: realm first, then graph, audited only when the state changed', async () => {
    runQueryOne.mockResolvedValueOnce({ email: 'ann@test.io' }).mockResolvedValueOnce({ props: annProps })
    const res = await M['setUserActive']!(null, { userId: 'u-1', active: true }, admin)
    expect(tenantUsers.setRealmUserEnabled).toHaveBeenCalledWith('t1', 'ann@test.io', true)
    expect(roles.setUserActiveInGraph).toHaveBeenCalledWith('t1', 'u-1', true, 'adm-1')
    expect(vi.mocked(tenantUsers.setRealmUserEnabled).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(roles.setUserActiveInGraph).mock.invocationCallOrder[0]!)
    expect(audit).toHaveBeenCalledWith(admin, 'user.reactivated', 'User', 'u-1', {})
    expect(res).toMatchObject({ id: 'u-1' })
  })

  it('reactivating an unknown person is NOT_FOUND and the realm is not touched', async () => {
    await expect(M['setUserActive']!(null, { userId: 'ghost', active: true }, admin)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(tenantUsers.setRealmUserEnabled).not.toHaveBeenCalled()
  })

  it('reactivating an already active person writes no audit entry', async () => {
    runQueryOne.mockResolvedValueOnce({ email: 'ann@test.io' })
    vi.mocked(roles.setUserActiveInGraph).mockResolvedValueOnce({ email: 'ann@test.io', name: 'Ann', changed: false })
    await M['setUserActive']!(null, { userId: 'u-1', active: true }, admin)
    expect(audit).not.toHaveBeenCalled()
  })

  it('deactivation: graph first, then realm, audited with the realm outcome', async () => {
    vi.mocked(tenantUsers.setRealmUserEnabled).mockResolvedValueOnce('missing')
    await M['setUserActive']!(null, { userId: 'u-1', active: false }, admin)
    expect(vi.mocked(roles.setUserActiveInGraph).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(tenantUsers.setRealmUserEnabled).mock.invocationCallOrder[0]!)
    expect(tenantUsers.setRealmUserEnabled).toHaveBeenCalledWith('t1', 'ann@test.io', false)
    expect(audit).toHaveBeenCalledWith(admin, 'user.deactivated', 'User', 'u-1', { realmAccount: 'missing' })
  })

  it('deactivating an already inactive person writes no audit entry', async () => {
    vi.mocked(roles.setUserActiveInGraph).mockResolvedValueOnce({ email: 'ann@test.io', name: 'Ann', changed: false })
    await M['setUserActive']!(null, { userId: 'u-1', active: false }, admin)
    expect(audit).not.toHaveBeenCalled()
  })

  it('requires admin.users', async () => {
    await expect(viaPolicy(() => M['setUserActive']!(null, { userId: 'u-1', active: false }, operator))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
    expect(roles.setUserActiveInGraph).not.toHaveBeenCalled()
  })
})

describe('Mutation.setUserRole', () => {
  it('changes the role, audits previous and new role, returns the fresh person', async () => {
    runQueryOne.mockResolvedValueOnce({ props: { ...annProps, role: 'admin' } })
    const res = await M['setUserRole']!(null, { userId: 'u-1', role: 'admin' }, admin)
    expect(roles.setUserRole).toHaveBeenCalledWith('t1', 'u-1', 'admin')
    expect(audit).toHaveBeenCalledWith(admin, 'user.role_changed', 'User', 'u-1', { previousRole: 'viewer', role: 'admin' })
    expect(runQueryOne.mock.calls[0]![2]).toEqual({ userId: 'u-1', tenantId: 't1' })
    expect(res).toMatchObject({ role: 'admin' })
  })

  it('person vanished after the change → NOT_FOUND, session closed', async () => {
    await expect(M['setUserRole']!(null, { userId: 'u-1', role: 'admin' }, admin)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(session.close).toHaveBeenCalled()
  })

  it('the policy is the only guard here: without admin.users nothing changes', async () => {
    await expect(viaPolicy(() => M['setUserRole']!(null, { userId: 'u-1', role: 'admin' }, operator))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
    expect(roles.setUserRole).not.toHaveBeenCalled()
  })
})

describe('Mutation.updateUserTeams', () => {
  it('replaces the memberships in ONE transaction, tenant-scoped, and returns the person', async () => {
    runQueryOne.mockResolvedValueOnce({ props: annProps })
    const res = await M['updateUserTeams']!(null, { userId: 'u-1', teamIds: ['tm-1'] }, admin)
    expect(session.executeWrite).toHaveBeenCalledTimes(1)
    expect(tx.run.mock.calls[0]![0]).toContain('DELETE r')
    expect(tx.run.mock.calls[1]![0]).toContain('MATCH (t:Team {id: teamId, tenant_id: $tenantId})')
    expect(tx.run.mock.calls[1]![1]).toEqual({ userId: 'u-1', tenantId: 't1', teamIds: ['tm-1'] })
    expect(res).toMatchObject({ id: 'u-1' })
  })

  it('an unknown person is NOT_FOUND', async () => {
    await expect(M['updateUserTeams']!(null, { userId: 'ghost', teamIds: [] }, admin)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(session.close).toHaveBeenCalled()
  })

  it('the policy is the only guard here: without admin.users nothing is written', async () => {
    await expect(viaPolicy(() => M['updateUserTeams']!(null, { userId: 'u-1', teamIds: [] }, operator))).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
    expect(session.executeWrite).not.toHaveBeenCalled()
  })
})
