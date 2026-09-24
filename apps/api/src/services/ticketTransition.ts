/**
 * ONE WAY TO MOVE A TICKET (review of 23 Sep 2026, architecture#0 — wave 7 · B1).
 *
 * Twenty-six calls to `workflowEngine.transition` in sixteen files, each one
 * choosing which checks to run: the required fields of the step in five of
 * them, the approval a request needs in two, the approver named by the step
 * in two, the release window of a change in six, the step's metadata in
 * three. Nineteen passed the engine an empty context, so the step actions
 * that write the graph failed there and the ticket moved on anyway. The rules,
 * the automations and the escalation walked past the approvals the owner had
 * decided belong to the approver.
 *
 * Here every path describes only who asks and what for; the service does the
 * rest, always in the same order:
 *
 *   1. the ticket as it is stored (the data the step actions and their
 *      conditions read — the paths no longer bring it);
 *   2. the guards, for every path (owner's decision of 24 Sep 2026):
 *      the write permission of the type (a person in the app), the release
 *      window of a change, the approval a request needs, the approver named
 *      by the step, the required fields of the step, the step's metadata;
 *   3. the engine: the arc, its trigger and its condition, the move, the
 *      step actions (done by the handlers the process registered,
 *      workflow/stepActions.ts), the step-entered hook (events, the note,
 *      the audit, the notifications);
 *   4. the fields the step writes on entry.
 *
 * The answer is one: moved (with the errors of the actions, which never undo
 * a persisted move), or refused with the guard and a translation key. A
 * person's path turns a refusal into the error on the screen (`refusalError`).
 * An automatic path leaves the ticket where it is, with an internal note
 * that names the guard and who asked (the rule by its name), written once
 * per reason, and no retry; an error of the engine that is not a refusal
 * stays an error, and a queue retries it.
 */
import { GraphQLError } from 'graphql'
import type { Session } from 'neo4j-driver'
import { workflowEngine, type TransitionResult, type WorkflowTrigger } from '@opengraphity/workflow'
import type { Permission } from '@opengraphity/types'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../context.js'
import { matchById } from '../lib/cypherLookups.js'
import { logger } from '../lib/logger.js'
import { preflightStepMetadata } from '../lib/stepMetadataPreflight.js'
import { validateStepRequirements } from '../lib/validateRequiredFields.js'
import { requestApprovalWouldBeSkipped } from '../lib/requestApproval.js'
import { APPROVAL_GATED_TICKETS, ticketApprovalRefusal } from '../lib/ticketApprovalGate.js'
import { applyOnEnterFields } from '../lib/onEnterFields.js'
import { TransitionRefusedError } from '../lib/transitionRefused.js'
import { systemText, type SystemTextKey } from '../lib/systemText.js'
import * as gate from './change/windowGate.js'

const log = logger.child({ module: 'ticket-transition' })

/**
 * Who moves the ticket when it is not a person: each path by its name. It
 * signs the note of a refusal, and it decides the few things that differ by
 * path (an approval decision IS the decision the gates wait for).
 */
export type SystemPath =
  | 'rule'                // a business rule or an automatic trigger (`transition_workflow`, an assignment)
  | 'escalation'          // an SLA breach's escalation arc
  | 'step_deadline'       // a step deadline
  | 'timer'               // the exit of a timer_wait step
  | 'change_auto'         // the automatic arcs of a change (the walk, the resume pass)
  | 'change_follow'       // a problem or an incident following its change
  | 'approval'            // the outcome of an approval decision
  | 'investigation'       // continuous improvement opening or closing an investigation
  | 'service_monitoring'  // a monitored service back to health resolving its incident
  | 'event_auto_resolve'  // the alarm cleared resolving its incident
  | 'event_reopen'        // an alarm back, or a storm still running, reopening its incident
  | 'script'              // an operator's script

