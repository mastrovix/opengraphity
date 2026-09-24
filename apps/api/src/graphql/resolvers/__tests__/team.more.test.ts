/**
 * team.ts — the rest of the Team resolver: the list, create/update, the
 * manager and change-manager designation, and the field resolvers.
 *
 * Why these behaviours matter for a user:
 *   - every query is scoped by `tenant_id`: a team or a CI of another tenant
 *     must never show up, nor be written to, from this tenant;
 *   - the list prefetches members/CIs/manager in one query, and the field
 *     resolvers must reuse that prefetch instead of hitting the database again
 *     (N+1 on the Teams page), while still working on a bare `team(id)`;
 *   - `updateTeam` touches only the fields sent: renaming a team must not wipe
 *     its type or sourcing, and an empty name is refused rather than saved;
 *   - there is only ONE change-manager team per tenant, and designating one
 *     back-fills the approvals of changes already waiting — otherwise those
 *     changes stay stuck in "approval" forever.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const mockSession = {
  run:          vi.fn(),
  executeRead:  vi.fn(),
  executeWrite: vi.fn(),
  close:        vi.fn().mockResolvedValue(undefined),
}

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../ci-utils.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../ci-utils.js')>()
  return {
    ...orig,
    withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
  }
})
vi.mock('../../../lib/ciLabelsForTenant.js', () => ({
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Server)`),
}))
vi.mock('../../../lib/domainMatrix.js', () => ({
  assertDomainValue: vi.fn(async (_t: string, _v: string, value: unknown) => {
    if (typeof value !== 'string' || value === '') throw new Error('team_type: value missing')
    return value
  }),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/cache.js', () => ({ cache: { invalidate: vi.fn() } }))
vi.mock('@opengraphity/schema-generator', () => ({ loadMetamodel: vi.fn(async () => []) }))
vi.mock('../../../services/change/approvalCreation.js', () => ({ backfillChangeManagerApprovals: vi.fn().mockResolvedValue(undefined) }))

const { teamResolvers } = await import('../team.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { audit } = await import('../../../lib/audit.js')
const { backfillChangeManagerApprovals } = await import('../../../services/change/approvalCreation.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'a@test.io', role: 'admin', permissions: perms('admin') }

type AnyResolver = (p: unknown, a: unknown, c: unknown) => Promise<unknown>
const Q = teamResolvers.Query as unknown as Record<string, AnyResolver>
const M = teamResolvers.Mutation as unknown as Record<string, AnyResolver>
const F = teamResolvers.Team as unknown as Record<string, AnyResolver>

const TEAM = { id: 'team-1', tenant_id: 'tenant-1', name: 'Network', created_at: '2026-01-01T00:00:00Z' }

beforeEach(() => {
  vi.clearAllMocks()
  mockSession.executeWrite.mockImplementation(async (fn: (tx: { run: typeof mockSession.run }) => unknown) => fn({ run: mockSession.run }))
  mockSession.run.mockResolvedValue({ records: [] })
})

describe('teams — one tenant-scoped query, prefetch for the field resolvers', () => {
  it('maps the prefetched members, CIs (typed from their label) and first manager', async () => {
    vi.mocked(runQuery).mockResolvedValue([{
      props: TEAM,
      members: [{ id: 'u-1' }],
      ownedCIs: [{ props: { id: 'ci-1', name: 'srv', created_at: 'x' }, label: 'Server' }],
      supportedCIs: [{ props: { id: 'ci-2', name: 'srv2', created_at: 'x' }, label: 'Server' }],
      managers: [{ id: 'mgr-1' }, { id: 'mgr-2' }],
    }] as never)

    const selecting = (...names: string[]) => ({ fieldNodes: [{ selectionSet: { selections: names.map((n) => ({ kind: 'Field', name: { value: n } })) } }], fragments: {} })
    const out = await Q['teams']!(null, {}, ctx, selecting('id', 'members', 'ownedCIs', 'supportedCIs', 'manager') as never) as Array<Record<string, unknown>>

    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('MATCH (t:Team {tenant_id: $tenantId})')
    // The CI comprehensions are tenant-scoped too: an edge from another
    // tenant's CI must not leak into this list.
    expect(cypher).toContain('WHERE oci.tenant_id = $tenantId')
    expect(cypher).toContain('WHERE sci.tenant_id = $tenantId')
    expect(cypher).toContain('ORDER BY t.name ASC')
    expect(cypher).not.toContain('WHERE t.')
    expect(params).toEqual({ tenantId: 'tenant-1', withMembers: true, withOwned: true, withSupported: true, withManager: true })
    expect(out[0]).toMatchObject({ id: 'team-1', name: 'Network', _members: [{ id: 'u-1' }], _manager: { id: 'mgr-1' } })
    expect((out[0]!['_ownedCIs'] as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'ci-1', type: 'server' })
    expect((out[0]!['_supportedCIs'] as Array<Record<string, unknown>>)[0]).toMatchObject({ id: 'ci-2' })
  })

  it('no manager → _manager is null (so the field resolver does not query again)', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ props: TEAM, members: [], ownedCIs: [], supportedCIs: [], managers: [] }] as never)
    const out = await Q['teams']!(null, {}, ctx) as Array<Record<string, unknown>>
    expect(out[0]!['_manager']).toBeNull()
  })

  it('applies the advanced filter on `type` and the whitelisted sort', async () => {
    vi.mocked(runQuery).mockResolvedValue([] as never)
    await Q['teams']!(null, {
      filters: JSON.stringify({ logic: 'and', rules: [{ field: 'type', operator: 'equals', value: 'owner' }] }),
      sortField: 'createdAt', sortDirection: 'desc',
    }, ctx)
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toMatch(/WHERE .*t\.type/)
    expect(cypher).toContain('ORDER BY t.created_at DESC')
    expect(params).toMatchObject({ tenantId: 'tenant-1', af_0: 'owner' })
  })

  it('an unknown sort field is refused, not silently replaced by the default order', async () => {
    await expect(Q['teams']!(null, { sortField: 'password' }, ctx)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('team(id) found → mapped team', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ props: TEAM } as never)
    await expect(Q['team']!(null, { id: 'team-1' }, ctx)).resolves.toMatchObject({ id: 'team-1', name: 'Network' })
  })
})

describe('createTeam', () => {
  it('writes the team in the caller tenant with a fresh id and audits it', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ props: TEAM }] as never)
    const out = await M['createTeam']!(null, { input: { name: 'Network', type: 'owner', sourcing: 'internal' } }, ctx)
    const params = vi.mocked(runQuery).mock.calls[0]![2] as Record<string, unknown>
    expect(params).toMatchObject({ tenantId: 'tenant-1', name: 'Network', description: null, type: 'owner', sourcing: 'internal' })
    expect(params['id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(out).toMatchObject({ id: 'team-1' })
    expect(audit).toHaveBeenCalledWith(ctx, 'team.created', 'Team', params['id'])
  })

  it('a missing sourcing is refused before any write (no silent default)', async () => {
    await expect(M['createTeam']!(null, { input: { name: 'X', type: 'owner' } }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('the write returning nothing is a loud error, not an undefined team', async () => {
    vi.mocked(runQuery).mockResolvedValue([] as never)
    await expect(M['createTeam']!(null, { input: { name: 'X', type: 'owner', sourcing: 'external', description: 'd' } }, ctx))
      .rejects.toThrow('Failed to create Team')
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('updateTeam — only the fields sent are touched', () => {
  const setClause = () => String(vi.mocked(runQueryOne).mock.calls[0]![1])
  const params = () => vi.mocked(runQueryOne).mock.calls[0]![2] as Record<string, unknown>

  beforeEach(() => vi.mocked(runQueryOne).mockResolvedValue({ props: TEAM } as never))

  it('rename only: the name is trimmed and nothing else is SET', async () => {
    await M['updateTeam']!(null, { id: 'team-1', input: { name: '  Network  ' } }, ctx)
    expect(setClause()).toContain('t.name = $name')
    expect(setClause()).not.toContain('t.type')
    expect(setClause()).not.toContain('t.sourcing')
    expect(setClause()).not.toContain('t.description')
    expect(params()).toMatchObject({ id: 'team-1', tenantId: 'tenant-1', name: 'Network' })
    expect(audit).toHaveBeenCalledWith(ctx, 'team.updated', 'Team', 'team-1')
  })

  it('a blank name is refused (a team with no name cannot be picked anywhere)', async () => {
    await expect(M['updateTeam']!(null, { id: 'team-1', input: { name: '   ' } }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('description: null and blank both clear it; text is trimmed', async () => {
    await M['updateTeam']!(null, { id: 'team-1', input: { description: null } }, ctx)
    expect(params()['description']).toBeNull()
    vi.mocked(runQueryOne).mockClear()
    await M['updateTeam']!(null, { id: 'team-1', input: { description: '   ' } }, ctx)
    expect(params()['description']).toBeNull()
    vi.mocked(runQueryOne).mockClear()
    await M['updateTeam']!(null, { id: 'team-1', input: { description: ' Core network ' } }, ctx)
    expect(params()['description']).toBe('Core network')
  })

  it('sourcing and type are validated and written', async () => {
    await M['updateTeam']!(null, { id: 'team-1', input: { sourcing: 'external', type: 'support' } }, ctx)
    expect(setClause()).toContain('t.sourcing = $sourcing')
    expect(setClause()).toContain('t.type = $type')
    expect(params()).toMatchObject({ sourcing: 'external', type: 'support' })
  })

  it('sourcing cannot be removed: null is a refusal, not "leave as is"', async () => {
    await expect(M['updateTeam']!(null, { id: 'team-1', input: { sourcing: null } }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
  })

  it('a team of another tenant → NOT_FOUND', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null as never)
    await expect(M['updateTeam']!(null, { id: 'team-x', input: { name: 'N' } }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('assignCIOwner — removal on a CI type unknown to the metamodel', () => {
  it('no metamodel type for the label → removal goes through (nothing to enforce)', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ label: 'Legacy' } as never)
    vi.mocked(runQuery).mockResolvedValue([{ props: { id: 'ci-1', name: 'x', created_at: 'x' }, label: 'Legacy' }] as never)
    await expect(M['assignCIOwner']!(null, { ciId: 'ci-1', teamId: null }, ctx)).resolves.toMatchObject({ id: 'ci-1' })
    expect(audit).toHaveBeenCalledWith(ctx, 'ci.updated', 'ConfigurationItem', 'ci-1', { ownerGroupId: null })
  })

  it('support group change audits `supportGroupId`', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ props: { id: 'ci-1', name: 'x', created_at: 'x' }, label: 'Server' }] as never)
    await M['assignCISupportGroup']!(null, { ciId: 'ci-1', teamId: 'team-2' }, ctx)
    expect(audit).toHaveBeenCalledWith(ctx, 'ci.updated', 'ConfigurationItem', 'ci-1', { supportGroupId: 'team-2' })
  })
})

describe('Team field resolvers — reuse the prefetch, else query scoped to the tenant', () => {
  it('members: prefetched list returned as is, no query', async () => {
    await expect(F['members']!({ id: 'team-1', _members: [{ id: 'u-1' }] }, {}, ctx)).resolves.toEqual([{ id: 'u-1' }])
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('members: without prefetch → mapped users (camelCase, non-null fields filled)', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ props: { id: 'u-1', tenant_id: 'tenant-1', email: 'a@x', name: 'Ann', role: 'operator', created_at: 'x' } }] as never)
    const out = await F['members']!({ id: 'team-1' }, {}, ctx) as Array<Record<string, unknown>>
    expect(out[0]).toMatchObject({ id: 'u-1', tenantId: 'tenant-1' })
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toEqual({ id: 'team-1', tenantId: 'tenant-1' })
  })

  it('ownedCIs / supportedCIs: prefetch reused, otherwise tenant-scoped query with typed CIs', async () => {
    await expect(F['ownedCIs']!({ id: 'team-1', _ownedCIs: ['a'] }, {}, ctx)).resolves.toEqual(['a'])
    await expect(F['supportedCIs']!({ id: 'team-1', _supportedCIs: ['b'] }, {}, ctx)).resolves.toEqual(['b'])
    expect(runQuery).not.toHaveBeenCalled()

    vi.mocked(runQuery).mockResolvedValue([{ props: { id: 'ci-1', name: 'srv', created_at: 'x' }, label: 'Server' }] as never)
    const owned = await F['ownedCIs']!({ id: 'team-1' }, {}, ctx) as Array<Record<string, unknown>>
    expect(owned[0]).toMatchObject({ id: 'ci-1', type: 'server' })
    expect(String(vi.mocked(runQuery).mock.calls[0]![1])).toContain('<-[:OWNED_BY]-(n)')
    expect(String(vi.mocked(runQuery).mock.calls[0]![1])).toContain('WHERE n.tenant_id = $tenantId')

    vi.mocked(runQuery).mockResolvedValue([{ props: { id: 'ci-2', name: 'srv', created_at: 'x' }, label: 'Server' }] as never)
    const supported = await F['supportedCIs']!({ id: 'team-1' }, {}, ctx) as Array<Record<string, unknown>>
    expect(supported[0]).toMatchObject({ id: 'ci-2', type: 'server' })
    expect(String(vi.mocked(runQuery).mock.calls[1]![1])).toContain('<-[:SUPPORTED_BY]-(n)')
  })

  it('manager: a prefetched null is an answer (no query); otherwise mapped user or null', async () => {
    await expect(F['manager']!({ id: 'team-1', _manager: null }, {}, ctx)).resolves.toBeNull()
    expect(runQueryOne).not.toHaveBeenCalled()

    vi.mocked(runQueryOne).mockResolvedValue({ props: { id: 'mgr-1', tenant_id: 'tenant-1', created_at: 'x' } } as never)
    await expect(F['manager']!({ id: 'team-1' }, {}, ctx)).resolves.toMatchObject({ id: 'mgr-1', tenantId: 'tenant-1' })
    vi.mocked(runQueryOne).mockResolvedValue(null as never)
    await expect(F['manager']!({ id: 'team-1' }, {}, ctx)).resolves.toBeNull()
  })
})

describe('setTeamManager / removeTeamManager', () => {
  it('setTeamManager drops the old MANAGED_BY edge first, then links the new one', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ props: TEAM } as never)
    await expect(M['setTeamManager']!(null, { teamId: 'team-1', userId: 'u-2' }, ctx)).resolves.toMatchObject({ id: 'team-1' })
    expect(String(mockSession.run.mock.calls[0]![0])).toContain('DELETE r')
    expect(mockSession.run.mock.calls[0]![1]).toEqual({ teamId: 'team-1', tenantId: 'tenant-1' })
    expect(audit).toHaveBeenCalledWith(ctx, 'team.manager_set', 'Team', 'team-1')
  })

  it('removeTeamManager: returns the team, NOT_FOUND on another tenant', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ props: TEAM } as never)
    await expect(M['removeTeamManager']!(null, { teamId: 'team-1' }, ctx)).resolves.toMatchObject({ id: 'team-1' })
    expect(audit).toHaveBeenCalledWith(ctx, 'team.manager_removed', 'Team', 'team-1')

    vi.mocked(runQueryOne).mockResolvedValue(null as never)
    await expect(M['removeTeamManager']!(null, { teamId: 'team-x' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })
})

describe('setChangeManagerTeam — one per tenant, and waiting changes get the approval', () => {
  it('value=true: clears the flag on the OTHER teams of the tenant, sets it, back-fills approvals', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ props: { ...TEAM, is_change_manager: true } } as never)
    const out = await M['setChangeManagerTeam']!(null, { teamId: 'team-1', value: true }, ctx)
    const [resetCypher, resetParams] = mockSession.run.mock.calls[0]!
    expect(resetCypher).toContain('t.id <> $teamId')
    expect(resetCypher).toContain('SET t.is_change_manager = false')
    expect(resetParams).toEqual({ teamId: 'team-1', tenantId: 'tenant-1' })
    expect(backfillChangeManagerApprovals).toHaveBeenCalledWith(mockSession, 'tenant-1', 'team-1')
    expect(out).toMatchObject({ isChangeManager: true })
    expect(audit).toHaveBeenCalledWith(ctx, 'team.change_manager_set', 'Team', 'team-1')
  })

  it('value=false: no reset of other teams and no back-fill', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ props: TEAM } as never)
    await M['setChangeManagerTeam']!(null, { teamId: 'team-1', value: false }, ctx)
    expect(mockSession.run).not.toHaveBeenCalled()
    expect(backfillChangeManagerApprovals).not.toHaveBeenCalled()
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ teamId: 'team-1', tenantId: 'tenant-1', value: false })
  })

  it('team of another tenant → NOT_FOUND and no back-fill', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null as never)
    await expect(M['setChangeManagerTeam']!(null, { teamId: 'team-x', value: true }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(backfillChangeManagerApprovals).not.toHaveBeenCalled()
  })
})
