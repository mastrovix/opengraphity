/**
 * incident.ts — the GraphQL layer of the incident: list/detail, create and
 * update, assignments (and what they write to the audit log), CI links,
 * comments, and the field resolvers of the detail page.
 *
 * Why these matter to a user:
 *  - every query and write is scoped to the caller's tenant: an operator of one
 *    customer must never read or touch another customer's incident or CI;
 *  - the list prefetches assignee/team/CIs so the field resolvers must NOT
 *    run a query per row, and must fall back to a query on the detail page;
 *  - update hands over to the service (services/__tests__/incidentUpdate.test.ts
 *    pins its rules);
 *  - linking a CI that does not exist in the tenant must be an error, not a
 *    silent "ok" that shows an unchanged incident;
 *  - the audit log says who got the ticket, from whom, and does not record
 *    an "unassign" that unassigned nobody.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLResolveInfo } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const txRun = vi.fn()
const mockSession = {
  executeRead:  vi.fn(async (fn: (tx: { run: typeof txRun }) => unknown) => fn({ run: txRun })),
  executeWrite: vi.fn(async (fn: (tx: { run: typeof txRun }) => unknown) => fn({ run: txRun })),
  close: vi.fn(),
}

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn(),
  toNumber: (v: unknown) => Number(v ?? 0),
}))
vi.mock('../ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn(mockSession)),
  mapCI: (p: Record<string, unknown>) => ({ id: p['id'], name: p['name'], type: p['type'] }),
  ciTypeFromLabels: (_t: string, labels: string[]) => (labels[0] ? `type:${labels[0]}` : 'type:unknown'),
}))
vi.mock('../ticketCustomFields.js', () => ({ requestCustomFieldDefs: vi.fn().mockResolvedValue([{ name: 'cf_site' }]) }))
vi.mock('../../../lib/validateRequiredFields.js', () => ({
  validateRequiredFields: vi.fn().mockResolvedValue(undefined),
  propsToFieldValues: (p: Record<string, unknown>) => ({ ...p }),
}))
vi.mock('../../../lib/filterBuilder.js', () => ({ buildAdvancedWhere: vi.fn().mockReturnValue('i.title CONTAINS $f0') }))
vi.mock('../../../lib/schemaFields.js', () => ({ getScalarFields: vi.fn().mockReturnValue(['title', 'severity']) }))
vi.mock('../../../services/incidentService.js', () => ({
  createIncident: vi.fn(), updateIncident: vi.fn(), resolveIncident: vi.fn(), assignIncidentToTeam: vi.fn(), assignIncidentToUser: vi.fn(),
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/domainValue.js', () => ({ resolveDomainValue: vi.fn(async () => 'critical') }))
vi.mock('../../../lib/ciLabelsForTenant.js', () => ({ ciLabelPredicateForTenant: vi.fn().mockResolvedValue('ci:ConfigurationItem') }))
vi.mock('../../../lib/ticketCIExclusions.js', () => ({ assertCIsLinkable: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/slaAcknowledgement.js', () => ({ assertMayAcknowledgeNoSla: vi.fn() }))
vi.mock('../../../lib/ticketComments.js', () => ({ writeTicketComment: vi.fn() }))
vi.mock('../comments.js', () => ({ notifyCommentAudience: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/ciMetamodelForTenant.js', () => ({ serviceRelPatternForTenant: vi.fn().mockResolvedValue('DEPENDS_ON|HOSTED_ON') }))
vi.mock('../../../lib/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

const { incidentResolvers, INCIDENT_SORT_WHITELIST } = await import('../incident.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { buildAdvancedWhere } = await import('../../../lib/filterBuilder.js')
const { validateRequiredFields } = await import('../../../lib/validateRequiredFields.js')
const incidentService = await import('../../../services/incidentService.js')
const { audit } = await import('../../../lib/audit.js')
const { assertCIsLinkable } = await import('../../../lib/ticketCIExclusions.js')
const { assertMayAcknowledgeNoSla } = await import('../../../lib/slaAcknowledgement.js')
const { writeTicketComment } = await import('../../../lib/ticketComments.js')
const { notifyCommentAudience } = await import('../comments.js')
const { logger } = await import('../../../lib/logger.js')

const Q = incidentResolvers.Query
const M = incidentResolvers.Mutation
const F = incidentResolvers.Incident

const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'op@x.io', role: 'operator', permissions: perms('operator') }
const info = { schema: {} } as unknown as GraphQLResolveInfo

function rec(values: Record<string, unknown>) {
  return { get: (k: string) => values[k] }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(runQuery).mockReset()
  vi.mocked(runQueryOne).mockReset()
  txRun.mockReset()
  txRun.mockResolvedValue({ records: [] })
})

// ── Queries ──────────────────────────────────────────────────────────────────

describe('incidents (list)', () => {
  it('is tenant-scoped, prefetches assignee/team/CIs and returns the total from a Neo4j integer', async () => {
    vi.mocked(runQuery)
      .mockResolvedValueOnce([
        { props: { id: 'i1', title: 'DB down', tenant_id: 't1' }, uProps: { id: 'u9', name: 'Ada', email: 'a@x' }, tProps: { id: 'tm1', name: 'DBA' },
          cis: [{ props: { id: 'ci1', name: 'db-01' }, label: 'Database' }, { props: { id: 'ci2', name: 'x' }, label: '' }, { props: {}, label: 'Server' }] },
        { props: { id: 'i2', title: 'Slow', tenant_id: 't1' }, uProps: null, tProps: null, cis: [] },
      ] as never)
      .mockResolvedValueOnce([{ total: { toNumber: () => 42 } }] as never)

    const out = await Q.incidents(null, { status: 'open' }, ctx, info)

    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('MATCH (i:Incident {tenant_id: $tenantId})')
    expect(cypher).toContain('ORDER BY i.created_at DESC')
    expect(params).toMatchObject({ tenantId: 't1', status: 'open', severity: null, offset: 0, limit: 50 })
    expect(buildAdvancedWhere).not.toHaveBeenCalled()
    expect(out.total).toBe(42)

    const [first, second] = out.items as Array<Record<string, unknown>>
    expect(first).toMatchObject({ id: 'i1', _prefetched: true, assignee: expect.objectContaining({ id: 'u9' }), assignedTeam: expect.objectContaining({ id: 'tm1' }) })
    // Empty OPTIONAL MATCH rows (no id) are dropped; unlabeled CIs render as Application.
    expect(first!['affectedCIs']).toEqual([
      { id: 'ci1', name: 'db-01', type: 'type:Database', ciType: 'type:Database', __typename: 'Database' },
      { id: 'ci2', name: 'x', type: 'type:unknown', ciType: 'type:unknown', __typename: 'Application' },
    ])
    expect(second).toMatchObject({ assignee: null, assignedTeam: null, affectedCIs: [] })
  })

  it('advanced filters are built against the schema fields PLUS the tenant custom fields; sort is whitelisted', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([] as never).mockResolvedValueOnce([{ total: 3 }] as never)

    const out = await Q.incidents(null, { filters: '{"x":1}', sortField: 'number', sortDirection: 'asc', severity: 'high', limit: 10, offset: 20 }, ctx, info)

    const [filters, , allowed, alias] = vi.mocked(buildAdvancedWhere).mock.calls[0]!
    expect(filters).toBe('{"x":1}')
    expect([...allowed as Set<string>]).toEqual(['title', 'severity', 'cf_site'])
    expect(alias).toBe('i')
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('AND (i.title CONTAINS $f0)')
    expect(cypher).toContain('ORDER BY i.number ASC')
    expect(params).toMatchObject({ severity: 'high', limit: 10, offset: 20 })
    // The count query shares the same WHERE: the pager total matches the filter.
    expect(vi.mocked(runQuery).mock.calls[1]![1]).toContain('AND (i.title CONTAINS $f0)')
    expect(out).toEqual({ items: [], total: 3 })
    expect(Object.keys(INCIDENT_SORT_WHITELIST)).toContain('number')
  })

  it('a non-sortable field is an error, not a silently different order; no count row → total 0', async () => {
    await expect(Q.incidents(null, { sortField: 'assignee' }, ctx, info)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })

    vi.mocked(runQuery).mockResolvedValueOnce([] as never).mockResolvedValueOnce([] as never)
    await expect(Q.incidents(null, {}, ctx, info)).resolves.toEqual({ items: [], total: 0 })
  })
})

describe('incident (detail)', () => {
  it('reads by id AND tenant; another tenant\'s id → null', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'i1', title: 'x' } } as never).mockResolvedValueOnce(null as never)
    await expect(Q.incident(null, { id: 'i1' }, ctx)).resolves.toMatchObject({ id: 'i1' })
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ id: 'i1', tenantId: 't1' })
    await expect(Q.incident(null, { id: 'other' }, ctx)).resolves.toBeNull()
  })
})

// ── Mutations ────────────────────────────────────────────────────────────────

describe('createIncident', () => {
  it('validates required fields (custom fields included) and the no-SLA acknowledgement BEFORE creating', async () => {
    vi.mocked(incidentService.createIncident).mockResolvedValueOnce({ id: 'new-1' } as never)
    const input = { title: 'T', severity: 'high', acknowledgeNoSla: true, customFields: [{ name: 'cf_site', value: 'Milan' }] }

    const out = await M.createIncident(null, { input }, ctx)

    expect(validateRequiredFields).toHaveBeenCalledWith(mockSession, {
      entityType: 'incident', tenantId: 't1', fieldValues: expect.objectContaining({ title: 'T', cf_site: 'Milan' }),
    })
    expect(assertMayAcknowledgeNoSla).toHaveBeenCalledWith(ctx, true)
    expect(incidentService.createIncident).toHaveBeenCalledWith(input, ctx)
    expect(audit).toHaveBeenCalledWith(ctx, 'incident.created', 'Incident', 'new-1')
    expect(out).toEqual({ id: 'new-1' })
  })

  it('a missing required field stops the creation (nothing created, nothing audited)', async () => {
    vi.mocked(validateRequiredFields).mockRejectedValueOnce(new Error('category is required'))
    await expect(M.createIncident(null, { input: { title: 'T' } }, ctx)).rejects.toThrow(/category is required/)
    expect(incidentService.createIncident).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('updateIncident', () => {
  // The rules and the write are the service's (wave 7 · C1), pinned in
  // services/__tests__/incidentUpdate.test.ts; the resolver only hands over.
  it('delegates to the service with the id, the input and the caller', async () => {
    vi.mocked(incidentService.updateIncident).mockResolvedValueOnce({ id: 'i1' } as never)
    await expect(M.updateIncident(null, { id: 'i1', input: { title: 'n' } }, ctx)).resolves.toEqual({ id: 'i1' })
    expect(incidentService.updateIncident).toHaveBeenCalledWith('i1', { title: 'n' }, ctx)
  })
})

describe('resolveIncident', () => {
  it('delegates to the service with the root cause', async () => {
    vi.mocked(incidentService.resolveIncident).mockResolvedValueOnce({ id: 'i1', status: 'resolved' } as never)
    await expect(M.resolveIncident(null, { id: 'i1', rootCause: 'disk full' }, ctx)).resolves.toMatchObject({ status: 'resolved' })
    expect(incidentService.resolveIncident).toHaveBeenCalledWith('i1', ctx, 'disk full')
  })
})

describe('assignments and the audit log', () => {
  it('team change audits to/from; a member dropped by the team change gets its own unassign entry', async () => {
    vi.mocked(incidentService.assignIncidentToTeam).mockResolvedValueOnce({
      incident: { id: 'i1' }, teamName: 'DBA', previousTeamName: 'Net', unassignedUserName: 'Bob',
    } as never)

    await expect(M.assignIncidentToTeam(null, { id: 'i1', teamId: 'tm2' }, ctx)).resolves.toEqual({ id: 'i1' })

    expect(audit).toHaveBeenCalledWith(ctx, 'incident.assigned_team', 'Incident', 'i1', { teamId: 'tm2', to: 'DBA', from: 'Net' })
    expect(audit).toHaveBeenCalledWith(ctx, 'incident.unassigned_user', 'Incident', 'i1', { userId: null, to: null, from: 'Bob', reason: 'team_changed' })
  })

  it('team change that keeps the assignee → only the team entry', async () => {
    vi.mocked(incidentService.assignIncidentToTeam).mockResolvedValueOnce({
      incident: { id: 'i1' }, teamName: 'DBA', previousTeamName: null, unassignedUserName: null,
    } as never)
    await M.assignIncidentToTeam(null, { id: 'i1', teamId: 'tm2' }, ctx)
    expect(audit).toHaveBeenCalledTimes(1)
  })

  it('user assignment audits assigned_user with to/from', async () => {
    vi.mocked(incidentService.assignIncidentToUser).mockResolvedValueOnce({ incident: { id: 'i1' }, userName: 'Ada', previousUserName: 'Bob' } as never)
    await M.assignIncidentToUser(null, { id: 'i1', userId: 'u9' }, ctx)
    expect(audit).toHaveBeenCalledWith(ctx, 'incident.assigned_user', 'Incident', 'i1', { userId: 'u9', to: 'Ada', from: 'Bob' })
  })

  it('unassigning somebody audits unassigned_user; unassigning nobody writes nothing', async () => {
    vi.mocked(incidentService.assignIncidentToUser)
      .mockResolvedValueOnce({ incident: { id: 'i1' }, userName: null, previousUserName: 'Bob' } as never)
      .mockResolvedValueOnce({ incident: { id: 'i1' }, userName: null, previousUserName: null } as never)

    await M.assignIncidentToUser(null, { id: 'i1', userId: null }, ctx)
    expect(audit).toHaveBeenCalledWith(ctx, 'incident.unassigned_user', 'Incident', 'i1', { userId: null, to: null, from: 'Bob' })

    vi.mocked(audit).mockClear()
    await expect(M.assignIncidentToUser(null, { id: 'i1', userId: null }, ctx)).resolves.toEqual({ id: 'i1' })
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('addAffectedCI / removeAffectedCI', () => {
  it('checks the CI type is linkable for incidents, links inside the tenant and returns the re-read incident', async () => {
    txRun
      .mockResolvedValueOnce({ records: [rec({ linked: 1 })] })
      .mockResolvedValueOnce({ records: [rec({ props: { id: 'i1', title: 'x' } })] })

    const out = await M.addAffectedCI(null, { incidentId: 'i1', ciId: 'ci1' }, ctx)

    expect(assertCIsLinkable).toHaveBeenCalledWith('t1', 'incident', ['ci1'])
    const [cypher, params] = txRun.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toContain('MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})')
    expect(cypher).toContain('WHERE ci:ConfigurationItem')
    expect(params).toMatchObject({ incidentId: 'i1', ciId: 'ci1', tenantId: 't1' })
    expect(txRun.mock.calls[1]![1]).toEqual({ id: 'i1', tenantId: 't1' })
    expect(out).toMatchObject({ id: 'i1' })
  })

  it('an excluded CI type is refused before any write', async () => {
    vi.mocked(assertCIsLinkable).mockRejectedValueOnce(new Error('excluded type'))
    await expect(M.addAffectedCI(null, { incidentId: 'i1', ciId: 'ci1' }, ctx)).rejects.toThrow(/excluded type/)
    expect(txRun).not.toHaveBeenCalled()
  })

  it('a CI that does not exist in the tenant → ValidationError, not a silent success', async () => {
    txRun.mockResolvedValueOnce({ records: [rec({ linked: 0 })] })
    await expect(M.addAffectedCI(null, { incidentId: 'i1', ciId: 'foreign' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.ciLink.incident' } } })

    txRun.mockResolvedValueOnce({ records: [] })
    await expect(M.addAffectedCI(null, { incidentId: 'i1', ciId: 'foreign' }, ctx)).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } })
  })

  it('linked but the incident is not readable in the tenant → NotFound', async () => {
    txRun.mockResolvedValueOnce({ records: [rec({ linked: 1 })] }).mockResolvedValueOnce({ records: [] })
    await expect(M.addAffectedCI(null, { incidentId: 'i1', ciId: 'ci1' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })

  it('remove deletes only the tenant-scoped relation and returns the incident; unknown incident → NotFound', async () => {
    txRun.mockResolvedValueOnce({ records: [] }).mockResolvedValueOnce({ records: [rec({ props: { id: 'i1' } })] })
    await expect(M.removeAffectedCI(null, { incidentId: 'i1', ciId: 'ci1' }, ctx)).resolves.toMatchObject({ id: 'i1' })
    const [cypher, params] = txRun.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toContain('-[r:AFFECTED_BY]->(ci {id: $ciId, tenant_id: $tenantId})')
    expect(params).toMatchObject({ incidentId: 'i1', ciId: 'ci1', tenantId: 't1' })

    txRun.mockResolvedValueOnce({ records: [] }).mockResolvedValueOnce({ records: [] })
    await expect(M.removeAffectedCI(null, { incidentId: 'x', ciId: 'ci1' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })
})

describe('addIncidentComment', () => {
  const COMMENT = { comment: { id: 'c1', text: 'hi', is_internal: true, created_at: 'a', updated_at: 'b' }, author: { id: 'u1', name: 'Op', email: 'op@x.io' } }

  it('defaults to an INTERNAL note: a public reply to the requester must be asked for explicitly', async () => {
    vi.mocked(writeTicketComment).mockResolvedValueOnce(COMMENT as never)

    const out = await M.addIncidentComment(null, { id: 'i1', text: 'hi' }, ctx)

    expect(writeTicketComment).toHaveBeenCalledWith(mockSession, { entityType: 'incident', entityId: 'i1', tenantId: 't1', text: 'hi', authorId: 'u1', isInternal: true })
    expect(audit).toHaveBeenCalledWith(ctx, 'comment.added', 'Incident', 'i1', { commentId: 'c1', isInternal: true })
    expect(notifyCommentAudience).toHaveBeenCalledWith(ctx, 'incident', 'i1', 'hi', true)
    expect(out).toMatchObject({ id: 'c1', isInternal: true, author: expect.objectContaining({ id: 'u1' }), authorKind: null, authorLabel: null, editedAt: null })
  })

  it('isInternal:false makes a public comment; a null isInternal stays internal', async () => {
    vi.mocked(writeTicketComment).mockResolvedValue({ ...COMMENT, comment: { ...COMMENT.comment, is_internal: false } } as never)
    const out = await M.addIncidentComment(null, { id: 'i1', text: 'hi', isInternal: false }, ctx)
    expect(vi.mocked(writeTicketComment).mock.calls[0]![1]).toMatchObject({ isInternal: false })
    expect(out.isInternal).toBe(false)

    await M.addIncidentComment(null, { id: 'i1', text: 'hi', isInternal: null }, ctx)
    expect(vi.mocked(writeTicketComment).mock.calls[1]![1]).toMatchObject({ isInternal: true })
  })

  it('incident not in the tenant → NotFound, no audit and no notification', async () => {
    vi.mocked(writeTicketComment).mockResolvedValueOnce(null as never)
    await expect(M.addIncidentComment(null, { id: 'x', text: 'hi' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(audit).not.toHaveBeenCalled()
    expect(notifyCommentAudience).not.toHaveBeenCalled()
  })

  it('a failing notification is logged, the comment is still saved', async () => {
    vi.mocked(writeTicketComment).mockResolvedValueOnce(COMMENT as never)
    vi.mocked(notifyCommentAudience).mockRejectedValueOnce(new Error('smtp down'))
    await expect(M.addIncidentComment(null, { id: 'i1', text: 'hi' }, ctx)).resolves.toMatchObject({ id: 'c1' })
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ incidentId: 'i1' }), expect.stringContaining('NOT notified')))
  })
})

// ── Field resolvers ──────────────────────────────────────────────────────────

describe('Incident field resolvers', () => {
  const parent = { id: 'i1', tenantId: 't1' }

  it('prefetched rows (list) never hit the database', async () => {
    const pre = { ...parent, _prefetched: true, assignee: { id: 'u' }, assignedTeam: { id: 't' }, affectedCIs: [{ id: 'ci' }] }
    await expect(F.assignee(pre, {}, ctx)).resolves.toEqual({ id: 'u' })
    await expect(F.assignedTeam(pre, {}, ctx)).resolves.toEqual({ id: 't' })
    await expect(F.affectedCIs(pre, {}, ctx)).resolves.toEqual([{ id: 'ci' }])
    // Prefetched but empty → null, not undefined.
    await expect(F.assignee({ ...parent, _prefetched: true }, {}, ctx)).resolves.toBeNull()
    await expect(F.assignedTeam({ ...parent, _prefetched: true }, {}, ctx)).resolves.toBeNull()
    expect(runQuery).not.toHaveBeenCalled()
    expect(runQueryOne).not.toHaveBeenCalled()
    expect(txRun).not.toHaveBeenCalled()
  })

  it('assignedTeam on the detail page: tenant-scoped query, null when unassigned', async () => {
    txRun.mockResolvedValueOnce({ records: [rec({ t: { properties: { id: 'tm1', name: 'DBA' } } })] }).mockResolvedValueOnce({ records: [] })
    await expect(F.assignedTeam(parent, {}, ctx)).resolves.toMatchObject({ id: 'tm1', name: 'DBA' })
    expect(txRun.mock.calls[0]![1]).toEqual({ id: 'i1', tenantId: 't1' })
    await expect(F.assignedTeam(parent, {}, ctx)).resolves.toBeNull()
  })

  it('assignee on the detail page: tenant-scoped query, null when unassigned', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'u9', name: 'Ada' } } as never).mockResolvedValueOnce(null as never)
    await expect(F.assignee(parent, {}, ctx)).resolves.toMatchObject({ id: 'u9' })
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ id: 'i1', tenantId: 't1' })
    await expect(F.assignee(parent, {}, ctx)).resolves.toBeNull()
  })

  it('affectedCIs on the detail page: only CIs of the tenant, typed from their label', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([
      { props: { id: 'ci1', name: 'db' }, label: 'Database' },
      { props: { id: 'ci2', name: 'app' }, label: null },
    ] as never)
    const out = await F.affectedCIs(parent, {}, ctx)
    expect(vi.mocked(runQuery).mock.calls[0]![1]).toContain('WHERE ci.tenant_id = $tenantId')
    expect(out).toEqual([
      { id: 'ci1', name: 'db', type: 'type:Database', ciType: 'type:Database', __typename: 'Database' },
      { id: 'ci2', name: 'app', type: 'type:unknown', ciType: 'type:unknown', __typename: 'Application' },
    ])
  })

  it('impactedApplications uses the tenant service relations and returns the path affected → app', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([
      { props: { id: 'app1', name: 'Shop' }, label: 'Application', distance: { toString: () => '2' }, via: 'db-01',
        path: [{ id: 'ci1', name: 'db-01', type: 'Database' }, { id: 'app1', name: 'Shop', type: 'Application' }] },
      { props: { id: 'app2', name: 'Direct' }, label: '', distance: 0, via: null, path: [] },
    ] as never)

    const out = await F.impactedApplications(parent, {}, ctx)

    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain('[:DEPENDS_ON|HOSTED_ON*0..5]')
    expect(cypher).toContain("candidate.tenant_id = $tenantId AND 'Application' IN labels(candidate)")
    expect(params).toEqual({ id: 'i1', tenantId: 't1' })
    expect(out[0]).toEqual({
      ci: { id: 'app1', name: 'Shop', type: 'type:Application', ciType: 'type:Application', __typename: 'Application' },
      distance: 2, via: 'db-01',
      path: [{ id: 'ci1', name: 'db-01', type: 'type:Database' }, { id: 'app1', name: 'Shop', type: 'type:Application' }],
    })
    expect(out[1]).toMatchObject({ distance: 0, via: null, path: [], ci: { __typename: 'Application' } })
  })

  it('comments: authors are resolved in the tenant; system comments are labelled', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([
      { cProps: { id: 'c1', text: 'a', is_internal: false, created_at: '1', updated_at: '1' }, uProps: { id: 'u1', name: 'Op' } },
      { cProps: { id: 'c2', text: 'b', author_id: 'monitoring', created_at: '2', updated_at: '2', edited_at: 'e' }, uProps: null },
    ] as never)
    const out = await F.comments(parent, {}, ctx)
    expect(vi.mocked(runQuery).mock.calls[0]![1]).toContain('OPTIONAL MATCH (u:User {id: c.author_id, tenant_id: $tenantId})')
    expect(out[0]).toMatchObject({ id: 'c1', isInternal: false, author: expect.objectContaining({ id: 'u1' }), authorKind: null })
    expect(out[1]).toMatchObject({ id: 'c2', isInternal: false, author: null, authorKind: 'monitoring', editedAt: 'e' })
  })
})

describe('setIncidentMajor', () => {
  it('requires incident.write: a read-only role cannot declare a Major Incident', async () => {
    const viewer: GraphQLContext = { ...ctx, role: 'viewer', permissions: perms('viewer') }
    await expect(M.setIncidentMajor(null, { id: 'i1', major: true }, viewer)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('incident not in the tenant → NotFound, no event', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([] as never)
    await expect(M.setIncidentMajor(null, { id: 'x', major: false }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ id: 'x', tenantId: 't1', major: false })
    // Declaring one stops at the priority, before the flag.
    vi.mocked(runQueryOne).mockResolvedValueOnce(null as never)
    await expect(M.setIncidentMajor(null, { id: 'x', major: true }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(runQuery).toHaveBeenCalledTimes(1)
    expect(audit).not.toHaveBeenCalled()
  })

  it('an incident without a number publishes number:null', async () => {
    const { publishEvent } = await import('../../../lib/publishEvent.js')
    vi.mocked(runQueryOne).mockResolvedValueOnce({ severity: 'high', major: false } as never)
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'i1', title: 'x', severity: 'high', status: 'new' }, was: false }] as never)
    await M.setIncidentMajor(null, { id: 'i1', major: true }, ctx)
    expect(publishEvent).toHaveBeenCalledWith('incident.major_declared', 't1', 'u1', expect.objectContaining({ number: null }), expect.any(String))
    expect(audit).toHaveBeenCalledWith(ctx, 'incident.major_declared', 'Incident', 'i1')
  })
})
