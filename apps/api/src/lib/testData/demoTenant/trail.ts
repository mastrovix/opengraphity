/**
 * ONE TICKET'S LIFE, WRITTEN THE WAY THE APP WRITES IT (23 Sep 2026).
 *
 * The generator simulates people using the app on a ticket over time. Each
 * method here is one thing the app does when a person acts, with exactly the
 * traces the app leaves (read from the code, not guessed):
 *
 *  - `transition`: `workflowEngine.transition` — the open history row closes,
 *    a new one opens, the instance points at the new step, the ticket's
 *    status follows, `resolved_at`/`root_cause`/`completed_at` where the
 *    step's category asks for them; then the step-entered hook: an internal
 *    comment "Workflow: <step>[ — notes]" and an Audit Log entry
 *    `<entity>.step_entered` with the step's facts;
 *  - `zeroLengthRow`: the history row the incident service writes on a
 *    reassignment after the first step (entered = exited, duration 0);
 *  - `systemComment`: `createTransitionComment` (internal, does not touch
 *    the ticket's `updated_at`); `personComment`: `writeTicketComment` (does);
 *  - `setTeam` / `setUser`: `setTicketTeam` / `setTicketUser`, including the
 *    team history the OLA pages read (`TicketTeamSegment`).
 *
 * Every move is checked against the tenant's live workflow (`assertMove`):
 * the generator cannot write a history the app could not have produced.
 */
import type { Rng } from './random.js'
import type { AuditRow } from './writeReference.js'
import { auditRow } from './writeReference.js'
import { assertMove, type ConditionFacts, type LiveDefinition, type LiveStep, type TriggerType, type WorkflowEntity } from './workflowModel.js'
import { int } from './writer.js'

export const TICKET_LABEL: Record<WorkflowEntity, 'Incident' | 'Problem' | 'Change' | 'ServiceRequest' | 'KBArticle'> = {
  incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'ServiceRequest', kb_article: 'KBArticle',
}

/** A person (or 'system' / 'automation' / 'step_deadline') acting in the app. */
export interface Actor { id: string; email: string; name: string }

export const SYSTEM_ACTOR: Actor = { id: 'system', email: 'system', name: 'system' }
export const AUTOMATION_ACTOR: Actor = { id: 'automation', email: 'automation', name: 'automation' }
/** The Event Management engine (`services/events/shared.ts` MONITORING_ACTOR): it opens and closes incidents. */
export const MONITORING_ACTOR: Actor = { id: 'monitoring', email: 'monitoring', name: 'monitoring' }

/** What the whole simulation shares: texts in the tenant's language, step facts for the audit. */
export interface TrailContext {
  rng: Rng
  text(key: string, params?: Record<string, string>): string
  /** `loadStepFacts` of the app for (entity, step): the `details` of a step_entered audit row. */
  stepFacts(entity: WorkflowEntity, step: string): Record<string, unknown>
  /** An instant as the app writes it into a ticket: in the tenant's language and time zone (`formatInstantIn`). */
  instant(ms: number): string
}

export interface ExecutionRow {
  id: string
  instance_id: string
  step_name: string
  from_step?: string
  entered_at: string
  exited_at?: string
  duration_ms?: number | ReturnType<typeof int>
  triggered_by: string
  trigger_type: string
  notes?: string
  deadline_outcome?: string
  deadline_reason?: string
  deadline_to_step?: string
  deadline_checked_at?: string
}

export interface CommentRow {
  id: string
  text: string
  is_internal: boolean
  author_id: string
  created_at: string
  updated_at: string
}

export interface SegmentRow { id: string; team_id: string; started_at: string; ended_at?: string; inferred: false }

export interface Move { atMs: number; step: LiveStep }

export class TicketTrail {
  readonly instanceId: string
  /** The id of the ticket's SLAStatus node, if it gets one. */
  readonly slaId: string
  readonly executions: ExecutionRow[] = []
  readonly comments: CommentRow[] = []
  readonly audits: AuditRow[] = []
  readonly segments: SegmentRow[] = []
  /** The steps entered after the initial one: the SLA replays these. */
  readonly moves: Move[] = []
  current: LiveStep
  teamId: string | null = null
  assigneeId: string | null = null
  updatedAtMs: number
  lastEventMs: number
  resolvedAtMs: number | null = null
  completedAtMs: number | null = null
  rootCause: string | null = null
  statusSet = false
  private openExecution: ExecutionRow

