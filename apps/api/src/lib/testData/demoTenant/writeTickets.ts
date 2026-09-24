/**
 * WRITING THE SIMULATED TICKETS (23 Sep 2026).
 *
 * The nodes and relationships each kind of ticket has in the app, in the
 * direction the app writes them (read from the services, see the notes in
 * incidents.ts, problems.ts, changes.ts and serviceRequests.ts). What every
 * ticket has in common — the workflow instance and its history, the
 * comments, the Audit Log, the team history, the SLA — is written by
 * `writeTrails`.
 */
import type { DemoWriter } from './writer.js'
import type { TicketTrail } from './trail.js'
import type { SlaStatusRow } from './slaSim.js'
import type { SimulatedIncident } from './incidents.js'
import type { SimulatedProblem } from './problems.js'
import type { SimulatedChange } from './changes.js'
import type { SimulatedRequest } from './serviceRequests.js'

const iso = (ms: number): string => new Date(ms).toISOString()

interface TrailBundle {
  trail: TicketTrail
  sla: SlaStatusRow | null
  watchers: Array<{ userId: string; atMs: number }>
}

/** Everything a ticket has because it lives in a workflow. */
async function writeTrails(w: DemoWriter, label: string, bundles: readonly TrailBundle[]): Promise<void> {
  await w.nodes(['WorkflowInstance'], bundles.map((b) => b.trail.instanceProps()))
  await w.relationships(label, 'HAS_WORKFLOW', 'WorkflowInstance', bundles.map((b) => ({ from: b.trail.id, to: b.trail.instanceId })))
  await w.relationships('WorkflowInstance', 'CURRENT_STEP', 'WorkflowStep', bundles.map((b) => ({ from: b.trail.instanceId, to: b.trail.current.id })))
  await w.children('WorkflowInstance', 'STEP_HISTORY', ['WorkflowStepExecution'],
    bundles.flatMap((b) => b.trail.executions.map((e) => ({ parent: b.trail.instanceId, props: { ...e } }))))
  await w.children(label, 'HAS_COMMENT', ['Comment'],
    bundles.flatMap((b) => b.trail.comments.map((c) => ({ parent: b.trail.id, props: { ...c } }))))
  await w.nodes(['AuditEntry'], bundles.flatMap((b) => b.trail.audits))
  await w.children(label, 'TEAM_SEGMENT', ['TicketTeamSegment'],
    bundles.flatMap((b) => b.trail.segments.map((s) => ({ parent: b.trail.id, props: { ...s } }))))
  await w.relationships(label, 'ASSIGNED_TO_TEAM', 'Team', bundles.filter((b) => b.trail.teamId).map((b) => ({ from: b.trail.id, to: b.trail.teamId! })))
  await w.relationships(label, 'ASSIGNED_TO', 'User', bundles.filter((b) => b.trail.assigneeId).map((b) => ({ from: b.trail.id, to: b.trail.assigneeId! })))
  await w.relationships('User', 'WATCHES', label, bundles.flatMap((b) => b.watchers.map((x) => ({ from: x.userId, to: b.trail.id, props: { watched_at: iso(x.atMs) } }))))
  await w.children(label, 'HAS_SLA', ['SLAStatus'], bundles.filter((b) => b.sla).map((b) => ({
    parent: b.trail.id,
    props: { id: b.trail.slaId, entity_id: b.trail.id, entity_type: b.trail.entity, ...b.sla },
  })))
}

/** The ticket's own properties that follow its history. */
function lifecycleProps(t: TicketTrail): Record<string, unknown> {
  return {
    status: t.current.name,
    updated_at: iso(t.updatedAtMs),
    ...(t.resolvedAtMs !== null ? { resolved_at: iso(t.resolvedAtMs) } : {}),
    ...(t.rootCause ? { root_cause: t.rootCause } : {}),
  }
}

