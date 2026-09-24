/**
 * THE PIPELINE OF THE TRANSITIONS (review of 23 Sep 2026, wave 7 · B1).
 *
 * Every path that moves a ticket goes through `transitionTicket`, and what is
 * pinned here is what the paths used to choose for themselves:
 *  - the guards hold for EVERY path (owner's decision of 24 Sep 2026), in one
 *    order, and the first that holds the ticket is the answer;
 *  - who asks decides only what must differ: a person's write permission and
 *    `approval.override`, the approval decision being the decision the gates
 *    wait for, the rejection of a change being the way back to the assessment;
 *  - the step actions get the ticket as it is stored, whatever the path;
 *  - an automatic refusal leaves ONE internal note per reason, naming who
 *    asked, and no retry; an engine error that may be transient stays an
 *    error, for the queue to retry;
 *  - the fields the step writes on entry are written on every path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const h = vi.hoisted(() => ({
  ticket: null as Record<string, unknown> | null,
  queries: [] as Array<{ cypher: string; params: Record<string, unknown> }>,
  txRuns: [] as Array<{ cypher: string; params: Record<string, unknown> }>,
  comments: [] as Array<Record<string, unknown>>,
  gateOutcome: { allowed: true, reason: 'open' } as { allowed: boolean; reason: string },
}))

vi.mock('@opengraphity/neo4j', () => ({
  runQueryOne: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => { h.queries.push({ cypher, params }); return h.ticket }),
  runQuery: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => { h.queries.push({ cypher, params }); return [] }),
}))
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { transition: vi.fn() } }))
vi.mock('../../lib/stepMetadataPreflight.js', () => ({ preflightStepMetadata: vi.fn(async () => undefined) }))
vi.mock('../../lib/validateRequiredFields.js', () => ({ validateStepRequirements: vi.fn(async () => undefined) }))
vi.mock('../../lib/requestApproval.js', () => ({ requestApprovalWouldBeSkipped: vi.fn(async () => false) }))
vi.mock('../../lib/ticketApprovalGate.js', () => ({
  APPROVAL_GATED_TICKETS: ['incident', 'problem', 'service_request'],
  ticketApprovalRefusal: vi.fn(async () => null),
}))
vi.mock('../../lib/onEnterFields.js', () => ({ applyOnEnterFields: vi.fn(async () => undefined) }))
vi.mock('../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en') }))
vi.mock('../../lib/ticketComments.js', () => ({
  writeTicketComment: vi.fn(async (_tx: unknown, c: Record<string, unknown>) => { h.comments.push(c); return null }),
}))
vi.mock('../change/windowGate.js', () => ({
  assertChangeWindowGate: vi.fn(async () => undefined),
  automaticTransitionOutcome: vi.fn(async () => h.gateOutcome),
  automaticTransitionAllowed: vi.fn(async () => false),
}))
const warn = vi.fn()
const error = vi.fn()
vi.mock('../../lib/logger.js', () => ({ logger: { child: () => ({ warn, error, info: vi.fn(), debug: vi.fn() }) } }))

const { transitionTicket, checkTicketTransition, refusalError, personActor, refusalNote } = await import('../ticketTransition.js')
const { workflowEngine } = await import('@opengraphity/workflow')
const { preflightStepMetadata } = await import('../../lib/stepMetadataPreflight.js')
const { validateStepRequirements } = await import('../../lib/validateRequiredFields.js')
const { requestApprovalWouldBeSkipped } = await import('../../lib/requestApproval.js')
const { ticketApprovalRefusal } = await import('../../lib/ticketApprovalGate.js')
const { applyOnEnterFields } = await import('../../lib/onEnterFields.js')
const gate = await import('../change/windowGate.js')

const engine = vi.mocked(workflowEngine.transition)
const session = {
  executeWrite: vi.fn(async (work: (tx: unknown) => unknown) => work({ run: async (cypher: string, params: Record<string, unknown>) => { h.txRuns.push({ cypher, params }) } })),
} as never

const ticket = (over: Record<string, unknown> = {}) => ({
  entityType: 'incident', entityId: 'inc-1', currentStep: 'in_progress',
  props: { id: 'inc-1', title: 'DB down', category: 'database' }, assignedTo: 'u-7', assignedTeam: 'team-db', refusalNoted: null, ...over,
})
const moved = { success: true, instance: { id: 'wi-1' }, execution: {}, actionsRun: [] }
const refusedByCondition = { success: false, error: 'All tasks of the step must be complete', errorI18n: { key: 'errors.workflow.condition.all_tasks_complete' }, refusedByCondition: 'all_tasks_complete' }
const perms = (...p: string[]) => new Set(p) as never
const staff = (...p: string[]) => ({ kind: 'person' as const, userId: 'u-1', permissions: perms(...p) })
const rule = { kind: 'system' as const, path: 'rule' as const, userId: 'automation', label: 'Escalate DB incidents' }
const base = { tenantId: 't1', instanceId: 'wi-1', toStep: 'resolved', triggerType: 'manual' as const }

beforeEach(() => {
  vi.clearAllMocks()
  h.ticket = ticket()
  h.queries = []; h.txRuns = []; h.comments = []
  h.gateOutcome = { allowed: true, reason: 'open' }
  engine.mockResolvedValue(moved as never)
  // Every guard open again: an answer set by a test must not leak into the next.
  vi.mocked(ticketApprovalRefusal).mockResolvedValue(null)
  vi.mocked(requestApprovalWouldBeSkipped).mockResolvedValue(false)
  vi.mocked(validateStepRequirements).mockResolvedValue(undefined)
  vi.mocked(preflightStepMetadata).mockResolvedValue(undefined)
  vi.mocked(gate.assertChangeWindowGate).mockResolvedValue(undefined)
  vi.mocked(applyOnEnterFields).mockResolvedValue(undefined)
})

describe('transitionTicket — the ticket and the engine', () => {
  it('an instance that is not the tenant\'s is not found (and nothing runs)', async () => {
    h.ticket = null
    await expect(transitionTicket(session, { ...base, actor: staff('incident.write') })).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(h.queries[0]!.params).toEqual({ instanceId: 'wi-1', tenantId: 't1' })
    expect(engine).not.toHaveBeenCalled()
  })

  it('moves: the engine gets the ticket as stored, whatever the path — the paths no longer bring it', async () => {
    const out = await transitionTicket(session, { ...base, notes: 'Fixed the index', actor: rule, triggerType: 'automatic', extraEntityData: { outcome: 'ok' } })
    expect(out).toMatchObject({ moved: true, entityType: 'incident', entityId: 'inc-1', fromStep: 'in_progress', actionErrors: [] })
    expect(engine).toHaveBeenCalledWith(session, {
      instanceId: 'wi-1', toStepName: 'resolved', triggeredBy: 'automation', triggerType: 'automatic',
      notes: 'Fixed the index', actorLabel: 'Escalate DB incidents', tenantId: 't1',
    }, {
      userId: 'automation', notes: 'Fixed the index',
      entityData: { id: 'inc-1', title: 'DB down', category: 'database', outcome: 'ok', assigned_to: 'u-7', assigned_team: 'team-db' },
    })
  })

  it('the fields the step writes on entry are written on every path; their failure is an action error, the move stays', async () => {
    vi.mocked(applyOnEnterFields).mockRejectedValueOnce(new Error('Corrupt on_enter_fields JSON'))
    const out = await transitionTicket(session, { ...base, actor: { kind: 'requester', userId: 'u-9' } })
    expect(applyOnEnterFields).toHaveBeenCalledWith(session, 'wi-1', 'resolved', 'u-9', undefined, 't1')
    expect(out).toMatchObject({ moved: true, actionErrors: ['on_enter_fields: Corrupt on_enter_fields JSON'] })
  })

  it('the engine\'s own action errors come back with the move', async () => {
    engine.mockResolvedValueOnce({ ...moved, actionErrors: ['assign_to: team not found'] } as never)
    const out = await transitionTicket(session, { ...base, actor: staff('incident.write') })
    expect(out).toMatchObject({ moved: true, actionErrors: ['assign_to: team not found'] })
  })

  it('after a move, the mark of the last refusal is cleared: the same refusal later is news again', async () => {
    h.ticket = ticket({ refusalNoted: 'resolved|named_approval|errors.approval.pendingOnStep' })
    await transitionTicket(session, { ...base, actor: staff('incident.write') })
    expect(h.queries.some((q) => q.cypher.includes('REMOVE wi.refusal_noted'))).toBe(true)
    h.queries = []
    h.ticket = ticket()
    await transitionTicket(session, { ...base, actor: staff('incident.write') })
    expect(h.queries.some((q) => q.cypher.includes('REMOVE'))).toBe(false)
  })
})

describe('transitionTicket — the guards, in their order', () => {
  it('a person without the write permission of THIS type is refused before anything else', async () => {
    const out = await transitionTicket(session, { ...base, actor: staff('kb.write') })
    expect(out).toMatchObject({ moved: false, refusal: { guard: 'type_permission', code: 'FORBIDDEN', i18n: { key: 'errors.authz.permissionRequired', params: { required: 'incident.write' } } } })
    expect(ticketApprovalRefusal).not.toHaveBeenCalled()
    expect(engine).not.toHaveBeenCalled()
  })

  it('a person whose entry point checked the permission (no permissions given) is not checked again', async () => {
    const out = await transitionTicket(session, { ...base, actor: { kind: 'person', userId: 'u-1' } })
    expect(out.moved).toBe(true)
  })

  it('the named approval holds a rule, the escalation and a requester; a person with approval.override passes', async () => {
    vi.mocked(ticketApprovalRefusal).mockResolvedValue({ status: 'pending', approvalId: 'apr-1', stepName: 'waiting_approval' })
    for (const actor of [rule, { kind: 'system' as const, path: 'escalation' as const }, { kind: 'requester' as const, userId: 'u-9' }, staff('incident.write')]) {
      const out = await transitionTicket(session, { ...base, actor })
      expect(out, actor.kind).toMatchObject({ moved: false, refusal: { guard: 'named_approval', extensions: { approvalId: 'apr-1' }, i18n: { key: 'errors.approval.pendingOnStep', params: { step: 'waiting_approval' } } } })
    }
    expect(engine).not.toHaveBeenCalled()
    const out = await transitionTicket(session, { ...base, actor: staff('incident.write', 'approval.override') })
    expect(out.moved).toBe(true)
  })

  it('a rejected approval says it was rejected', async () => {
    vi.mocked(ticketApprovalRefusal).mockResolvedValue({ status: 'rejected', approvalId: 'apr-2', stepName: 'waiting_approval' })
    const out = await transitionTicket(session, { ...base, actor: staff('incident.write') })
    expect(out).toMatchObject({ moved: false, refusal: { message: expect.stringContaining('was rejected'), i18n: { key: 'errors.approval.rejectedOnStep' } } })
  })

  it('a request that needs an approval: a person or the approval decision may take it out of the approval step, a rule may not', async () => {
    h.ticket = ticket({ entityType: 'service_request', entityId: 'sr-1' })
    for (const [actor, byPerson] of [
      [staff('request.write'), true], [{ kind: 'requester' as const, userId: 'u-9' }, true],
      [{ kind: 'system' as const, path: 'approval' as const, userId: 'u-3' }, true], [rule, false],
    ] as const) {
      vi.mocked(requestApprovalWouldBeSkipped).mockClear()
      await transitionTicket(session, { ...base, actor })
      expect(requestApprovalWouldBeSkipped).toHaveBeenCalledWith(session, 't1', 'wi-1', 'resolved', { byPerson })
    }
    vi.mocked(requestApprovalWouldBeSkipped).mockResolvedValueOnce(true)
    const out = await transitionTicket(session, { ...base, actor: rule })
    expect(out).toMatchObject({ moved: false, refusal: { guard: 'request_approval', i18n: { key: 'errors.request.approvalRequired' } } })
  })

  it('the required fields of the step hold every path, and see the notes and what the caller just wrote', async () => {
    vi.mocked(validateStepRequirements).mockRejectedValueOnce(new GraphQLError('Field "root_cause" is required for step "resolved"', {
      extensions: { code: 'VALIDATION_ERROR', fields: ['root_cause'], i18n: { key: 'errors.fields.requiredForStep', params: { fields: 'root_cause', step: 'resolved' } } },
    }))
    const out = await transitionTicket(session, { ...base, notes: 'n', actor: rule, extraEntityData: { outcome: 'ok' } })
    expect(validateStepRequirements).toHaveBeenCalledWith(session, {
      entityType: 'incident', entityProps: { id: 'inc-1', title: 'DB down', category: 'database', outcome: 'ok' }, notes: 'n', tenantId: 't1', toStep: 'resolved',
    })
    expect(out).toMatchObject({ moved: false, refusal: { guard: 'required_fields', code: 'VALIDATION_ERROR', extensions: { fields: ['root_cause'] }, final: true } })
  })

  it('the metadata of the step last; a failure of the database is not a refusal: it is thrown', async () => {
    vi.mocked(preflightStepMetadata).mockRejectedValueOnce(new GraphQLError('Misconfigured workflow', { extensions: { code: 'CONFLICT', i18n: { key: 'errors.workflow.stepActionsNotJson' } } }))
    expect(await transitionTicket(session, { ...base, actor: rule })).toMatchObject({ moved: false, refusal: { guard: 'step_metadata' } })
    vi.mocked(preflightStepMetadata).mockRejectedValueOnce(new Error('Neo4j unavailable'))
    await expect(transitionTicket(session, { ...base, actor: rule })).rejects.toThrow('Neo4j unavailable')
  })
})

describe('transitionTicket — the release window of a change', () => {
  beforeEach(() => { h.ticket = ticket({ entityType: 'change', entityId: 'chg-1', currentStep: 'approval', props: { change_type: 'normal' } }) })
  const input = { tenantId: 't1', changeId: 'chg-1', changeType: 'normal', currentStep: 'approval', toStep: 'resolved' }

  it('a person: the manual gate, whose error becomes the refusal (its sentence names the ways out)', async () => {
    vi.mocked(gate.assertChangeWindowGate).mockRejectedValueOnce(new GraphQLError('To reject, use "Reject"', { extensions: { code: 'CONFLICT', i18n: { key: 'errors.change.rejectViaApproval' } } }))
    const out = await transitionTicket(session, { ...base, actor: staff('change.write') })
    expect(gate.assertChangeWindowGate).toHaveBeenCalledWith(session, expect.objectContaining({ permissions: expect.any(Set) }), input)
    expect(out).toMatchObject({ moved: false, refusal: { guard: 'change_window', i18n: { key: 'errors.change.rejectViaApproval' } } })
  })

  it('an automatic path: refused, counted by the gate under its own path', async () => {
    h.gateOutcome = { allowed: false, reason: 'needs_approvals' }
    for (const [actor, path] of [[rule, 'rule_action'], [{ kind: 'system' as const, path: 'escalation' as const }, 'sla_breach'],
      [{ kind: 'system' as const, path: 'step_deadline' as const }, 'step_deadline'], [{ kind: 'system' as const, path: 'timer' as const }, 'timer_job'],
      [{ kind: 'system' as const, path: 'change_auto' as const }, 'auto_transition']] as const) {
      const out = await transitionTicket(session, { ...base, actor })
      expect(out).toMatchObject({ moved: false, refusal: { guard: 'change_window', i18n: { key: 'errors.change.windowNeedsApprovals' } } })
      expect(gate.automaticTransitionAllowed).toHaveBeenLastCalledWith(session, input, path)
    }
    h.gateOutcome = { allowed: false, reason: 'needs_assessments' }
    expect(await transitionTicket(session, { ...base, actor: rule })).toMatchObject({ refusal: { i18n: { key: 'errors.change.assessmentsIncomplete' } } })
    expect(engine).not.toHaveBeenCalled()
  })

  it('the rejection of a change\'s approval IS the way back to the assessment: open for that path only', async () => {
    h.gateOutcome = { allowed: false, reason: 'use_reject_mutation' }
    expect((await transitionTicket(session, { ...base, actor: { kind: 'system', path: 'approval', userId: 'u-3' } })).moved).toBe(true)
    expect((await transitionTicket(session, { ...base, actor: rule })).moved).toBe(false)
  })

  it('a change never goes through the named approvals of incidents and requests', async () => {
    await transitionTicket(session, { ...base, actor: staff('change.write') })
    expect(ticketApprovalRefusal).not.toHaveBeenCalled()
  })
})

describe('the engine\'s no', () => {
  it('a condition, an arc that is not there: final refusals', async () => {
    engine.mockResolvedValueOnce(refusedByCondition as never)
    expect(await transitionTicket(session, { ...base, actor: staff('incident.write') })).toMatchObject({
      moved: false, refusal: { guard: 'workflow', final: true, i18n: { key: 'errors.workflow.condition.all_tasks_complete' }, engine: refusedByCondition },
    })
    engine.mockResolvedValueOnce({ success: false, error: 'not valid', errorI18n: { key: 'errors.workflow.transitionNotValid', params: { step: 'x' } } } as never)
    expect(await transitionTicket(session, { ...base, actor: staff('incident.write') })).toMatchObject({ refusal: { final: true, i18n: { params: { step: 'x' } } } })
  })

  it('a concurrent move and an answer without a key (the database) may be transient: not final, no note', async () => {
    engine.mockResolvedValueOnce({ success: false, error: 'Concurrent transition', errorI18n: { key: 'errors.workflow.concurrentTransition' } } as never)
    expect(await transitionTicket(session, { ...base, actor: rule })).toMatchObject({ refusal: { final: false } })
    engine.mockResolvedValueOnce({ success: false, error: 'Connection reset' } as never)
    expect(await transitionTicket(session, { ...base, actor: rule })).toMatchObject({ refusal: { final: false, message: 'Connection reset' } })
    expect(h.comments).toEqual([])
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ path: 'rule' }), 'An automatic move failed: not a refusal, it may be retried')
  })
})

describe('an automatic refusal: one note per reason, naming who asked', () => {
  beforeEach(() => { vi.mocked(ticketApprovalRefusal).mockResolvedValue({ status: 'pending', approvalId: 'apr-1', stepName: 'waiting_approval' }) })

  it('writes an internal note signed by the rule, marks the reason, and logs a warning', async () => {
    await transitionTicket(session, { ...base, actor: rule })
    expect(h.comments).toEqual([{
      entityType: 'incident', entityId: 'inc-1', tenantId: 't1', isInternal: true, authorId: 'system', authorLabel: 'Escalate DB incidents',
      text: 'The rule «Escalate DB incidents» did not move the ticket to "resolved": the approval of the step is still pending',
    }])
    expect(h.txRuns).toEqual([{ cypher: expect.stringContaining('SET wi.refusal_noted = $noted'), params: { instanceId: 'wi-1', tenantId: 't1', noted: 'resolved|named_approval|errors.approval.pendingOnStep' } }])
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ guard: 'named_approval', path: 'rule', rule: 'Escalate DB incidents' }), 'An automatic move was refused: the ticket stays where it is')
  })

  it('the same reason again — the pass that asks every minute — writes nothing new; another reason does', async () => {
    h.ticket = ticket({ refusalNoted: 'resolved|named_approval|errors.approval.pendingOnStep' })
    await transitionTicket(session, { ...base, actor: rule })
    expect(h.comments).toEqual([])
    vi.mocked(ticketApprovalRefusal).mockResolvedValue({ status: 'rejected', approvalId: 'apr-1', stepName: 'waiting_approval' })
    await transitionTicket(session, { ...base, actor: rule })
    expect(h.comments).toHaveLength(1)
  })

  it('a person\'s refusal is the error on their screen: no note', async () => {
    await transitionTicket(session, { ...base, actor: staff('incident.write') })
    await transitionTicket(session, { ...base, actor: { kind: 'requester', userId: 'u-9' } })
    expect(h.comments).toEqual([])
  })

  it('checkTicketTransition: the guards alone — refused with its note, nothing moved', async () => {
    const refusal = await checkTicketTransition(session, { ...base, actor: { kind: 'system', path: 'step_deadline', userId: 'step_deadline' } })
    expect(refusal).toMatchObject({ guard: 'named_approval' })
    expect(h.comments[0]!['text']).toBe('The deadline of the step did not move the ticket to "resolved": the approval of the step is still pending')
    expect(engine).not.toHaveBeenCalled()
    vi.mocked(ticketApprovalRefusal).mockResolvedValue(null)
    expect(await checkTicketTransition(session, { ...base, actor: rule })).toBeNull()
  })
})

describe('the sentences', () => {
  const r = (over: Record<string, unknown>) => ({ guard: 'workflow', message: 'm', code: 'CONFLICT', final: true, ...over }) as never
  it('who asked and why, for each path and guard', async () => {
    expect(await refusalNote('t1', 'escalation', null, 'escalated', r({ guard: 'required_fields', extensions: { fields: ['impact', 'urgency'] } })))
      .toBe('The escalation did not move the ticket to "escalated": required fields are empty (impact, urgency)')
    expect(await refusalNote('t1', 'change_auto', null, 'scheduled', r({ guard: 'change_window', i18n: { key: 'errors.change.windowNeedsApprovals' } })))
      .toBe('The automatic transition did not move the ticket to "scheduled": the change is not approved for the release window')
    expect(await refusalNote('t1', 'timer', null, 'deploy', r({ guard: 'change_window', i18n: { key: 'errors.change.assessmentsIncomplete' } })))
      .toBe('The timer of the step did not move the ticket to "deploy": the assessment tasks or the deploy plan are not complete')
    expect(await refusalNote('t1', 'rule', null, 'x', r({ guard: 'request_approval' }))).toBe('An automation rule did not move the ticket to "x": the request needs its approval first')
    expect(await refusalNote('t1', 'approval', null, 'x', r({ guard: 'step_metadata' }))).toBe('The approval decision did not move the ticket to "x": the configuration of the step is not valid')
    expect(await refusalNote('t1', 'script', null, 'x', r({ guard: 'type_permission' }))).toBe('An operator\'s script did not move the ticket to "x": there is no permission to move this ticket')
    expect(await refusalNote('t1', 'change_follow', null, 'x', r({ guard: 'workflow', message: 'All tasks must be complete' })))
      .toBe('The linked change did not move the ticket to "x": the workflow refused it (All tasks must be complete)')
  })
})

describe('refusalError and personActor', () => {
  it('the refusal becomes the error a person sees, with its code, its key and its fields', () => {
    const e = refusalError({ guard: 'named_approval', message: 'Waiting', code: 'CONFLICT', final: true, i18n: { key: 'errors.approval.pendingOnStep', params: { step: 's' } }, extensions: { approvalId: 'apr-1' } })
    expect(e).toBeInstanceOf(GraphQLError)
    expect(e.message).toBe('Waiting')
    expect(e.extensions).toEqual({ code: 'CONFLICT', approvalId: 'apr-1', i18n: { key: 'errors.approval.pendingOnStep', params: { step: 's' } } })
  })

  it('the person of a GraphQL request, with the permissions of the role and the role (the gate of a change names it)', () => {
    const permissions = perms('incident.write')
    expect(personActor({ userId: 'u-1', permissions, role: 'operator' })).toEqual({ kind: 'person', userId: 'u-1', permissions, role: 'operator' })
  })
})