  constructor(
    private readonly ctx: TrailContext,
    readonly entity: WorkflowEntity,
    readonly id: string,
    readonly def: LiveDefinition,
    readonly createdAtMs: number,
  ) {
    this.instanceId = ctx.rng.uuid()
    this.slaId = ctx.rng.uuid()
    this.current = def.initialStep
    this.updatedAtMs = createdAtMs
    this.lastEventMs = createdAtMs
    // createInstance: the initial row, by the system, with no previous step.
    this.openExecution = {
      id: ctx.rng.uuid(), instance_id: this.instanceId, step_name: def.initialStep.name,
      entered_at: new Date(createdAtMs).toISOString(), triggered_by: 'system', trigger_type: 'automatic',
    }
    this.executions.push(this.openExecution)
  }

  get label(): 'Incident' | 'Problem' | 'Change' | 'ServiceRequest' | 'KBArticle' { return TICKET_LABEL[this.entity] }

  /**
   * The step-entered hook writes its note and its audit for TICKETS only
   * (lib/stepEnteredPublisher.ts, TICKET_ENTITIES): an article's move leaves
   * its history row and nothing else.
   */
  private get stepTrace(): boolean { return this.entity !== 'kb_article' }

  private assertTime(atMs: number, what: string): void {
    if (atMs < this.lastEventMs) {
      throw new Error(`${this.entity} ${this.id}: "${what}" at ${new Date(atMs).toISOString()} is before the previous event (${new Date(this.lastEventMs).toISOString()})`)
    }
    this.lastEventMs = atMs
  }

  /**
   * `workflowEngine.transition` + the step-entered trace. `actor` is who the
   * hook signs the comment and the audit with (`ActionContext.userId`);
   * `triggeredBy` is what the history row says (they differ for automatic
   * moves made during a person's action: the row says `system`).
   */
  transition(
    to: string, atMs: number, actor: Actor, trigger: TriggerType, notes: string | null,
    opts: { triggeredBy?: string; facts?: ConditionFacts; automaticOnManual?: boolean; comment?: boolean } = {},
  ): LiveStep {
    this.assertTime(atMs, `→ ${to}`)
    const step = assertMove(this.def, this.current.name, to, trigger, { ...opts.facts, rootCause: opts.facts?.rootCause ?? notes },
      `${this.entity} ${this.id}`, { automaticOnManual: opts.automaticOnManual })
    const at = new Date(atMs).toISOString()
    this.openExecution.exited_at = at
    this.openExecution.duration_ms = atMs - Date.parse(this.openExecution.entered_at)
    const row: ExecutionRow = {
      id: this.ctx.rng.uuid(), instance_id: this.instanceId, step_name: step.name, from_step: this.current.name,
      entered_at: at, triggered_by: opts.triggeredBy ?? actor.id, trigger_type: trigger,
      ...(notes ? { notes } : {}),
    }
    this.executions.push(row)
    this.openExecution = row
    const leaving = this.current
    this.current = step
    this.statusSet = true
    this.updatedAtMs = atMs

    // The ticket follows the step (engine.ts): resolved category, terminal, reopen.
    if (step.category === 'resolved') {
      this.resolvedAtMs = atMs
      if (notes) this.rootCause = notes
    } else if (step.isTerminal && (this.entity === 'service_request' || this.entity === 'change')) {
      if (this.completedAtMs === null) this.completedAtMs = atMs
    } else if (leaving.category === 'resolved' && !step.isTerminal) {
      this.resolvedAtMs = null
      if (this.entity === 'incident') this.rootCause = null
    }
    this.moves.push({ atMs, step })

    // The step-entered trace. The monitoring engine moves an incident WITHOUT
    // a comment per step (runMonitoringTransition with comment=false, and
    // incidentService.resolveIncident writes none): it leaves one summary
    // comment at the end instead. `comment: false` is that.
    const stepLabel = step.label || step.name
    if (!this.stepTrace) return step
    if (opts.comment !== false) {
      const text = notes?.trim()
        ? this.ctx.text('workflow.transitionCommentNotes', { step: stepLabel, notes: notes.trim() })
        : this.ctx.text('workflow.transitionComment', { step: stepLabel })
      this.comments.push({ id: this.ctx.rng.uuid(), text, is_internal: true, author_id: actor.id, created_at: at, updated_at: at })
    }
    this.audits.push(auditRow(this.ctx.rng, actor, `${this.entity}.step_entered`, this.label, this.id, atMs,
      { ...this.ctx.stepFacts(this.entity, step.name), legacy_action: `${this.entity}.${step.name}` }))
    return step
  }