export async function writeIncidents(w: DemoWriter, sims: readonly SimulatedIncident[], numbers: Map<string, string>): Promise<void> {
  await w.nodes(['Incident'], sims.map((s) => ({
    id: s.skeleton.id, number: numbers.get(s.skeleton.id)!, title: s.title, description: s.description,
    severity: s.skeleton.severity, impact: s.skeleton.impact, urgency: s.skeleton.urgency, category: s.skeleton.category,
    created_at: iso(s.skeleton.createdAtMs), created_by: s.skeleton.creatorId, channel: s.skeleton.channel,
    // Born from an alarm, as `openIncidentFromEvent` marks it (G39).
    ...(s.skeleton.born ? { origin: 'event' } : {}),
    ...lifecycleProps(s.trail),
  })))
  await w.relationships('Incident', 'AFFECTED_BY', 'ConfigurationItem', sims.flatMap((s) => s.skeleton.ciIds.map((ci) => ({ from: s.skeleton.id, to: ci }))))
  await writeTrails(w, 'Incident', sims)
  await w.relationships('Incident', 'RESOLVED_BY', 'Change', sims.filter((s) => s.resolvingChange).map((s) => ({
    from: s.skeleton.id, to: s.resolvingChange!.changeId, props: { auto: true },
  })))
}

export async function writeProblems(w: DemoWriter, sims: readonly SimulatedProblem[], numbers: Map<string, string>): Promise<void> {
  await w.nodes(['Problem'], sims.map((s) => ({
    id: s.skeleton.id, number: numbers.get(s.skeleton.id)!, title: s.title, description: s.description,
    priority: s.skeleton.priority, impact: s.skeleton.impact, urgency: s.skeleton.urgency,
    // D20: filed under its category, as the creation form offers.
    category: s.skeleton.story.category,
    created_at: iso(s.skeleton.createdAtMs),
    ...(s.workaround ? { workaround: s.workaround } : {}),
    ...lifecycleProps(s.trail),
  })))
  await w.relationships('Problem', 'CREATED_BY', 'User', sims.map((s) => ({ from: s.skeleton.id, to: s.skeleton.creatorId })))
  await w.relationships('Problem', 'AFFECTS', 'ConfigurationItem', sims.map((s) => ({ from: s.skeleton.id, to: s.skeleton.ciId })))
  await w.relationships('Problem', 'CAUSED_BY', 'Incident', sims.flatMap((s) => s.skeleton.incidentIds.map((i) => ({ from: s.skeleton.id, to: i }))))
  await writeTrails(w, 'Problem', sims)
  await w.relationships('Problem', 'RESOLVED_BY', 'Change', sims.filter((s) => s.changeId).map((s) => ({
    from: s.skeleton.id, to: s.changeId!, props: { auto: true },
  })))
}

