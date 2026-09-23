/**
 * incidentService — the operations incidentService.test.ts does not reach:
 * comments from system actors, title changes from automatic channels, the
 * rollback paths of createIncident, resolution, team/person assignment with
 * the workflow auto-advance, in-progress/close/escalate events.
 *
 * Why these matter for a user:
 *  - every read/write is scoped by `tenant_id`: an operation on an id of
 *    another tenant must end in "not found", never touch that ticket;
 *  - an incident whose workflow instance could not be started must be removed,
 *    otherwise it stays in the graph numbered but impossible to move or close;
 *  - a transition refused by the engine must stop the event (`incident.resolved`,
 *    `incident.escalated`): SLA and notifications would treat as resolved a
 *    ticket that is still open for the people working on it;
 *  - an assignment that was saved but could not auto-advance says so AFTER the
 *    assignment and its events, so neither the choice nor the notice is lost;
 *  - the auto-advance target is decided by the workflow (lowest step_order,
 *    then name), not by the order the graph happens to return the edges.
 * Every collaborator is a test double: no graph, no queue, no Redis.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

type Row = Record<string, unknown> | null

const h = vi.hoisted(() => {
  const state = {
    payload: null as Record<string, unknown> | null,
    wi: null as Record<string, unknown> | null,
    props: null as Record<string, unknown> | null,
  }
  const runs: Array<{ cypher: string; params: Record<string, unknown> }> = []
  const rec = (o: Record<string, unknown>) => ({ get: (k: string) => o[k] })
  const tx = {
    run: async (cypher: string, params: Record<string, unknown>) => {
      runs.push({ cypher, params })
      if (cypher.includes('collect(ci.name)')) return { records: state.payload ? [rec(state.payload)] : [] }
      if (cypher.includes('wi.current_step AS currentStep')) return { records: state.wi ? [rec(state.wi)] : [] }
      if (cypher.includes('RETURN properties(i) AS props')) return { records: state.props ? [rec({ props: state.props })] : [] }
      return { records: [] }
    },
  }
  const session = {
    executeRead: async (fn: (t: typeof tx) => unknown) => fn(tx),
    executeWrite: async (fn: (t: typeof tx) => unknown) => fn(tx),
  }
  return { state, runs, session }
})

vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), runQueryOne: vi.fn(), getSession: vi.fn() }))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { createInstance: vi.fn(), transition: vi.fn(), getAvailableTransitions: vi.fn() },
}))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  withSession: vi.fn(async (fn: (s: unknown) => unknown) => fn(h.session)),
  getSession: vi.fn(),
}))
vi.mock('../../lib/mappers.js', () => ({ mapIncident: vi.fn((p: Record<string, unknown>) => ({ ...p })) }))
vi.mock('../../lib/ticketNumbering.js', () => ({ nextTicketNumber: vi.fn(async () => 'INC00000042') }))
vi.mock('../../lib/priority.js', () => ({
  resolveNewTicketPriority: vi.fn(async () => ({ severity: 'high', impact: 'high', urgency: 'medium' })),
}))
vi.mock('../../lib/workflowHelpers.js', () => ({ getInitialStepName: vi.fn(), getWorkflowSteps: vi.fn() }))
vi.mock('../../lib/workflowTargets.js', () => ({ targetStepByCategory: vi.fn(async () => 'escalated') }))
vi.mock('../../lib/ciLabelsForTenant.js', () => ({ ciLabelPredicateForTenant: vi.fn(async () => '(ci:Server)') }))
vi.mock('../ticketAssignment.js', () => ({
  assertUserInAssignedTeam: vi.fn(),
  setTicketTeam: vi.fn(),
  setTicketUser: vi.fn(),
}))
vi.mock('../../lib/systemText.js', () => ({
  systemText: vi.fn(async (_t: string, key: string, params: Record<string, unknown> = {}) => `${key}|${JSON.stringify(params)}`),
}))
vi.mock('../../lib/domainMatrix.js', () => ({ assertDomainValue: vi.fn() }))
vi.mock('../../lib/ticketCIExclusions.js', () => ({ assertCIsLinkable: vi.fn() }))
vi.mock('../../lib/publishEvent.js', () => ({ publishEvent: vi.fn() }))
vi.mock('../../lib/stepEnteredPublisher.js', () => ({ publishStepEnteredForEntity: vi.fn() }))
vi.mock('../../jobs/embeddingWorker.js', () => ({ enqueueEmbedding: vi.fn(async () => undefined) }))
vi.mock('../../lib/ticketCustomFields.js', () => ({
  customFieldDefs: vi.fn(async () => [{ name: 'region' }]),
  resolveCustomFieldWrites: vi.fn(async () => ({ cf_region: 'emea' })),
}))
vi.mock('../../lib/customFieldSteps.js', () => ({ creationStepContext: vi.fn(async () => ({ current: 'new', visited: [] })) }))
vi.mock('../../lib/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

const svc = await import('../incidentService.js')
const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { workflowEngine } = await import('@opengraphity/workflow')
const { getInitialStepName, getWorkflowSteps } = await import('../../lib/workflowHelpers.js')
const { setTicketTeam, setTicketUser, assertUserInAssignedTeam } = await import('../ticketAssignment.js')
const { publishEvent } = await import('../../lib/publishEvent.js')
const { enqueueEmbedding } = await import('../../jobs/embeddingWorker.js')
const { resolveCustomFieldWrites } = await import('../../lib/ticketCustomFields.js')
const { logger } = await import('../../lib/logger.js')

const ctx = { tenantId: 't-1', userId: 'u-1' }
const PAYLOAD = { id: 'inc-1', title: 'Down', severity: 'high', status: 'new', ciName: null, assignedTo: null }

const eventTypes = () => vi.mocked(publishEvent).mock.calls.map((c) => c[0])
const writesMatching = (s: string) => h.runs.filter((r) => r.cypher.includes(s))
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  vi.clearAllMocks()
  h.runs.length = 0
  h.state.payload = { ...PAYLOAD }
  h.state.wi = null
  h.state.props = { id: 'inc-1', title: 'Down' }
  vi.mocked(runQuery).mockReset()
  vi.mocked(runQueryOne).mockReset()
  vi.mocked(enqueueEmbedding).mockResolvedValue(undefined)
  vi.mocked(getInitialStepName).mockResolvedValue('new')
  vi.mocked(getWorkflowSteps).mockResolvedValue([
    { name: 'new', isInitial: true, isTerminal: false, isOpen: true, category: null, stepOrder: 0 },
    { name: 'triage', isInitial: false, isTerminal: false, isOpen: true, category: null, stepOrder: 2 },
    { name: 'assigned', isInitial: false, isTerminal: false, isOpen: true, category: null, stepOrder: 1 },
    { name: 'working', isInitial: false, isTerminal: false, isOpen: true, category: null },
    { name: 'resolved', isInitial: false, isTerminal: true, isOpen: false, category: 'resolved', stepOrder: 9 },
  ] as never)
  vi.mocked(workflowEngine.transition).mockResolvedValue({ success: true } as never)
  vi.mocked(workflowEngine.createInstance).mockResolvedValue({ id: 'wi-1' } as never)
  vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([] as never)
})

describe('addIncidentComment', () => {
  it('writes an internal comment signed by the automatic actor, scoped to the tenant', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ id: 'inc-1' })
    await svc.addIncidentComment('inc-1', { ...ctx, actorLabel: 'Rule: night shift' }, 'Correlated alarm')
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ id: 'inc-1', tenantId: 't-1' })
    const [w] = writesMatching('CREATE (c:Comment')
    // The label is what the timeline shows instead of an anonymous "Automation:".
    expect(w!.params).toMatchObject({ incidentId: 'inc-1', tenantId: 't-1', text: 'Correlated alarm', authorLabel: 'Rule: night shift' })
  })

  it('without an actor label the comment carries a null label, not a made-up one', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ id: 'inc-1' })
    await svc.addIncidentComment('inc-1', ctx, 'x')
    expect(writesMatching('CREATE (c:Comment')[0]!.params['authorLabel']).toBeNull()
  })

  it('an incident outside the tenant is "not found" and nothing is written', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null)
    await expect(svc.addIncidentComment('other', ctx, 'x')).rejects.toThrow(/not found/i)
    expect(writesMatching('CREATE (c:Comment')).toHaveLength(0)
  })
})

describe('setIncidentTitle', () => {
  it('rejects an empty or blank title before touching the graph', async () => {
    await expect(svc.setIncidentTitle('inc-1', ctx, '   ')).rejects.toThrow(/must not be empty/)
    await expect(svc.setIncidentTitle('inc-1', ctx, undefined as unknown as string)).rejects.toThrow(/must not be empty/)
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('updates the title in the tenant and re-queues the similarity embedding', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ id: 'inc-1' })
    await svc.setIncidentTitle('inc-1', ctx, 'Service degraded')
    const params = vi.mocked(runQueryOne).mock.calls[0]![2] as Record<string, unknown>
    expect(params).toMatchObject({ id: 'inc-1', tenantId: 't-1', title: 'Service degraded' })
    // D15: the job is versioned by the updated_at just written, as the similarity panel asks for it.
    expect(enqueueEmbedding).toHaveBeenCalledWith({ entityType: 'incident', entityId: 'inc-1', tenantId: 't-1', updatedAt: params['now'] })
  })

  it('an unknown incident is an error and no embedding is queued', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null)
    await expect(svc.setIncidentTitle('nope', ctx, 'T')).rejects.toThrow(/not found/i)
    expect(enqueueEmbedding).not.toHaveBeenCalled()
  })

  it('a failed embedding enqueue is logged, not thrown: the title change stands', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ id: 'inc-1' })
    vi.mocked(enqueueEmbedding).mockRejectedValue(new Error('redis down'))
    await expect(svc.setIncidentTitle('inc-1', ctx, 'T')).resolves.toBeUndefined()
    await flush()
    expect(logger.error).toHaveBeenCalled()
  })
})

describe('createIncident — paths not covered elsewhere', () => {
  function primeCreate(opts: { created?: boolean; linked?: number } = {}) {
    vi.mocked(runQuery).mockImplementation(async (_s: unknown, cypher: string) => {
      if (cypher.includes('CREATE (i:Incident')) return (opts.created === false ? [] : [{ props: { id: 'inc-1', number: 'INC00000042' } }]) as never
      if (cypher.includes('MERGE (i)-[r:AFFECTED_BY]->(ci)')) return [{ linked: opts.linked ?? 1 }] as never
      return [] as never
    })
  }
  const createCypherParams = () => vi.mocked(runQuery).mock.calls.find((c) => String(c[1]).includes('CREATE (i:Incident'))![2] as Record<string, unknown>

  it('custom fields are resolved (as end user from the portal) and written on the node', async () => {
    primeCreate()
    await svc.createIncident({ title: 'T', category: 'network', customFields: [{ name: 'region', value: 'emea' }] as never }, ctx, 'portal')
    expect(vi.mocked(resolveCustomFieldWrites).mock.calls[0]![4]).toMatchObject({ current: null, endUser: true })
    expect(createCypherParams()['customProps']).toEqual({ cf_region: 'emea' })
  })

  it('custom fields from an agent channel are not treated as end-user input', async () => {
    primeCreate()
    await svc.createIncident({ title: 'T', affectedCIIds: ['ci-1'], customFields: [] }, ctx)
    expect(vi.mocked(resolveCustomFieldWrites).mock.calls[0]![4]).toMatchObject({ endUser: false, stepContext: { current: 'new', visited: [] } })
  })

  it('an impacted CI that cannot be linked in the tenant cancels the incident', async () => {
    primeCreate({ linked: 0 })
    await expect(svc.createIncident({ title: 'T', affectedCIIds: ['ci-9'] }, ctx)).rejects.toThrow(/1 of the 1 impacted CIs .*\(ci-9\)/)
    expect(vi.mocked(runQuery).mock.calls.some((c) => String(c[1]).includes('DETACH DELETE'))).toBe(true)
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
  })

  it('from the portal the category is mandatory', async () => {
    await expect(svc.createIncident({ title: 'T' }, ctx, 'portal')).rejects.toThrow(/category is required/)
  })

  it('a CREATE that returns nothing is an error and no event is published', async () => {
    primeCreate({ created: false })
    await expect(svc.createIncident({ title: 'T', affectedCIIds: ['ci-1'] }, ctx)).rejects.toThrow(/Failed to create incident/)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('a workflow instance that cannot start removes the incident and says why', async () => {
    primeCreate()
    vi.mocked(workflowEngine.createInstance).mockRejectedValue(new Error('two initial steps'))
    await expect(svc.createIncident({ title: 'T', affectedCIIds: ['ci-1'], category: 'hw' }, ctx))
      .rejects.toThrow(/workflow instance could not be started \(two initial steps\)/)
    const del = vi.mocked(runQuery).mock.calls.find((c) => String(c[1]).includes('DETACH DELETE'))
    // The rollback is scoped to the tenant AND the id just created.
    expect(del![2]).toMatchObject({ tenantId: 't-1' })
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('a non-Error rejection from the engine still produces a readable reason', async () => {
    primeCreate()
    vi.mocked(workflowEngine.createInstance).mockRejectedValue('boom')
    await expect(svc.createIncident({ title: 'T', affectedCIIds: ['ci-1'] }, ctx)).rejects.toThrow(/\(boom\)/)
  })

  it('the created event carries the real CI and assignee, falling back to a dash when absent', async () => {
    primeCreate()
    await svc.createIncident({ title: 'T', affectedCIIds: ['ci-1'], acknowledgeNoSla: true }, ctx)
    const created = vi.mocked(publishEvent).mock.calls.find((c) => c[0] === 'incident.created')!
    expect(created[1]).toBe('t-1')
    expect(created[3]).toMatchObject({ id: 'inc-1', ciName: '—', assignedTo: '—', affected_ci_ids: ['ci-1'] })
    // Acknowledging "no SLA" records who and when.
    expect(createCypherParams()).toMatchObject({ ackBy: 'u-1', number: 'INC00000042', severity: 'high', impact: 'high', urgency: 'medium' })
  })

  it('an incident that cannot be read back after creation is an error, not a fabricated event', async () => {
    primeCreate()
    h.state.payload = null
    await expect(svc.createIncident({ title: 'T', affectedCIIds: ['ci-1'] }, ctx)).rejects.toThrow(/not found while building event payload/)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('an embedding enqueue failure after creation is only logged', async () => {
    primeCreate()
    vi.mocked(enqueueEmbedding).mockRejectedValue(new Error('queue'))
    await expect(svc.createIncident({ title: 'T', affectedCIIds: ['ci-1'] }, ctx)).resolves.toMatchObject({ id: 'inc-1' })
    await flush()
    expect(logger.error).toHaveBeenCalled()
  })

  /*
   * THE OWNER'S RULE (23 Sep 2026): «when you create an incident you name a
   * CI, and it is assigned automatically to its support group»; the form
   * prefills the team with that group and the person may change it. And the
   * monitoring's incidents had no team at all (tour of 23 Sep 2026, D61).
   */
  describe('the new incident goes to the support group of its CI', () => {
    const answers = (over: { support?: Record<string, unknown> | null; team?: Record<string, unknown> | null; props?: Record<string, unknown> | null } = {}) =>
      vi.mocked(runQueryOne).mockImplementation((async (_s: unknown, cypher: string) => {
        if (cypher.includes('SUPPORTED_BY')) return over.support === undefined ? { teamId: 'team-sup', ciName: 'db-01' } : over.support
        if (cypher.includes('MATCH (t:Team {id: $teamId')) return over.team === undefined ? { id: 'team-x' } : over.team
        if (cypher.includes('RETURN properties(i) AS props')) return over.props === undefined ? { props: { id: 'inc-1', status: 'new' } } : over.props
        return null
      }) as never)
    const queryWith = (text: string) => vi.mocked(runQueryOne).mock.calls.find((c) => String(c[1]).includes(text))

    beforeEach(() => {
      primeCreate()
      h.state.wi = { instanceId: 'wi-1', currentStep: 'new' }
      vi.mocked(setTicketTeam).mockResolvedValue({ teamName: 'DBA', previousTeamName: null, unassignedUserName: null })
      vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'assigned' }] as never)
    })

    it('no team in the input → the support group of the first CI that has one, in the order given', async () => {
      answers()
      const out = await svc.createIncident({ title: 'T', affectedCIIds: ['ci-1', 'ci-2'] }, ctx)
      const q = queryWith('SUPPORTED_BY')!
      expect(q[1]).toContain('UNWIND range(0, size($ciIds) - 1) AS idx')
      expect(q[1]).toContain('ORDER BY idx, t.name')
      expect(q[2]).toEqual({ tenantId: 't-1', ciIds: ['ci-1', 'ci-2'] })
      expect(setTicketTeam).toHaveBeenCalledWith(h.session, 'Incident', 'inc-1', 'team-sup', 't-1')
      // it stays in the group's queue: leaving the first step is the SLA response, a person's (packages/sla)
      expect(workflowEngine.transition).not.toHaveBeenCalled()
      const row = writesMatching('STEP_HISTORY')[0]!.params
      expect(row).toMatchObject({ incidentId: 'inc-1', tenantId: 't-1', notes: 'incident.autoAssignedTeam|{"team":"DBA","ci":"db-01"}' })
      // one note on the ticket, which says why this team
      const comments = writesMatching('CREATE (c:Comment').map((r) => String(r.params['text']))
      expect(comments).toEqual(['incident.autoAssignedTeam|{"team":"DBA","ci":"db-01"}'])
      // the SLA starts on incident.created, then the assignment may change its policy
      expect(eventTypes()).toEqual(['incident.created', 'incident.assigned', 'ticket.team_assigned'])
      // the team is told, and the SLA does not take the routing for a response
      const assigned = vi.mocked(publishEvent).mock.calls.find((c) => c[0] === 'incident.assigned')!
      expect(assigned[3]).toMatchObject({ assignedTo: 'DBA', routed_at_creation: true })
      expect(out).toMatchObject({ id: 'inc-1', title: 'Down' })
    })

    it('a team chosen in the form wins, and is checked before anything is written', async () => {
      answers()
      await svc.createIncident({ title: 'T', affectedCIIds: ['ci-1'], teamId: 'team-x' }, ctx)
      expect(setTicketTeam).toHaveBeenCalledWith(h.session, 'Incident', 'inc-1', 'team-x', 't-1')
      expect(queryWith('SUPPORTED_BY')).toBeUndefined()
      expect(workflowEngine.transition).not.toHaveBeenCalled()
      expect(writesMatching('STEP_HISTORY')[0]!.params['notes']).toBe('incident.assignedTeam|{"team":"DBA"}')

      vi.clearAllMocks()
      primeCreate()
      answers({ team: null })
      await expect(svc.createIncident({ title: 'T', affectedCIIds: ['ci-1'], teamId: 'team-zz' }, ctx))
        .rejects.toThrow('Team team-zz does not exist in this organization')
      expect(vi.mocked(runQuery).mock.calls.some((c) => String(c[1]).includes('CREATE (i:Incident'))).toBe(false)
    })

    it('no CI with a support group → no team, as before', async () => {
      answers({ support: null })
      const out = await svc.createIncident({ title: 'T', affectedCIIds: ['ci-1'] }, ctx)
      expect(setTicketTeam).not.toHaveBeenCalled()
      expect(out).toMatchObject({ id: 'inc-1', number: 'INC00000042' })
      expect(eventTypes()).toEqual(['incident.created'])
    })

    it('the incident is returned as it is now: assigned to the group, still in its first step', async () => {
      answers()
      h.state.props = { id: 'inc-1', status: 'new', team: 'team-sup' }
      await expect(svc.createIncident({ title: 'T', affectedCIIds: ['ci-1'] }, ctx)).resolves.toMatchObject({ id: 'inc-1', status: 'new', team: 'team-sup' })
      expect(workflowEngine.getAvailableTransitions).not.toHaveBeenCalled()
    })

    it('any other failure says that the incident exists and what did not happen', async () => {
      answers()
      vi.mocked(setTicketTeam).mockRejectedValue(new Error('neo4j down'))
      const err = await svc.createIncident({ title: 'T', affectedCIIds: ['ci-1'] }, ctx).catch((e: unknown) => e as GraphQLError)
      expect(err).toBeInstanceOf(GraphQLError)
      expect(err.message).toBe('Incident INC00000042 was created, but assigning it to its team failed: neo4j down')
      expect(err.extensions['i18n']).toEqual({ key: 'errors.incident.createdButNotAssigned', params: { number: 'INC00000042', reason: 'neo4j down' } })
    })
  })
})