export type TransitionActor =
  /**
   * A person working in the app. With `permissions` (a GraphQL request) the
   * write permission of the ticket's type is checked here and
   * `approval.override` lets the named approvals pass; without them the
   * entry point checked the permission of its operation (the incident
   * service reached from Slack).
   */
  | { kind: 'person'; userId: string; label?: string | null; permissions?: ReadonlySet<Permission>; role?: string }
  /** The person who opened the ticket, from the portal: the caller checked it is theirs. */
  | { kind: 'requester'; userId: string }
  | { kind: 'system'; path: SystemPath; userId?: string; label?: string | null }

export interface TicketTransitionRequest {
  tenantId:    string
  instanceId:  string
  toStep:      string
  notes?:      string | null
  actor:       TransitionActor
  /** How the engine records it; a person follows only `manual` arcs. */
  triggerType: WorkflowTrigger
  /** Values the caller has just written and the conditions must see (a deadline's fields). */
  extraEntityData?: Record<string, unknown>
}

export type TransitionGuard =
  | 'type_permission'   // the person may not write this type of ticket
  | 'change_window'     // the change would enter the release window, or leave the assessment, without what it needs
  | 'request_approval'  // the request would skip the approval it needs
  | 'named_approval'    // the approver named by the step has not decided, or rejected
  | 'required_fields'   // the step's required fields are empty
  | 'step_metadata'     // the step's configuration is not valid JSON
  | 'workflow'          // the engine: no such arc, an arc of the system, its condition, a concurrent move

export interface TransitionRefusal {
  guard:    TransitionGuard
  /** The English sentence, for the logs and the integrations. */
  message:  string
  /** The code of the GraphQL error a person sees. */
  code:     string
  i18n?:    { key: string; params?: Record<string, string> }
  /** More fields of the GraphQL error (the approval that holds, the empty fields). */
  extensions?: Record<string, unknown>
  /**
   * A refusal is an answer: retrying does not change it. False only for an
   * error of the engine that may be transient (a concurrent move, a failure
   * of the database): a queue retries those.
   */
  final:    boolean
  /** The engine's answer, when the engine refused. */
  engine?:  TransitionResult
}

export type TicketTransitionOutcome =
  | {
      moved: true
      result: TransitionResult
      entityType: string
      entityId: string
      fromStep: string
      /** The actions of the step that failed after the move (the engine's and the fields of the step). */
      actionErrors: string[]
    }
  | { moved: false; refusal: TransitionRefusal; entityType: string; entityId: string; fromStep: string }

/** The write permission of each type of ticket, for a person in the app. */
export const TRANSITION_WRITE_PERMISSION: Readonly<Record<string, Permission>> = {
  incident:        'incident.write',
  problem:         'problem.write',
  change:          'change.write',
  service_request: 'request.write',
  kb_article:      'kb.write',
}

/** The actor of a GraphQL request: a person, with the permissions of their role. */
export function personActor(ctx: Pick<GraphQLContext, 'userId' | 'permissions' | 'role'>): TransitionActor {
  return { kind: 'person', userId: ctx.userId, permissions: ctx.permissions, role: ctx.role }
}

/** The GraphQL error a person sees for a refusal; it carries the refusal (lib/transitionRefused.ts). */
export function refusalError(refusal: TransitionRefusal): TransitionRefusedError {
  return new TransitionRefusedError(refusal)
}

interface TicketState {
  entityType:   string
  entityId:     string
  currentStep:  string
  props:        Record<string, unknown>
  assignedTo:   string | null
  assignedTeam: string | null
  /** The reason of the last refusal already written on the ticket (the note is not repeated). */
  refusalNoted: string | null
}