export async function writeChanges(w: DemoWriter, sims: readonly SimulatedChange[]): Promise<void> {
  await w.nodes(['Change'], sims.map((s) => ({ ...s.props })))
  await w.relationships('Change', 'REQUESTED_BY', 'User', sims.map((s) => ({ from: s.skeleton.id, to: s.skeleton.requesterId })))
  await w.relationships('Change', 'OWNED_BY', 'User', sims.map((s) => ({ from: s.skeleton.id, to: s.skeleton.ownerId })))
  await w.relationships('Change', 'AFFECTS_CI', 'ConfigurationItem', sims.flatMap((s) => s.affects.map((a) => ({ from: s.skeleton.id, to: a.ciId, props: a.props }))))
  await w.relationships('Change', 'APPROVED_BY', 'User', sims.filter((s) => s.approvedById).map((s) => ({ from: s.skeleton.id, to: s.approvedById! })))
  for (const [label, rel] of [
    ['AssessmentTask', 'HAS_ASSESSMENT'], ['DeployPlanTask', 'HAS_DEPLOY_PLAN'], ['ValidationTest', 'HAS_VALIDATION'],
    ['DeploymentTask', 'HAS_DEPLOYMENT'], ['ReviewTask', 'HAS_REVIEW'],
  ] as const) {
    const tasks = sims.flatMap((s) => s.tasks.filter((t) => t.label === label).map((t) => ({ change: s.skeleton.id, t })))
    await w.children('Change', rel, [label], tasks.map(({ change, t }) => ({ parent: change, props: { ...t.props } })))
    await w.relationships(label, 'ASSIGNED_TO_TEAM', 'Team', tasks.filter(({ t }) => t.teamId).map(({ t }) => ({ from: t.props['id'] as string, to: t.teamId! })))
    await w.children(label, 'TEAM_SEGMENT', ['TicketTeamSegment'], tasks.filter(({ t }) => t.teamId).map(({ t }) => ({
      parent: t.props['id'] as string,
      props: { id: t.segmentId, team_id: t.teamId, started_at: iso(t.createdAtMs), inferred: false },
    })))
    await w.relationships(label, 'ASSIGNED_TO', 'User', tasks.filter(({ t }) => t.assigneeId).map(({ t }) => ({ from: t.props['id'] as string, to: t.assigneeId! })))
    for (const doneRel of ['COMPLETED_BY', 'TESTED_BY', 'DEPLOYED_BY', 'REVIEWED_BY']) {
      await w.relationships(label, doneRel, 'User', tasks.filter(({ t }) => t.doneBy?.rel === doneRel).map(({ t }) => ({ from: t.props['id'] as string, to: t.doneBy!.userId })))
    }
  }
  const responses = sims.flatMap((s) => s.responses)
  await w.children('AssessmentTask', 'HAS_RESPONSE', ['AssessmentResponse'], responses.map((r) => ({ parent: r.taskId, props: { id: r.id, answered_at: iso(r.answeredAtMs) } })))
  await w.relationships('AssessmentResponse', 'ANSWERS', 'AssessmentQuestion', responses.map((r) => ({ from: r.id, to: r.questionId })))
  await w.relationships('AssessmentResponse', 'SELECTED', 'AnswerOption', responses.map((r) => ({ from: r.id, to: r.optionId })))
  await w.relationships('AssessmentResponse', 'ANSWERED_BY', 'User', responses.map((r) => ({ from: r.id, to: r.userId })))
  await w.children('Change', 'HAS_APPROVAL', ['ChangeApproval'], sims.flatMap((s) => s.approvals.map((a) => ({ parent: s.skeleton.id, props: { ...a.props } }))))
  const audits = sims.flatMap((s) => s.changeAudits.map((a) => ({ change: s.skeleton.id, a })))
  await w.children('Change', 'HAS_AUDIT', ['ChangeAuditEntry'], audits.map(({ change, a }) => {
    const { byUserId, ...props } = a
    void byUserId
    return { parent: change, props }
  }))
  await w.relationships('ChangeAuditEntry', 'BY', 'User', audits.filter(({ a }) => a.byUserId).map(({ a }) => ({ from: a.id, to: a.byUserId! })))
  await writeTrails(w, 'Change', sims.map((s) => ({ trail: s.trail, sla: null, watchers: s.watchers })))
}

export async function writeRequests(w: DemoWriter, sims: readonly SimulatedRequest[], numbers: Map<string, string>): Promise<void> {
  await w.nodes(['ServiceRequest'], sims.map((s) => ({
    id: s.id, number: numbers.get(s.id)!, title: s.title, description: s.description, priority: s.priority, category: s.category,
    catalog_item_id: s.item.id, created_by: s.creatorId, requires_approval: s.requiresApproval,
    created_at: iso(s.createdAtMs), form_revision: s.item.revision,
    ...(s.trail.completedAtMs !== null ? { completed_at: iso(s.trail.completedAtMs) } : {}),
    ...s.form.props,
    ...lifecycleProps(s.trail),
  })))
  await w.relationships('ServiceRequest', 'REQUESTED_BY', 'User', sims.map((s) => ({ from: s.id, to: s.creatorId })))
  for (const [fieldType, rel, label] of [['ref_ci', 'FORM_REFERS_TO_CI', 'ConfigurationItem'], ['ref_user', 'FORM_REFERS_TO_USER', 'User'], ['ref_team', 'FORM_REFERS_TO_TEAM', 'Team']] as const) {
    await w.relationships('ServiceRequest', rel, label, sims.flatMap((s) => s.form.references
      .filter((r) => r.fieldType === fieldType).flatMap((r) => r.ids.map((id) => ({ from: s.id, to: id, props: { field: r.field } })))))
  }
  await w.children('ServiceRequest', 'FORM_TABLE_ROW', ['FormTableRow'], sims.flatMap((s) => s.form.tables.flatMap((t) =>
    t.rows.map((values, index) => ({ parent: s.id, props: { ...values }, relProps: { field: t.field, row_index: index } })))))
  await writeTrails(w, 'ServiceRequest', sims)
}