describe('resolveIncident', () => {
  function primeResolve(rows: Row[] = [{ props: { id: 'inc-1', status: 'resolved' } }]) {
    vi.mocked(runQueryOne).mockResolvedValue({ instanceId: 'wi-1' })
    vi.mocked(runQuery).mockResolvedValue(rows as never)
  }

  it('without a workflow instance in the tenant the incident is "not found"', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null)
    await expect(svc.resolveIncident('inc-x', ctx)).rejects.toThrow(/not found/i)
    expect(workflowEngine.transition).not.toHaveBeenCalled()
  })

  it('moves to the step of category "resolved" and stores the notes as root cause', async () => {
    primeResolve()
    await svc.resolveIncident('inc-1', ctx, 'bad cable')
    expect(vi.mocked(workflowEngine.transition).mock.calls[0]![1]).toMatchObject({ instanceId: 'wi-1', toStepName: 'resolved', notes: 'bad cable', tenantId: 't-1' })
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ rootCause: 'bad cable', tenantId: 't-1' })
    // incident.resolved comes from the step hook, not from here (review of 23 Sep 2026).
    expect(vi.mocked(publishEvent).mock.calls.map((c) => c[0])).not.toContain('incident.resolved')
  })

  it('without a "resolved" category it falls back to the first terminal step; no notes keep the old root cause', async () => {
    primeResolve()
    vi.mocked(getWorkflowSteps).mockResolvedValue([
      { name: 'new', isTerminal: false, category: null },
      { name: 'done', isTerminal: true, category: 'closed' },
    ] as never)
    await svc.resolveIncident('inc-1', ctx)
    expect(vi.mocked(workflowEngine.transition).mock.calls[0]![1]).toMatchObject({ toStepName: 'done', notes: undefined })
    // null → coalesce keeps whatever root cause was there.
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toMatchObject({ rootCause: null })
  })

  it('a workflow with no resolved nor terminal step is a validation error', async () => {
    primeResolve()
    vi.mocked(getWorkflowSteps).mockResolvedValue([{ name: 'new', isTerminal: false, category: null }] as never)
    await expect(svc.resolveIncident('inc-1', ctx)).rejects.toThrow(/No resolved\/terminal step/)
  })

  it('a transition refused by the engine stops everything: no resolved_at, no event', async () => {
    primeResolve()
    vi.mocked(workflowEngine.transition).mockResolvedValue({ success: false, error: 'condition not met' } as never)
    const err = await svc.resolveIncident('inc-1', ctx).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).message).toBe('condition not met')
    expect(runQuery).not.toHaveBeenCalled()
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('an incident that disappears between transition and update is "not found"', async () => {
    primeResolve([])
    await expect(svc.resolveIncident('inc-1', ctx)).rejects.toThrow(/not found/i)
  })
})