async function loadTicket(session: Session, tenantId: string, instanceId: string): Promise<TicketState | null> {
  const row = await runQueryOne<{
    entityType: string; entityId: string; currentStep: string; props: Record<string, unknown> | null
    assignedTo: string | null; assignedTeam: string | null; refusalNoted: string | null
  }>(session, `
    MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
    ${matchById('entity', { labels: 'entities', id: 'wi.entity_id', imports: ['wi'], optional: true })}
    OPTIONAL MATCH (entity)-[:ASSIGNED_TO]->(assignee)
    OPTIONAL MATCH (entity)-[:ASSIGNED_TO_TEAM]->(team)
    RETURN wi.entity_type AS entityType, wi.entity_id AS entityId, wi.current_step AS currentStep,
           properties(entity) AS props, assignee.id AS assignedTo, team.id AS assignedTeam,
           wi.refusal_noted AS refusalNoted
    LIMIT 1
  `, { instanceId, tenantId })
  if (!row) return null
  return {
    entityType: row.entityType, entityId: row.entityId, currentStep: row.currentStep, props: row.props ?? {},
    assignedTo: row.assignedTo ?? null, assignedTeam: row.assignedTeam ?? null, refusalNoted: row.refusalNoted ?? null,
  }
}

/** A guard that answers by throwing a GraphQL error (the shared checks), as a refusal. */
async function asRefusal(guard: TransitionGuard, check: () => Promise<void>): Promise<TransitionRefusal | null> {
  try {
    await check()
    return null
  } catch (err) {
    if (!(err instanceof GraphQLError)) throw err
    const { code, i18n, ...rest } = err.extensions as { code?: string; i18n?: TransitionRefusal['i18n'] } & Record<string, unknown>
    return {
      guard, message: err.message, code: code ?? 'CONFLICT', final: true,
      ...(i18n ? { i18n } : {}), ...(Object.keys(rest).length ? { extensions: rest } : {}),
    }
  }
}

const canOverride = (actor: TransitionActor): boolean =>
  actor.kind === 'person' && actor.permissions?.has('approval.override') === true

async function changeWindowRefusal(session: Session, req: TicketTransitionRequest, t: TicketState): Promise<TransitionRefusal | null> {
  const input = {
    tenantId: req.tenantId, changeId: t.entityId, changeType: String(t.props['change_type'] ?? ''),
    currentStep: t.currentStep, toStep: req.toStep,
  }
  if (req.actor.kind === 'person') {
    // The manual gate: its sentences name the two ways out, and needs
    // `approval.override` to leave the approval on behalf of the approvers
    // (its refusal names the person's role).
    const ctx = { role: req.actor.role ?? 'person', permissions: req.actor.permissions ?? new Set<Permission>() } as unknown as GraphQLContext
    return asRefusal('change_window', () => gate.assertChangeWindowGate(session, ctx, input))
  }
  const outcome = await gate.automaticTransitionOutcome(session, input)
  if (outcome.allowed) return null
  // The rejection of a change's approval IS the move back to the assessment
  // the gate asks for (rejectChangeApproval): for that path it is open.
  if (req.actor.kind === 'system' && req.actor.path === 'approval' && outcome.reason === 'use_reject_mutation') return null
  // Counted and written at `warn` there, as before.
  await gate.automaticTransitionAllowed(session, input, gatePathOf(req.actor))
  const assessments = outcome.reason === 'needs_assessments'
  return {
    guard: 'change_window', final: true, code: 'CONFLICT',
    message: assessments
      ? `The change cannot leave the assessment: its assessment tasks or deploy plan are not complete`
      : `The change cannot enter the release window without its approvals (${outcome.reason})`,
    i18n: { key: assessments ? 'errors.change.assessmentsIncomplete' : 'errors.change.windowNeedsApprovals' },
  }
}

function gatePathOf(actor: TransitionActor): 'auto_transition' | 'timer_job' | 'rule_action' | 'sla_breach' | 'step_deadline' {
  if (actor.kind !== 'system') return 'auto_transition'
  switch (actor.path) {
    case 'rule':          return 'rule_action'
    case 'escalation':    return 'sla_breach'
    case 'step_deadline': return 'step_deadline'
    case 'timer':         return 'timer_job'
    default:              return 'auto_transition'
  }
}

