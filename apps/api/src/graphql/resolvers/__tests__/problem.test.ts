/**
 * The problem resolvers: list, detail, create/update, links to incidents and
 * CIs, assignment, workflow transitions, comments and the field resolvers.
 *
 * Why these behaviours matter:
 *  - every read and write is scoped to the caller's tenant: a missing
 *    `tenant_id` in a MATCH would show (or change) another customer's problem;
 *  - "not found" must be an error, not a silent success: an operator who links
 *    a CI that does not exist, or edits a problem that was deleted, has to be told;
 *  - the update distinguishes an EMPTY text field from an ABSENT one (B-17):
 *    otherwise a wrong workaround can never be cleared;
 *  - assignment publishes `problem.assigned` (B-18) and the SLA team event
 *    (SL-10): notification rules and SLA policies hang on them;
 *  - a transition whose step actions failed after commit is still a success,
 *    but the failures are surfaced to the UI instead of swallowed.
 * Deletion and search have their own files (problemDelete / problemSearch).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import type { GraphQLResolveInfo } from 'graphql'
import { perms } from '../../../lib/__tests__/testPermissions.js'

type Rec = { get: (k: string) => unknown }
const rec = (o: Record<string, unknown>): Rec => ({ get: (k: string) => o[k] })

const txRun = vi.fn(async (_cypher: string, _params?: Record<string, unknown>) => ({ records: [] as Rec[] }))
const session = {
  executeRead:  vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run: txRun })),
  executeWrite: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ run: txRun })),
  close:        vi.fn(async () => undefined),
}

vi.mock('@opengraphity/neo4j', () => ({
  runQuery:    vi.fn(async () => []),
  runQueryOne: vi.fn(async () => null),
  getSession:  vi.fn(() => session),
  toNumber:    (v: unknown) => Number(v ?? 0),
}))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { getAvailableTransitions: vi.fn(async () => [{ toStep: 'closed' }]) },
}))
// The pipeline of the transitions (wave 7 · B1): its guards are tested on their own.
const pipeline = vi.hoisted(() => ({ transitionTicket: vi.fn() }))
vi.mock('../../../services/ticketTransition.js', async () => {
  const { GraphQLError } = await import('graphql')
  return {
    transitionTicket: (...a: unknown[]) => pipeline.transitionTicket(...a),
    personActor: (c: { userId: string; permissions: unknown }) => ({ kind: 'person', userId: c.userId, permissions: c.permissions }),
    refusalError: (r: { message: string; code: string; i18n?: unknown }) => new GraphQLError(r.message, { extensions: { code: r.code, ...(r.i18n ? { i18n: r.i18n } : {}) } }),
  }
})
vi.mock('../ticketCustomFields.js', () => ({ requestCustomFieldDefs: vi.fn(async () => [{ name: 'cf_vendor' }]) }))
vi.mock('../ticketSlaStatus.js', () => ({ ticketSlaStatusResolver: vi.fn(() => vi.fn()) }))
vi.mock('../comments.js', () => ({ notifyCommentAudience: vi.fn(async () => undefined) }))
vi.mock('../../../lib/schemaFields.js', () => ({ getScalarFields: vi.fn(() => new Set(['title'])) }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn(async () => undefined) }))
vi.mock('../../../lib/ticketUpdated.js', () => ({ publishTicketUpdated: vi.fn(async () => undefined) }))
vi.mock('../../../lib/domainMatrix.js', () => ({ assertDomainValue: vi.fn(async (_t: string, _v: string, value: unknown) => value) }))
vi.mock('../../../lib/priority.js', () => ({
  resolvePriorityPatch: vi.fn(async () => ({ severity: 'high', impact: 'high', urgency: 'medium' })),
}))
vi.mock('../../../lib/validateRequiredFields.js', () => ({
  validateRequiredFields: vi.fn(async () => undefined),
  propsToFieldValues:     vi.fn((p: Record<string, unknown>) => ({ ...p })),
}))
vi.mock('../../../lib/slaAcknowledgement.js', () => ({ assertMayAcknowledgeNoSla: vi.fn() }))
vi.mock('../../../lib/ciLabelsForTenant.js', () => ({ ciLabelPredicateForTenant: vi.fn(async () => '(ci:Server)') }))
vi.mock('../../../lib/ticketCIExclusions.js', () => ({ assertCIsLinkable: vi.fn(async () => undefined) }))
vi.mock('../../../lib/ticketComments.js', () => ({ writeTicketComment: vi.fn() }))
vi.mock('../../../lib/workflowHelpers.js', () => ({ getStepNamesByPurpose: vi.fn(async () => ['known_error']) }))
vi.mock('../../../services/problemService.js', () => ({ createProblem: vi.fn() }))
vi.mock('../../../services/ticketAssignment.js', () => ({
  assertUserInAssignedTeam: vi.fn(async () => undefined),
  setTicketTeam:            vi.fn(async () => ({ teamName: 'DBA', previousTeamName: null, unassignedUserName: null })),
  setTicketUser:            vi.fn(async () => ({ userName: 'Ada', previousUserName: null })),
}))
vi.mock('@opengraphity/sla', () => ({
  cancelSLAJobs:            vi.fn(async () => undefined),
  getActiveOLAContractsFor: vi.fn(async () => []),
  cancelOLABreaches:        vi.fn(async () => undefined),
}))
vi.mock('node:fs/promises', () => ({ rm: vi.fn(async () => undefined) }))
vi.mock('../../../lib/logger.js', () => {
  const logger: Record<string, unknown> = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
  logger['child'] = () => logger
  return { logger }
})

const { problemResolvers, mapProblem } = await import('../problem.js')
const neo4j = await import('@opengraphity/neo4j')
const { workflowEngine } = await import('@opengraphity/workflow')
const { audit } = await import('../../../lib/audit.js')
const { publishEvent } = await import('../../../lib/publishEvent.js')
const { publishTicketUpdated } = await import('../../../lib/ticketUpdated.js')
const { assertDomainValue } = await import('../../../lib/domainMatrix.js')
const { validateRequiredFields } = await import('../../../lib/validateRequiredFields.js')
const { assertMayAcknowledgeNoSla } = await import('../../../lib/slaAcknowledgement.js')
const { assertCIsLinkable } = await import('../../../lib/ticketCIExclusions.js')
const { writeTicketComment } = await import('../../../lib/ticketComments.js')
const { notifyCommentAudience } = await import('../comments.js')
const problemService = await import('../../../services/problemService.js')
const assignment = await import('../../../services/ticketAssignment.js')
const { logger } = await import('../../../lib/logger.js')
const sla = await import('@opengraphity/sla')
const fs = await import('node:fs/promises')

const runQuery    = vi.mocked(neo4j.runQuery)
const runQueryOne = vi.mocked(neo4j.runQueryOne)

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') }
const info = { schema: {} } as unknown as GraphQLResolveInfo
const Q = problemResolvers.Query
const M = problemResolvers.Mutation
const F = problemResolvers.Problem

const PROBLEM = { id: 'p1', number: 'PRB0001', title: 'DB slow', status: 'new', created_at: '2026-09-01T00:00:00Z' }

beforeEach(() => {
  vi.clearAllMocks()
  runQuery.mockImplementation(async () => [])
  runQueryOne.mockImplementation(async () => null)
  txRun.mockImplementation(async () => ({ records: [] }))
})

describe('mapProblem', () => {
  it('maps snake_case props and keeps absent optional fields null (not invented defaults)', () => {
    const p = mapProblem({ id: 'p1', title: 'T', status: 'new', created_at: 'c', affected_users: '12', root_cause: 'rc' })
    expect(p).toMatchObject({ id: 'p1', number: '', priority: null, category: null, rootCause: 'rc', affectedUsers: 12, updatedAt: null })
    // B-25: no priority means no priority, not «medium».
    expect(mapProblem({ id: 'p2' }).affectedUsers).toBeNull()
  })
})

describe('Query.problems', () => {
  const row = {
    props: { ...PROBLEM },
    uProps: { id: 'u9', name: 'Ada', email: 'a@x' },
    tProps: { id: 't1', name: 'DBA' },
    cis: [{ props: { id: 'ci1', name: 'db01' }, label: 'Server' }, { props: {}, label: '' }, { props: { id: 'ci2', name: 'x' }, label: 'Database' }],
  }

  it('returns prefetched assignee, team and CIs, drops empty CI placeholders and counts the total', async () => {
    runQuery.mockImplementation(async (_s: unknown, cypher: string) =>
      (cypher.includes('count(p)') ? [{ total: { toNumber: () => 7 } }] : [row]) as never)
    const res = await Q.problems(undefined, { status: 'new', priority: 'high' }, ctx, info)
    expect(res.total).toBe(7)
    const item = res.items[0] as unknown as Record<string, unknown>
    expect(item['_prefetched']).toBe(true)
    expect(item['assignee']).toMatchObject({ id: 'u9' })
    expect(item['assignedTeam']).toMatchObject({ id: 't1' })
    const cis = item['affectedCIs'] as Array<Record<string, unknown>>
    // The OPTIONAL MATCH of a problem without CIs yields one empty map: it must not become a CI.
    expect(cis.map((c) => c['id'])).toEqual(['ci1', 'ci2'])
    expect(cis[0]).toMatchObject({ ciType: 'server', __typename: 'Server' })
    expect(cis[1]).toMatchObject({ ciType: 'database', __typename: 'Database' })
    // Tenant scoping and the filters travel as parameters.
    for (const call of runQuery.mock.calls) {
      expect(call[1]).toContain('MATCH (p:Problem {tenant_id: $tenantId})')
      expect(call[2]).toMatchObject({ tenantId: 'tenant-1', status: 'new', priority: 'high', search: null })
    }
  })

  it('handles a plain numeric total, rows without assignee/team, and an empty count', async () => {
    runQuery.mockImplementation(async (_s: unknown, cypher: string) =>
      (cypher.includes('count(p)') ? [{ total: 3 }] : [{ ...row, uProps: null, tProps: null, cis: [] }]) as never)
    const res = await Q.problems(undefined, {}, ctx, info)
    expect(res.total).toBe(3)
    expect(res.items[0]).toMatchObject({ assignee: null, assignedTeam: null, affectedCIs: [] })

    runQuery.mockImplementation(async () => [])
    expect((await Q.problems(undefined, {}, ctx, info)).total).toBe(0)
  })

  it('accepts advanced filters on customer fields and rejects filters on unknown fields', async () => {
    // cf_vendor comes from the customer's field definitions (wave 4).
    const filters = JSON.stringify({ logic: 'AND', rules: [{ field: 'cf_vendor', operator: 'equals', value: 'acme' }] })
    await Q.problems(undefined, { filters }, ctx, info)
    expect(runQuery.mock.calls[0]![1]).toMatch(/AND \(.*p\.cf_vendor/s)

    const bad = JSON.stringify({ logic: 'AND', rules: [{ field: 'secret_field', operator: 'equals', value: 'x' }] })
    await expect(Q.problems(undefined, { filters: bad }, ctx, info)).rejects.toThrow(/not allowed/)
  })

  it('orders by a whitelisted field and refuses an unknown sort field instead of reordering silently', async () => {
    await Q.problems(undefined, { sortField: 'number', sortDirection: 'asc' }, ctx, info)
    expect(runQuery.mock.calls[0]![1]).toMatch(/ORDER BY p\.number ASC/i)
    await expect(Q.problems(undefined, { sortField: 'password' }, ctx, info)).rejects.toThrow()
  })
})

describe('Query.problem', () => {
  it('reads by id within the tenant, null when absent', async () => {
    expect(await Q.problem(undefined, { id: 'p1' }, ctx)).toBeNull()
    runQueryOne.mockResolvedValueOnce({ props: PROBLEM } as never)
    expect(await Q.problem(undefined, { id: 'p1' }, ctx)).toMatchObject({ id: 'p1', title: 'DB slow' })
    expect(runQueryOne.mock.calls[1]![2]).toEqual({ id: 'p1', tenantId: 'tenant-1' })
  })
})

describe('Query.knownErrors', () => {
  it('adds the text search only when a non-blank term is given', async () => {
    runQuery.mockResolvedValueOnce([{ props: PROBLEM }] as never)
    const rows = await Q.knownErrors(undefined, { search: '  timeout ' }, ctx)
    expect(rows).toHaveLength(1)
    expect(runQuery.mock.calls[0]![1]).toContain('CONTAINS toLower($search)')
    expect(runQuery.mock.calls[0]![2]).toMatchObject({ search: 'timeout', tenantId: 'tenant-1' })

    await Q.knownErrors(undefined, { search: '   ' }, ctx)
    expect(runQuery.mock.calls[1]![1]).not.toContain('CONTAINS')
  })
})

describe('Mutation.createProblem', () => {
  it('validates required fields including custom fields, checks the no-SLA acknowledgement, audits', async () => {
    vi.mocked(problemService.createProblem).mockResolvedValueOnce({ ...PROBLEM } as never)
    const input = { title: 'DB slow', acknowledgeNoSla: true, customFields: [{ name: 'cf_vendor', value: 'acme' }] }
    const res = await M.createProblem(undefined, { input } as never, ctx)
    expect(res).toMatchObject({ id: 'p1' })
    // Mandatory-field rules apply to the customer's fields too.
    expect(vi.mocked(validateRequiredFields).mock.calls[0]![1].fieldValues).toMatchObject({ title: 'DB slow', cf_vendor: 'acme' })
    expect(assertMayAcknowledgeNoSla).toHaveBeenCalledWith(ctx, true)
    expect(audit).toHaveBeenCalledWith(ctx, 'problem.created', 'Problem', 'p1')
  })

  it('does not create anything when the no-SLA acknowledgement is not allowed', async () => {
    vi.mocked(assertMayAcknowledgeNoSla).mockImplementationOnce(() => { throw new Error('FORBIDDEN') })
    await expect(M.createProblem(undefined, { input: { title: 'x', acknowledgeNoSla: true } }, ctx)).rejects.toThrow('FORBIDDEN')
    expect(problemService.createProblem).not.toHaveBeenCalled()
  })
})

describe('Mutation.updateProblem', () => {
  it('NOT_FOUND before any write when the problem is not in the tenant', async () => {
    await expect(M.updateProblem(undefined, { id: 'p1', input: { title: 'x' } }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(runQuery).not.toHaveBeenCalled()
  })

  it('validates the resulting state, checks the category vocabulary and tells present-but-empty from absent', async () => {
    runQueryOne.mockResolvedValueOnce({ props: { ...PROBLEM, impact: 'low', urgency: 'low', workaround: 'old' } } as never)
    runQuery.mockResolvedValueOnce([{ props: { ...PROBLEM, workaround: null, updated_at: 'now' } }] as never)
    const res = await M.updateProblem(undefined, { id: 'p1', input: { category: 'database', workaround: '', impact: 'high' } }, ctx)
    expect(res).toMatchObject({ id: 'p1', workaround: null })
    // Validation sees persisted + patch, not the patch alone.
    expect(vi.mocked(validateRequiredFields).mock.calls[0]![1].fieldValues).toMatchObject({ title: 'DB slow', category: 'database' })
    expect(assertDomainValue).toHaveBeenCalledWith('tenant-1', 'category', 'database')
    const params = runQuery.mock.calls[0]![2] as Record<string, unknown>
    // B-17: an empty workaround clears it; an absent description is left alone.
    expect(params).toMatchObject({ workaroundGiven: true, workaround: '', descriptionGiven: false, rootCauseGiven: false, affectedUsersGiven: false })
    expect(params).toMatchObject({ priority: 'high', impact: 'high', urgency: 'medium', tenantId: 'tenant-1', title: null, category: 'database' })
    expect(audit).toHaveBeenCalledWith(ctx, 'problem.updated', 'Problem', 'p1')
    expect(publishTicketUpdated).toHaveBeenCalledWith(ctx, 'problem', 'p1', expect.objectContaining({ workaround: 'old' }), expect.objectContaining({ workaround: null }))
  })

  it('skips the category check when no category is given, and NOT_FOUND if the write matched nothing', async () => {
    runQueryOne.mockResolvedValueOnce({ props: PROBLEM } as never)
    runQuery.mockResolvedValueOnce([] as never)
    await expect(M.updateProblem(undefined, { id: 'p1', input: { title: 'x', description: 'd', rootCause: 'r', affectedUsers: 3 } }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(assertDomainValue).not.toHaveBeenCalled()
    expect(runQuery.mock.calls[0]![2]).toMatchObject({ title: 'x', description: 'd', rootCause: 'r', affectedUsers: 3 })
    expect(publishTicketUpdated).not.toHaveBeenCalled()
  })
})

describe('incident links', () => {
  it('link: merges within the tenant and returns the problem; NOT_FOUND if the problem is gone', async () => {
    runQueryOne.mockResolvedValueOnce({ props: PROBLEM } as never)
    expect(await M.linkIncidentToProblem(undefined, { problemId: 'p1', incidentId: 'i1' }, ctx)).toMatchObject({ id: 'p1' })
    expect(txRun.mock.calls[0]![0]).toContain('MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})')
    expect(txRun.mock.calls[0]![1]).toMatchObject({ tenantId: 'tenant-1', problemId: 'p1', incidentId: 'i1' })
    await expect(M.linkIncidentToProblem(undefined, { problemId: 'p1', incidentId: 'i1' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })

  it('unlink: a link that does not exist is an error, not a silent success', async () => {
    await expect(M.unlinkIncidentFromProblem(undefined, { problemId: 'p1', incidentId: 'i1' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND', i18n: { key: 'errors.link.problemIncidentNotFound' } } })
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('unlink: returns the problem after removing the link; NOT_FOUND if it vanished meanwhile', async () => {
    txRun.mockImplementation(async () => ({ records: [rec({ n: 1 })] }))
    runQueryOne.mockResolvedValueOnce({ props: PROBLEM } as never)
    expect(await M.unlinkIncidentFromProblem(undefined, { problemId: 'p1', incidentId: 'i1' }, ctx)).toMatchObject({ id: 'p1' })
    await expect(M.unlinkIncidentFromProblem(undefined, { problemId: 'p1', incidentId: 'i1' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })
})

describe('CI links', () => {
  it('add: refuses an excluded CI type before touching the graph', async () => {
    vi.mocked(assertCIsLinkable).mockRejectedValueOnce(new Error('excluded'))
    await expect(M.addCIToProblem(undefined, { problemId: 'p1', ciId: 'c1' }, ctx)).rejects.toThrow('excluded')
    expect(txRun).not.toHaveBeenCalled()
  })

  it('add: a CI that does not exist in the tenant is a validation error (C-2), not a mute MERGE', async () => {
    txRun.mockImplementation(async () => ({ records: [rec({ linked: 0 })] }))
    await expect(M.addCIToProblem(undefined, { problemId: 'p1', ciId: 'ghost' }, ctx))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.ciLink.problem', params: { ci: 'ghost' } } } })
    // No record at all counts as zero linked too.
    txRun.mockImplementation(async () => ({ records: [] }))
    await expect(M.addCIToProblem(undefined, { problemId: 'p1', ciId: 'ghost' }, ctx)).rejects.toThrow(/does not exist/)
  })

  it('add: uses the tenant CI label predicate and returns the problem; NOT_FOUND if it is gone', async () => {
    txRun.mockImplementation(async () => ({ records: [rec({ linked: 1 })] }))
    runQueryOne.mockResolvedValueOnce({ props: PROBLEM } as never)
    expect(await M.addCIToProblem(undefined, { problemId: 'p1', ciId: 'c1' }, ctx)).toMatchObject({ id: 'p1' })
    expect(txRun.mock.calls[0]![0]).toContain('WHERE (ci:Server)')
    await expect(M.addCIToProblem(undefined, { problemId: 'p1', ciId: 'c1' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })

  it('remove: deletes the tenant-scoped relation and returns the problem; NOT_FOUND if it is gone', async () => {
    runQueryOne.mockResolvedValueOnce({ props: PROBLEM } as never)
    expect(await M.removeCIFromProblem(undefined, { problemId: 'p1', ciId: 'c1' }, ctx)).toMatchObject({ id: 'p1' })
    expect(txRun.mock.calls[0]![0]).toContain('(ci {id: $ciId, tenant_id: $tenantId})')
    await expect(M.removeCIFromProblem(undefined, { problemId: 'p1', ciId: 'c1' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })
})

describe('assignment', () => {
  it('to a team: publishes the SLA team event and problem.assigned with the team name', async () => {
    runQueryOne.mockResolvedValueOnce({ props: PROBLEM } as never)
    await M.assignProblemToTeam(undefined, { problemId: 'p1', teamId: 't1' }, ctx)
    expect(assignment.setTicketTeam).toHaveBeenCalledWith(session, 'Problem', 'p1', 't1', 'tenant-1')
    expect(publishEvent).toHaveBeenCalledWith(expect.any(String), 'tenant-1', 'u1', { entity_type: 'problem', entity_id: 'p1', team_id: 't1' })
    expect(publishEvent).toHaveBeenCalledWith('problem.assigned', 'tenant-1', 'u1',
      { id: 'p1', title: 'DB slow', priority: 'medium', status: 'new', assignedTo: 'DBA' })
  })

  it('to a team: falls back to the id as title and empty status; NOT_FOUND without events', async () => {
    runQueryOne.mockResolvedValueOnce({ props: { id: 'p1', priority: 'low' } } as never)
    await M.assignProblemToTeam(undefined, { problemId: 'p1', teamId: 't1' }, ctx)
    expect(publishEvent).toHaveBeenLastCalledWith('problem.assigned', 'tenant-1', 'u1', expect.objectContaining({ title: 'p1', priority: 'low', status: '' }))
    vi.mocked(publishEvent).mockClear()
    await expect(M.assignProblemToTeam(undefined, { problemId: 'p1', teamId: 't1' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('to a user: checks team membership first, then assigns, publishes and audits', async () => {
    runQueryOne.mockResolvedValueOnce({ props: PROBLEM } as never)
    await M.assignProblemToUser(undefined, { problemId: 'p1', userId: 'u9' }, ctx)
    expect(assignment.assertUserInAssignedTeam).toHaveBeenCalledWith(session, 'Problem', 'p1', 'u9', 'tenant-1')
    expect(publishEvent).toHaveBeenCalledWith('problem.assigned', 'tenant-1', 'u1', expect.objectContaining({ assignedTo: 'Ada' }))
    expect(audit).toHaveBeenCalledWith(ctx, 'problem.assigned_user', 'Problem', 'p1', { userId: 'u9' })
  })

  it('to a user: a user outside the team is refused before anything is written', async () => {
    vi.mocked(assignment.assertUserInAssignedTeam).mockRejectedValueOnce(new Error('not in team'))
    await expect(M.assignProblemToUser(undefined, { problemId: 'p1', userId: 'u9' }, ctx)).rejects.toThrow('not in team')
    expect(assignment.setTicketUser).not.toHaveBeenCalled()
  })

  it('null user = unassign (B-18): no membership check, audited as unassignment', async () => {
    vi.mocked(assignment.setTicketUser).mockResolvedValueOnce({ userName: null, previousUserName: 'Ada' })
    runQueryOne.mockResolvedValueOnce({ props: { id: 'p1' } } as never)
    await M.assignProblemToUser(undefined, { problemId: 'p1', userId: null }, ctx)
    expect(assignment.assertUserInAssignedTeam).not.toHaveBeenCalled()
    expect(assignment.setTicketUser).toHaveBeenCalledWith(session, 'Problem', 'p1', null, 'tenant-1')
    expect(publishEvent).toHaveBeenCalledWith('problem.assigned', 'tenant-1', 'u1', { id: 'p1', title: 'p1', priority: 'medium', status: '', assignedTo: '—' })
    expect(audit).toHaveBeenCalledWith(ctx, 'problem.unassigned_user', 'Problem', 'p1', { userId: null })
  })

  it('to a user: NOT_FOUND when the problem is gone, nothing published', async () => {
    await expect(M.assignProblemToUser(undefined, { problemId: 'p1' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(publishEvent).not.toHaveBeenCalled()
  })
})

describe('Mutation.executeProblemTransition', () => {
  const transition = pipeline.transitionTicket
  const moved = (actionErrors: unknown[] = []) => ({ moved: true, actionErrors, entityType: 'problem', entityId: 'p1', fromStep: 'new', result: { success: true } })

  it('without a workflow instance it fails before asking the pipeline', async () => {
    await expect(M.executeProblemTransition(undefined, { problemId: 'p1', toStep: 'closed' }, ctx)).rejects.toThrow(/Workflow instance not found/)
    expect(transition).not.toHaveBeenCalled()
  })

  it('a refused transition is the refusal\'s error: its message, code and key', async () => {
    txRun.mockImplementation(async () => ({ records: [rec({ instanceId: 'wi1' })] }))
    transition.mockResolvedValueOnce({ moved: false, refusal: { guard: 'workflow', final: true, code: 'CONFLICT', message: 'guard failed', i18n: { key: 'errors.workflow.x' } } })
    await expect(M.executeProblemTransition(undefined, { problemId: 'p1', toStep: 'closed' }, ctx))
      .rejects.toMatchObject({ message: 'guard failed', extensions: { code: 'CONFLICT', i18n: { key: 'errors.workflow.x' } } })
  })

  // Review of 23 Sep 2026: the problem page skipped the rules «field required entering step X»,
  // and the approval named by the step; the pipeline checks them for every path.
  it('asks the pipeline as the person, with the permissions of the role, on a manual arc, with the notes', async () => {
    txRun.mockImplementation(async () => ({ records: [rec({ instanceId: 'wi1' })] }))
    transition.mockResolvedValueOnce(moved())
    runQueryOne.mockResolvedValueOnce({ props: { ...PROBLEM, status: 'closed' } } as never)
    const res = await M.executeProblemTransition(undefined, { problemId: 'p1', toStep: 'closed', notes: 'done' }, ctx)
    expect(res).toMatchObject({ status: 'closed', actionErrors: null })
    expect(transition).toHaveBeenCalledWith(session, {
      tenantId: 'tenant-1', instanceId: 'wi1', toStep: 'closed', notes: 'done', triggerType: 'manual',
      actor: { kind: 'person', userId: 'u1', permissions: ctx.permissions },
    })
  })

  it('step actions failed after commit: success, surfaced as actionErrors (the pipeline logs them)', async () => {
    txRun.mockImplementation(async () => ({ records: [rec({ instanceId: 'wi1' })] }))
    transition.mockResolvedValueOnce(moved(['notify: smtp down']))
    runQueryOne.mockResolvedValueOnce({ props: PROBLEM } as never)
    const res = await M.executeProblemTransition(undefined, { problemId: 'p1', toStep: 'closed' }, ctx)
    expect(res.actionErrors).toEqual(['notify: smtp down'])
  })

  it('NOT_FOUND when the problem cannot be re-read after the transition', async () => {
    txRun.mockImplementation(async () => ({ records: [rec({ instanceId: 'wi1' })] }))
    transition.mockResolvedValueOnce(moved())
    await expect(M.executeProblemTransition(undefined, { problemId: 'p1', toStep: 'closed' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
  })
})

describe('Mutation.addProblemComment', () => {
  const comment = { id: 'c1', text: 'hi', created_at: 'now', is_internal: true }

  it('without an explicit choice the comment is internal; audited and audience notified', async () => {
    vi.mocked(writeTicketComment).mockResolvedValueOnce({ comment, author: { id: 'u1', name: 'Me' } } as never)
    const res = await M.addProblemComment(undefined, { problemId: 'p1', text: 'hi' }, ctx)
    expect(res).toMatchObject({ id: 'c1', type: 'manual', isInternal: true, author: { id: 'u1' } })
    expect(vi.mocked(writeTicketComment).mock.calls[0]![1]).toMatchObject({ entityType: 'problem', entityId: 'p1', tenantId: 'tenant-1', authorId: 'u1', isInternal: true })
    expect(audit).toHaveBeenCalledWith(ctx, 'comment.added', 'Problem', 'p1', { commentId: 'c1', isInternal: true })
    expect(notifyCommentAudience).toHaveBeenCalledWith(ctx, 'problem', 'p1', 'hi', true)
  })

  it('isInternal=false makes it public; a failed notification is logged, not thrown', async () => {
    vi.mocked(writeTicketComment).mockResolvedValueOnce({ comment: { ...comment, is_internal: false }, author: null } as never)
    vi.mocked(notifyCommentAudience).mockRejectedValueOnce(new Error('queue down'))
    const res = await M.addProblemComment(undefined, { problemId: 'p1', text: 'hi', isInternal: false }, ctx)
    expect(res).toMatchObject({ isInternal: false, author: null })
    expect(vi.mocked(writeTicketComment).mock.calls[0]![1]).toMatchObject({ isInternal: false })
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled())
  })

  it('NOT_FOUND when the problem does not exist, no audit', async () => {
    vi.mocked(writeTicketComment).mockResolvedValueOnce(null as never)
    await expect(M.addProblemComment(undefined, { problemId: 'p1', text: 'hi' }, ctx)).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('Mutation.deleteProblem (storage and OLA edge cases)', () => {
  const admin: GraphQLContext = { ...ctx, role: 'admin', permissions: perms('admin') }

  it('a file that cannot be removed from storage is logged and the deletion still completes', async () => {
    txRun.mockImplementation(async () => ({ records: [rec({ files: ['/att/a.pdf', null, '/att/b.pdf'] })] }))
    vi.mocked(fs.rm).mockRejectedValueOnce(new Error('EACCES'))
    await expect(M.deleteProblem(undefined, { id: 'p1' }, admin)).resolves.toBe(true)
    // Null storage paths (attachments never uploaded) are skipped; the second file is still removed.
    expect(vi.mocked(fs.rm).mock.calls.map((c) => c[0])).toEqual(['/att/a.pdf', '/att/b.pdf'])
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ problemId: 'p1', file: '/att/a.pdf' }), expect.any(String))
    // No active OLA contract: nothing to cancel.
    expect(sla.cancelOLABreaches).not.toHaveBeenCalled()
    expect(publishEvent).toHaveBeenCalledWith('problem.deleted', 'tenant-1', 'u1', { id: 'p1' }, expect.any(String))
  })
})

describe('Problem field resolvers', () => {
  it('affectedCIs: prefetched lists are reused, otherwise read within the tenant', async () => {
    expect(await F.affectedCIs({ id: 'p1', _prefetched: true, affectedCIs: [{ id: 'x' }] }, {}, ctx)).toEqual([{ id: 'x' }])
    expect(await F.affectedCIs({ id: 'p1', _prefetched: true }, {}, ctx)).toEqual([])
    runQuery.mockResolvedValueOnce([{ props: { id: 'c1', name: 'db01' }, label: 'Server' }, { props: { id: 'c2' }, label: 'Database' }] as never)
    const cis = await F.affectedCIs({ id: 'p1' }, {}, ctx)
    expect(cis).toMatchObject([{ id: 'c1', ciType: 'server', __typename: 'Server' }, { id: 'c2', ciType: 'database', __typename: 'Database' }])
    expect(runQuery.mock.calls[0]![1]).toContain('ci.tenant_id = $tenantId')
  })

  it('workflowInstance: null without one, mapped otherwise', async () => {
    expect(await F.workflowInstance({ id: 'p1' }, {}, ctx)).toBeNull()
    txRun.mockImplementation(async () => ({ records: [rec({ wi: { properties: { id: 'wi1', current_step: 'new', status: 'active', created_at: 'a', updated_at: 'b' } } })] }))
    expect(await F.workflowInstance({ id: 'p1' }, {}, ctx)).toEqual({ id: 'wi1', currentStep: 'new', status: 'active', createdAt: 'a', updatedAt: 'b' })
  })

  it('availableTransitions: empty without an instance, the engine answer otherwise', async () => {
    expect(await F.availableTransitions({ id: 'p1' }, {}, ctx)).toEqual([])
    txRun.mockImplementation(async () => ({ records: [rec({ instanceId: 'wi1' })] }))
    expect(await F.availableTransitions({ id: 'p1' }, {}, ctx)).toEqual([{ toStep: 'closed' }])
    expect(workflowEngine.getAvailableTransitions).toHaveBeenCalledWith(session, 'wi1')
  })

  it('workflowHistory: maps executions, with nulls for an open step', async () => {
    txRun.mockImplementation(async () => ({ records: [
      rec({ e: { properties: { id: 'e1', step_name: 'new', entered_at: 'a', exited_at: 'b', duration_ms: '5', triggered_by: 'u1', trigger_type: 'manual', notes: 'n' } } }),
      rec({ e: { properties: { id: 'e2', step_name: 'wip', entered_at: 'b', triggered_by: 'u1', trigger_type: 'manual' } } }),
    ] }))
    const h = await F.workflowHistory({ id: 'p1' }, {}, ctx)
    expect(h[0]).toMatchObject({ id: 'e1', durationMs: 5, exitedAt: 'b', notes: 'n' })
    expect(h[1]).toMatchObject({ id: 'e2', durationMs: null, exitedAt: null, notes: null })
  })

  it('comments: mapped with their author, scoped to the tenant', async () => {
    runQuery.mockResolvedValueOnce([{ cProps: { id: 'c1', text: 't', created_at: 'a', type: 'system' }, uProps: null }] as never)
    const cs = await F.comments({ id: 'p1' }, {}, ctx)
    expect(cs[0]).toMatchObject({ id: 'c1', type: 'system', isInternal: false, author: null })
    expect(runQuery.mock.calls[0]![2]).toEqual({ id: 'p1', tenantId: 'tenant-1' })
  })

  it('assignee: prefetched or read; null when unassigned', async () => {
    expect(await F.assignee({ id: 'p1', _prefetched: true }, {}, ctx)).toBeNull()
    expect(await F.assignee({ id: 'p1', _prefetched: true, assignee: { id: 'u' } }, {}, ctx)).toEqual({ id: 'u' })
    expect(await F.assignee({ id: 'p1' }, {}, ctx)).toBeNull()
    runQueryOne.mockResolvedValueOnce({ props: { id: 'u9', name: 'Ada' } } as never)
    expect(await F.assignee({ id: 'p1' }, {}, ctx)).toMatchObject({ id: 'u9' })
  })

  it('assignedTeam: prefetched or read; null when unassigned', async () => {
    expect(await F.assignedTeam({ id: 'p1', _prefetched: true }, {}, ctx)).toBeNull()
    expect(await F.assignedTeam({ id: 'p1', _prefetched: true, assignedTeam: { id: 't' } }, {}, ctx)).toEqual({ id: 't' })
    expect(await F.assignedTeam({ id: 'p1' }, {}, ctx)).toBeNull()
    txRun.mockImplementation(async () => ({ records: [rec({ t: { properties: { id: 't1', name: 'DBA' } } })] }))
    expect(await F.assignedTeam({ id: 'p1' }, {}, ctx)).toMatchObject({ id: 't1', name: 'DBA' })
  })

  it('createdBy: null when unknown, mapped otherwise', async () => {
    expect(await F.createdBy({ id: 'p1' }, {}, ctx)).toBeNull()
    runQueryOne.mockResolvedValueOnce({ props: { id: 'u1', name: 'Me' } } as never)
    expect(await F.createdBy({ id: 'p1' }, {}, ctx)).toMatchObject({ id: 'u1' })
  })
})