describe('assignIncidentToTeam', () => {
  beforeEach(() => {
    vi.mocked(setTicketTeam).mockResolvedValue({ teamName: 'Network', previousTeamName: 'Desk', unassignedUserName: null })
  })

  it('a missing team id is refused before any write', async () => {
    await expect(svc.assignIncidentToTeam('inc-1', '  ', ctx)).rejects.toThrow(/teamId is required/)
    expect(setTicketTeam).not.toHaveBeenCalled()
  })

  it('from the initial step it advances to the open step with the lowest order, whatever the edge order', async () => {
    h.state.wi = { instanceId: 'wi-1', currentStep: 'new' }
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([
      { toStep: 'resolved' }, { toStep: 'working' }, { toStep: 'triage' }, { toStep: 'assigned' }, { toStep: 'ghost' },
    ] as never)
    const out = await svc.assignIncidentToTeam('inc-1', 'team-1', ctx)
    // resolved is terminal, ghost does not exist, working has no order (last).
    expect(vi.mocked(workflowEngine.transition).mock.calls[0]![1]).toMatchObject({ toStepName: 'assigned', triggerType: 'automatic', tenantId: 't-1' })
    expect(out).toMatchObject({ teamName: 'Network', previousTeamName: 'Desk', unassignedUserName: null, incident: { id: 'inc-1' } })
    expect(eventTypes()).toEqual(['incident.assigned', 'ticket.team_assigned'])
    expect(vi.mocked(publishEvent).mock.calls[0]![3]).toMatchObject({ assignedTo: 'Network' })
    expect(vi.mocked(publishEvent).mock.calls[1]![3]).toEqual({ entity_type: 'incident', entity_id: 'inc-1', team_id: 'team-1' })
    // D12: the transition carries the note, and the step-entered trace writes it on
    // the ticket («Workflow: <step> — <note>»): the service must not write it again.
    expect(String(vi.mocked(workflowEngine.transition).mock.calls[0]![1].notes)).toContain('incident.reassignedTeam')
    expect(writesMatching('CREATE (c:Comment')).toHaveLength(0)
  })

  it('D11: the first team of an incident is «assigned», not «reassigned»', async () => {
    h.state.wi = { instanceId: 'wi-1', currentStep: 'new' }
    vi.mocked(setTicketTeam).mockResolvedValue({ teamName: 'Network', previousTeamName: null, unassignedUserName: null })
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'assigned' }] as never)
    await svc.assignIncidentToTeam('inc-1', 'team-1', ctx)
    const notes = String(vi.mocked(workflowEngine.transition).mock.calls[0]![1].notes)
    expect(notes).toContain('incident.assignedTeam')
    expect(notes).not.toContain('reassigned')
    // a person's assignment is a response for the SLA: no routing marker
    const assigned = vi.mocked(publishEvent).mock.calls.find((c) => c[0] === 'incident.assigned')!
    expect(assigned[3]).not.toHaveProperty('routed_at_creation')
  })

  it('same order ties are broken by step name', async () => {
    h.state.wi = { instanceId: 'wi-1', currentStep: 'new' }
    vi.mocked(getWorkflowSteps).mockResolvedValue([
      { name: 'zeta', isTerminal: false, isOpen: true, stepOrder: 1 },
      { name: 'alpha', isTerminal: false, isOpen: true, stepOrder: 1 },
    ] as never)
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'zeta' }, { toStep: 'alpha' }] as never)
    await svc.assignIncidentToTeam('inc-1', 'team-1', ctx)
    expect(vi.mocked(workflowEngine.transition).mock.calls[0]![1]).toMatchObject({ toStepName: 'alpha' })
  })

  it('from the initial step with no transition available nothing moves, the note is still written', async () => {
    h.state.wi = { instanceId: 'wi-1', currentStep: 'new' }
    await svc.assignIncidentToTeam('inc-1', 'team-1', ctx)
    expect(workflowEngine.transition).not.toHaveBeenCalled()
    expect(writesMatching('CREATE (c:Comment')).toHaveLength(1)
  })

  it('from the initial step with only terminal/closed targets nothing moves', async () => {
    h.state.wi = { instanceId: 'wi-1', currentStep: 'new' }
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'resolved' }] as never)
    await svc.assignIncidentToTeam('inc-1', 'team-1', ctx)
    expect(workflowEngine.transition).not.toHaveBeenCalled()
  })

  it('a refused auto-advance: the assignment and its events stand, then the error names the step', async () => {
    h.state.wi = { instanceId: 'wi-1', currentStep: 'new' }
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'assigned' }] as never)
    vi.mocked(workflowEngine.transition).mockResolvedValue({ success: false, error: 'missing field' } as never)
    await expect(svc.assignIncidentToTeam('inc-1', 'team-1', ctx))
      .rejects.toThrow(/assignment was saved, but the incident did not move to "assigned": missing field/)
    expect(eventTypes()).toEqual(['incident.assigned', 'ticket.team_assigned'])
    // No transition, so no step note: the service writes the assignment note itself.
    expect(writesMatching('CREATE (c:Comment')).toHaveLength(1)
  })

  it('past the initial step: a history entry and a comment, no transition; a detached assignee is explained', async () => {
    h.state.wi = { instanceId: 'wi-1', currentStep: 'working' }
    vi.mocked(setTicketTeam).mockResolvedValue({ teamName: 'Network', previousTeamName: null, unassignedUserName: 'Mario' })
    await svc.assignIncidentToTeam('inc-1', 'team-1', { ...ctx, actorLabel: 'Rule X' })
    expect(workflowEngine.transition).not.toHaveBeenCalled()
    expect(writesMatching('STEP_HISTORY')[0]!.params).toMatchObject({ incidentId: 'inc-1', tenantId: 't-1' })
    const comments = writesMatching('CREATE (c:Comment').map((r) => r.params)
    expect(comments).toHaveLength(2)
    expect(String(comments[0]!['text'])).toContain('incident.unassignedOnTeamChange')
    expect(String(comments[0]!['text'])).toContain('Mario')
    expect(comments.every((c) => c['authorLabel'] === 'Rule X')).toBe(true)
  })

  it('without a workflow instance only the assignment and the events happen', async () => {
    await svc.assignIncidentToTeam('inc-1', 'team-1', ctx)
    expect(writesMatching('CREATE (c:Comment')).toHaveLength(0)
    expect(eventTypes()).toContain('incident.assigned')
  })

  it('an incident that cannot be read back is "not found" and no event leaves', async () => {
    h.state.props = null
    await expect(svc.assignIncidentToTeam('inc-1', 'team-1', ctx)).rejects.toThrow(/not found/i)
    expect(publishEvent).not.toHaveBeenCalled()
  })
})