/** The guards, in their order. The first that holds the ticket is the answer. */
async function guardRefusal(session: Session, req: TicketTransitionRequest, t: TicketState): Promise<TransitionRefusal | null> {
  const { actor } = req

  if (actor.kind === 'person' && actor.permissions) {
    const needed = TRANSITION_WRITE_PERMISSION[t.entityType]
    if (!needed) {
      return { guard: 'type_permission', final: true, code: 'BAD_USER_INPUT',
        message: `Workflow instance ${req.instanceId} belongs to "${t.entityType}", which cannot be moved`,
        i18n: { key: 'errors.workflow.unknownEntityType', params: { entityType: t.entityType } } }
    }
    if (!actor.permissions.has(needed)) {
      return { guard: 'type_permission', final: true, code: 'FORBIDDEN',
        message: `Not authorized to move this ${t.entityType} (requires ${needed})`,
        i18n: { key: 'errors.authz.permissionRequired', params: { required: needed } } }
    }
  }

  if (t.entityType === 'change') {
    const refused = await changeWindowRefusal(session, req, t)
    if (refused) return refused
  }

  if (t.entityType === 'service_request') {
    // A person moving the request out of its approval step is the decision;
    // so is the approval's own outcome. A deadline or a rule is not.
    const byPerson = actor.kind !== 'system' || actor.path === 'approval'
    if (await requestApprovalWouldBeSkipped(session, req.tenantId, req.instanceId, req.toStep, { byPerson })) {
      return { guard: 'request_approval', final: true, code: 'CONFLICT',
        message: 'This request needs an approval: send it to approval first',
        i18n: { key: 'errors.request.approvalRequired' } }
    }
  }

  if (APPROVAL_GATED_TICKETS.includes(t.entityType) && !canOverride(actor)) {
    const held = await ticketApprovalRefusal(session, req.tenantId, req.instanceId, req.toStep)
    if (held) {
      return { guard: 'named_approval', final: true, code: 'CONFLICT',
        message: held.status === 'pending'
          ? `The ticket is waiting for an approval in step "${held.stepName}": the approvers decide, from the Approvals page`
          : `The approval in step "${held.stepName}" was rejected: the ticket can only be closed or cancelled`,
        i18n: { key: held.status === 'pending' ? 'errors.approval.pendingOnStep' : 'errors.approval.rejectedOnStep', params: { step: held.stepName } },
        extensions: { approvalId: held.approvalId } }
    }
  }

  const fields = await asRefusal('required_fields', () => validateStepRequirements(session, {
    entityType: t.entityType, entityProps: { ...t.props, ...(req.extraEntityData ?? {}) }, notes: req.notes ?? null,
    tenantId: req.tenantId, toStep: req.toStep,
  }))
  if (fields) return fields

  return asRefusal('step_metadata', () => preflightStepMetadata(session, req.instanceId, req.toStep, req.tenantId))
}

/**
 * The engine's no, as a refusal. Its answers with a translation key are
 * refusals (no arc, an arc of the system, a condition); a concurrent move and
 * an answer without a key (a failure of the database) may be transient.
 */
function engineRefusal(result: TransitionResult): TransitionRefusal {
  const key = result.errorI18n?.key
  const final = Boolean(result.refusedByCondition) || (key !== undefined && key !== 'errors.workflow.concurrentTransition')
  return {
    guard: 'workflow', final, code: 'CONFLICT', engine: result,
    message: result.error ?? 'The workflow refused the transition',
    ...(result.errorI18n ? { i18n: { key: result.errorI18n.key, ...(result.errorI18n.params ? { params: result.errorI18n.params } : {}) } } : {}),
  }
}

/** The actor as the engine records it. */
function triggeredBy(actor: TransitionActor): string {
  return actor.kind === 'system' ? (actor.userId ?? 'system') : actor.userId
}

/**
 * The guards alone, without moving: for a path that writes something of its
 * own before the move (a deadline writes its fields) and must not write it
 * for a move that will be refused. A refusal leaves its note, as in
 * `transitionTicket`; the engine's arc and condition are checked by the move.
 */