  /** The row the incident service writes on a reassignment past the first step. */
  zeroLengthRow(atMs: number, actor: Actor, notes: string): void {
    this.assertTime(atMs, 'reassignment row')
    const at = new Date(atMs).toISOString()
    this.executions.push({
      id: this.ctx.rng.uuid(), instance_id: this.instanceId, step_name: this.current.name,
      entered_at: at, exited_at: at, duration_ms: int(0), triggered_by: actor.id, trigger_type: 'manual', notes,
    })
  }

  /** `createTransitionComment`: internal, and the ticket's `updated_at` does not move. */
  systemComment(atMs: number, actor: Actor, text: string): void {
    this.assertTime(atMs, 'system comment')
    const at = new Date(atMs).toISOString()
    this.comments.push({ id: this.ctx.rng.uuid(), text, is_internal: true, author_id: actor.id, created_at: at, updated_at: at })
  }

  /** `writeTicketComment` from a person: the ticket's `updated_at` moves. Returns the comment id. */
  personComment(atMs: number, actor: Actor, text: string, isInternal: boolean): string {
    this.assertTime(atMs, 'comment')
    const at = new Date(atMs).toISOString()
    const id = this.ctx.rng.uuid()
    this.comments.push({ id, text, is_internal: isInternal, author_id: actor.id, created_at: at, updated_at: at })
    this.updatedAtMs = atMs
    return id
  }

  audit(atMs: number, actor: Actor, action: string, details?: Record<string, unknown>, entityType?: string): void {
    this.audits.push(auditRow(this.ctx.rng, actor, action, entityType ?? this.label, this.id, atMs, details))
  }

  /**
   * `setTicketTeam`: the current team changes, the open segment of another
   * team closes, a segment opens for the new one (unless already open).
   * Returns whether the assignee had to be removed (not a member).
   */
  setTeam(atMs: number, teamId: string, isMember: (userId: string, teamId: string) => boolean): { removedAssignee: string | null } {
    this.assertTime(atMs, 'team assignment')
    const at = new Date(atMs).toISOString()
    for (const s of this.segments) if (s.ended_at === undefined && s.team_id !== teamId) s.ended_at = at
    if (!this.segments.some((s) => s.ended_at === undefined && s.team_id === teamId)) {
      this.segments.push({ id: this.ctx.rng.uuid(), team_id: teamId, started_at: at, inferred: false })
    }
    this.teamId = teamId
    this.updatedAtMs = atMs
    let removedAssignee: string | null = null
    if (this.assigneeId && !isMember(this.assigneeId, teamId)) {
      removedAssignee = this.assigneeId
      this.assigneeId = null
    }
    return { removedAssignee }
  }

  /** `setTicketUser`. */
  setUser(atMs: number, userId: string): void {
    this.assertTime(atMs, 'user assignment')
    this.assigneeId = userId
    this.updatedAtMs = atMs
  }

  /** The timer close of a step deadline (lib/stepDeadlines.ts), on the row being left. */
  markDeadlineMoved(toStep: string, sweptAtMs: number): void {
    this.openExecution.deadline_outcome = 'moved'
    this.openExecution.deadline_reason = 'deadline'
    this.openExecution.deadline_to_step = toStep
    this.openExecution.deadline_checked_at = new Date(sweptAtMs).toISOString()
  }

  /** The instance node's final state. */
  instanceProps(): Record<string, unknown> {
    return {
      id: this.instanceId, definition_id: this.def.id, entity_id: this.id, entity_type: this.entity,
      current_step: this.current.name, status: this.current.isTerminal ? 'completed' : 'active',
      created_at: new Date(this.createdAtMs).toISOString(),
      updated_at: new Date(this.moves.length ? this.moves[this.moves.length - 1]!.atMs : this.createdAtMs).toISOString(),
    }
  }
}