describe('assignIncidentToUser', () => {
  beforeEach(() => {
    vi.mocked(setTicketUser).mockResolvedValue({ userName: 'Anna', previousUserName: 'Bruno' })
  })

  it('a null user unassigns without checking the team and without events', async () => {
    const out = await svc.assignIncidentToUser('inc-1', null, ctx)
    expect(vi.mocked(setTicketUser).mock.calls[0]!.slice(1)).toEqual(['Incident', 'inc-1', null, 't-1'])
    expect(assertUserInAssignedTeam).not.toHaveBeenCalled()
    expect(out).toEqual({ incident: { id: 'inc-1', title: 'Down' }, userName: null, previousUserName: 'Bruno' })
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('unassigning an incident that cannot be read back is "not found"', async () => {
    h.state.props = null
    await expect(svc.assignIncidentToUser('inc-1', null, ctx)).rejects.toThrow(/not found/i)
  })

  it('the person must belong to the assigned team: a refusal stops before any write', async () => {
    vi.mocked(assertUserInAssignedTeam).mockRejectedValueOnce(new Error('not in team'))
    await expect(svc.assignIncidentToUser('inc-1', 'u-2', ctx)).rejects.toThrow('not in team')
    expect(setTicketUser).not.toHaveBeenCalled()
  })

  it('from the initial step it auto-advances; the note says «reassigned» because Bruno had it (D11)', async () => {
    h.state.wi = { instanceId: 'wi-1', currentStep: 'new' }
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'triage' }] as never)
    const out = await svc.assignIncidentToUser('inc-1', 'u-2', ctx)
    const t = vi.mocked(workflowEngine.transition).mock.calls[0]![1]
    expect(t).toMatchObject({ toStepName: 'triage', triggerType: 'automatic' })
    expect(String(t.notes)).toContain('incident.reassignedUser')
    expect(out).toMatchObject({ userName: 'Anna', previousUserName: 'Bruno' })
    expect(eventTypes()).toEqual(['incident.assigned'])
    // D12: the transition wrote «Workflow: <step> — <note>»; no second copy of the note.
    expect(writesMatching('CREATE (c:Comment')).toHaveLength(0)
  })

  it('D11: the first person on the incident is an assignment, in the history and in the note alike', async () => {
    h.state.wi = { instanceId: 'wi-1', currentStep: 'working' }
    vi.mocked(setTicketUser).mockResolvedValue({ userName: 'Anna', previousUserName: null })
    await svc.assignIncidentToUser('inc-1', 'u-2', ctx)
    expect(String(writesMatching('STEP_HISTORY')[0]!.params['notes'])).toContain('incident.assignedUser')
    const comments = writesMatching('CREATE (c:Comment').map((r) => String(r.params['text']))
    expect(comments).toHaveLength(1)
    expect(comments[0]).toContain('incident.assignedUser')
  })

  it('past the initial step it only records history — never an arbitrary transition', async () => {
    h.state.wi = { instanceId: 'wi-1', currentStep: 'working' }
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'resolved' }] as never)
    await svc.assignIncidentToUser('inc-1', 'u-2', ctx)
    expect(workflowEngine.getAvailableTransitions).not.toHaveBeenCalled()
    expect(workflowEngine.transition).not.toHaveBeenCalled()
    expect(String(writesMatching('STEP_HISTORY')[0]!.params['notes'])).toContain('incident.reassignedUser')
  })

  it('from the initial step with no target it records history; a user without a name is shown by id', async () => {
    h.state.wi = { instanceId: 'wi-1', currentStep: 'new' }
    vi.mocked(setTicketUser).mockResolvedValue({ userName: null, previousUserName: null })
    const out = await svc.assignIncidentToUser('inc-1', 'u-2', ctx)
    expect(String(writesMatching('STEP_HISTORY')[0]!.params['notes'])).toContain('u-2')
    expect(out.userName).toBeNull()
  })

  it('a refused auto-advance surfaces after the assignment event', async () => {
    h.state.wi = { instanceId: 'wi-1', currentStep: 'new' }
    vi.mocked(workflowEngine.getAvailableTransitions).mockResolvedValue([{ toStep: 'triage' }] as never)
    vi.mocked(workflowEngine.transition).mockResolvedValue({ success: false } as never)
    await expect(svc.assignIncidentToUser('inc-1', 'u-2', ctx)).rejects.toThrow(/did not move to "triage": the workflow refused the transition/)
    expect(eventTypes()).toEqual(['incident.assigned'])
  })

  it('without a workflow instance: no comment; unreadable incident → not found', async () => {
    await svc.assignIncidentToUser('inc-1', 'u-2', ctx)
    expect(writesMatching('CREATE (c:Comment')).toHaveLength(0)
    h.state.props = null
    await expect(svc.assignIncidentToUser('inc-1', 'u-2', ctx)).rejects.toThrow(/not found/i)
  })
})