export async function checkTicketTransition(session: Session, req: TicketTransitionRequest): Promise<TransitionRefusal | null> {
  const ticket = await loadTicket(session, req.tenantId, req.instanceId)
  if (!ticket) {
    throw new GraphQLError(`Workflow instance not found: ${req.instanceId}`, { extensions: { code: 'NOT_FOUND' } })
  }
  const refused = await guardRefusal(session, req, ticket)
  if (refused) await afterRefusal(session, req, ticket, refused)
  return refused
}

/**
 * Moves the ticket of `instanceId` to `toStep`, or says why not. Throws only
 * when the instance is not the tenant's, or on a failure that is not an
 * answer (the database).
 */
export async function transitionTicket(session: Session, req: TicketTransitionRequest): Promise<TicketTransitionOutcome> {
  const ticket = await loadTicket(session, req.tenantId, req.instanceId)
  if (!ticket) {
    throw new GraphQLError(`Workflow instance not found: ${req.instanceId}`, { extensions: { code: 'NOT_FOUND' } })
  }
  const where = { entityType: ticket.entityType, entityId: ticket.entityId, fromStep: ticket.currentStep }

  const refused = await guardRefusal(session, req, ticket)
  if (refused) {
    await afterRefusal(session, req, ticket, refused)
    return { moved: false, refusal: refused, ...where }
  }

  const userId = triggeredBy(req.actor)
  const result = await workflowEngine.transition(session, {
    instanceId:  req.instanceId,
    toStepName:  req.toStep,
    triggeredBy: userId,
    triggerType: req.triggerType,
    ...(req.notes ? { notes: req.notes } : {}),
    actorLabel:  req.actor.kind === 'system' ? (req.actor.label ?? null) : (req.actor.kind === 'person' ? (req.actor.label ?? null) : null),
    tenantId:    req.tenantId,
  }, {
    userId,
    ...(req.notes ? { notes: req.notes } : {}),
    entityData: {
      ...ticket.props, ...(req.extraEntityData ?? {}),
      assigned_to: ticket.assignedTo, assigned_team: ticket.assignedTeam,
    },
  })
  if (!result.success) {
    const refusal = engineRefusal(result)
    await afterRefusal(session, req, ticket, refusal)
    return { moved: false, refusal, ...where }
  }

  const actionErrors = [...(result.actionErrors ?? [])]
  // The fields the step writes on entry, on every path. After the move: a
  // failure is an error of the step's actions, like the engine's.
  try {
    await applyOnEnterFields(session, req.instanceId, req.toStep, userId, req.notes ?? undefined, req.tenantId)
  } catch (err) {
    const msg = `on_enter_fields: ${err instanceof Error ? err.message : String(err)}`
    log.error({ err, tenantId: req.tenantId, instanceId: req.instanceId, toStep: req.toStep }, 'The ticket moved, but the fields of the step were not written')
    actionErrors.push(msg)
  }
  if (ticket.refusalNoted) {
    // The ticket moved: a later refusal for the same reason is news again.
    await runQuery(session, `MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId}) REMOVE wi.refusal_noted`,
      { instanceId: req.instanceId, tenantId: req.tenantId })
  }
  if (actionErrors.length > 0) {
    log.error({ tenantId: req.tenantId, instanceId: req.instanceId, toStep: req.toStep, actionErrors }, 'The ticket moved, but some actions of the step did not run')
  }
  return { moved: true, result, actionErrors, ...where }
}

/**
 * What a refusal leaves behind. A person sees it as an error, from the
 * caller. For an automatic path nobody is looking: the ticket gets an
 * internal note naming the guard and who asked — once per reason, since the
 * passes that ask again every minute would fill the ticket — and the log
 * a warning. An error of the engine that is not final is only logged: the
 * queue retries it.
 */