describe('in progress / close / escalate', () => {
  it('inProgress and close publish the event with the payload read from the tenant', async () => {
    await svc.inProgressIncident('inc-1', ctx)
    await svc.closeIncident('inc-1', ctx)
    expect(eventTypes()).toEqual(['incident.in_progress', 'incident.closed'])
    expect(writesMatching('collect(ci.name)').every((r) => r.params['tenantId'] === 't-1')).toBe(true)
  })

  it('inProgress and close on an incident that cannot be read fail instead of inventing a payload', async () => {
    h.state.payload = null
    await expect(svc.inProgressIncident('x', ctx)).rejects.toThrow(/not found while building event payload/)
    await expect(svc.closeIncident('x', ctx)).rejects.toThrow(/not found while building event payload/)
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('escalating without a workflow instance is an error', async () => {
    vi.mocked(runQueryOne).mockResolvedValue(null)
    await expect(svc.escalateIncident('inc-1', ctx)).rejects.toThrow(/no workflow instance to escalate/)
  })

  it('a successful escalation goes to the target step and publishes incident.escalated', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ instanceId: 'wi-1' })
    await svc.escalateIncident('inc-1', ctx)
    expect(vi.mocked(workflowEngine.transition).mock.calls[0]![1]).toMatchObject({ instanceId: 'wi-1', toStepName: 'escalated', tenantId: 't-1' })
    expect(eventTypes()).toEqual(['incident.escalated'])
  })

  it('an escalation refused by the engine publishes nothing', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ instanceId: 'wi-1' })
    vi.mocked(workflowEngine.transition).mockResolvedValue({ success: false } as never)
    await expect(svc.escalateIncident('inc-1', ctx)).rejects.toThrow(/refused the escalation to "escalated"/)
    expect(publishEvent).not.toHaveBeenCalled()
  })
})