async function afterRefusal(session: Session, req: TicketTransitionRequest, t: TicketState, refusal: TransitionRefusal): Promise<void> {
  if (req.actor.kind !== 'system') return
  const path = req.actor.path
  if (!refusal.final) {
    log.error({ tenantId: req.tenantId, entityType: t.entityType, entityId: t.entityId, toStep: req.toStep, path, reason: refusal.message },
      'An automatic move failed: not a refusal, it may be retried')
    return
  }
  log.warn({ tenantId: req.tenantId, entityType: t.entityType, entityId: t.entityId, fromStep: t.currentStep, toStep: req.toStep,
    path, rule: req.actor.label ?? null, guard: refusal.guard, reason: refusal.message }, 'An automatic move was refused: the ticket stays where it is')

  const noted = `${req.toStep}|${refusal.guard}|${refusal.i18n?.key ?? refusal.message}`
  if (t.refusalNoted === noted) return
  const text = await refusalNote(req.tenantId, path, req.actor.label, req.toStep, refusal)
  const { writeTicketComment } = await import('../lib/ticketComments.js')
  await session.executeWrite(async (tx) => {
    await writeTicketComment(tx as never, {
      entityType: t.entityType, entityId: t.entityId, tenantId: req.tenantId, text,
      authorId: 'system', authorLabel: req.actor.kind === 'system' ? (req.actor.label ?? 'system') : 'system', isInternal: true,
    })
    await tx.run(`MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId}) SET wi.refusal_noted = $noted`,
      { instanceId: req.instanceId, tenantId: req.tenantId, noted })
  })
}

/** Who asked for the move, by path: the subject of the note. A rule signs with its name. */
const MOVED_BY: Readonly<Record<SystemPath, SystemTextKey>> = {
  rule:               'workflow.moveBy.anyRule',
  escalation:         'workflow.moveBy.escalation',
  step_deadline:      'workflow.moveBy.step_deadline',
  timer:              'workflow.moveBy.timer',
  change_auto:        'workflow.moveBy.change_auto',
  change_follow:      'workflow.moveBy.change_follow',
  approval:           'workflow.moveBy.approval',
  investigation:      'workflow.moveBy.investigation',
  service_monitoring: 'workflow.moveBy.service_monitoring',
  event_auto_resolve: 'workflow.moveBy.event_auto_resolve',
  event_reopen:       'workflow.moveBy.event_reopen',
  script:             'workflow.moveBy.script',
}

/** The note of a refusal, in the tenant's language: who asked, where to, and which guard held the ticket. */
export async function refusalNote(tenantId: string, path: SystemPath, label: string | null | undefined, toStep: string, refusal: TransitionRefusal): Promise<string> {
  const who = path === 'rule' && label
    ? await systemText(tenantId, 'workflow.moveBy.rule', { rule: label })
    : await systemText(tenantId, MOVED_BY[path])
  const reason = await refusalReason(tenantId, refusal)
  return systemText(tenantId, 'workflow.moveRefused', { who, step: toStep, reason })
}

async function refusalReason(tenantId: string, refusal: TransitionRefusal): Promise<string> {
  switch (refusal.guard) {
    case 'required_fields': {
      const fields = Array.isArray(refusal.extensions?.['fields']) ? (refusal.extensions['fields'] as string[]).join(', ') : ''
      return systemText(tenantId, 'workflow.refusedBy.required_fields', { fields })
    }
    case 'named_approval':
      return systemText(tenantId, refusal.i18n?.key === 'errors.approval.rejectedOnStep' ? 'workflow.refusedBy.approval_rejected' : 'workflow.refusedBy.approval_pending')
    case 'change_window':
      return systemText(tenantId, refusal.i18n?.key === 'errors.change.assessmentsIncomplete' ? 'workflow.refusedBy.assessments' : 'workflow.refusedBy.change_window')
    case 'workflow':
      return systemText(tenantId, 'workflow.refusedBy.workflow', { detail: refusal.message })
    case 'request_approval':
      return systemText(tenantId, 'workflow.refusedBy.request_approval')
    case 'step_metadata':
      return systemText(tenantId, 'workflow.refusedBy.step_metadata')
    case 'type_permission':
      return systemText(tenantId, 'workflow.refusedBy.type_permission')
  }
}
