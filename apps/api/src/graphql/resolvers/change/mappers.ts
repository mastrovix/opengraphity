import { mapCI } from '../ci-utils.js'
import { mapUser, mapTeam } from '../../../lib/mappers.js'

export type Props = Record<string, unknown>

export { mapUser, mapTeam }

export function mapChange(props: Props) {
  return {
    id:             props['id']             as string,
    tenantId:       props['tenant_id']      as string,
    title:          props['title']          as string,
    description:    (props['description']   ?? null) as string | null,
    type:           props['type']           as string,
    priority:       (props['priority']      ?? 'medium') as string,
    status:         props['status']         as string,
    scheduledStart: (props['scheduled_start'] ?? null) as string | null,
    scheduledEnd:   (props['scheduled_end']   ?? null) as string | null,
    implementedAt:  (props['implemented_at']  ?? null) as string | null,
    createdAt:      props['created_at']     as string,
    updatedAt:      props['updated_at']     as string,
    // populated by field resolvers
    assignedTeam: null, assignee: null,
    affectedCIs: [], relatedIncidents: [],
    changeTasks: [],
    createdBy: null, comments: [],
  }
}

export function mapChangeTask(
  props: Props,
  ci?: Props | null,
  team?: Props | null,
  user?: Props | null,
  vTeam?: Props | null,
  vUser?: Props | null,
) {
  return {
    id:                props['id']                 as string,
    taskType:          props['task_type']           as string,
    changeId:          props['change_id']           as string,
    status:            props['status']              as string,
    title:             (props['title']              ?? null) as string | null,
    order:             (props['order']              ?? null) as number | null,
    description:       (props['description']        ?? null) as string | null,
    notes:             (props['notes']              ?? null) as string | null,
    riskLevel:         (props['risk_level']         ?? null) as string | null,
    impactDescription: (props['impact_description'] ?? null) as string | null,
    mitigation:        (props['mitigation']         ?? null) as string | null,
    skipReason:        (props['skip_reason']        ?? null) as string | null,
    completedAt:       (props['completed_at']       ?? null) as string | null,
    scheduledStart:    (props['scheduled_start']    ?? null) as string | null,
    scheduledEnd:      (props['scheduled_end']      ?? null) as string | null,
    durationDays:      (props['duration_days']      ?? null) as number | null,
    hasValidation:     (props['has_validation']     ?? null) as boolean | null,
    validationStatus:  (props['validation_status']  ?? null) as string | null,
    validationStart:   (props['validation_start']   ?? null) as string | null,
    validationEnd:     (props['validation_end']     ?? null) as string | null,
    validationNotes:   (props['validation_notes']   ?? null) as string | null,
    type:              (props['type']               ?? null) as string | null,
    rollbackPlan:      (props['rollback_plan']      ?? null) as string | null,
    createdAt:         (props['created_at']         ?? null) as string | null,
    ciId:              (props['ci_id']              ?? null) as string | null,
    ci:                ci    ? mapCI(ci)    : null,
    assignedTeam:      team  ? mapTeam(team)  : null,
    assignee:          user  ? mapUser(user)  : null,
    validationTeam:    vTeam ? mapTeam(vTeam) : null,
    validationUser:    vUser ? mapUser(vUser) : null,
  }
}

export function mapWI(wi: Record<string, unknown>) {
  return {
    id:          wi['id']           as string,
    currentStep: wi['current_step'] as string,
    status:      wi['status']       as string,
    createdAt:   wi['created_at']   as string,
    updatedAt:   wi['updated_at']   as string,
  }
}

export function mapExec(e: Record<string, unknown>) {
  return {
    id: e['id'] as string, stepName: e['step_name'] as string,
    enteredAt: e['entered_at'] as string, exitedAt: (e['exited_at'] ?? null) as string | null,
    durationMs: e['duration_ms'] == null ? null : (typeof e['duration_ms'] === 'object' ? (e['duration_ms'] as { toNumber(): number }).toNumber() : Math.round(Number(e['duration_ms']))),
    triggeredBy: e['triggered_by'] as string, triggerType: e['trigger_type'] as string,
    notes: (e['notes'] ?? null) as string | null,
  }
}

export function mapChangeComment(props: Props, user?: Props | null) {
  return {
    id:        props['id']         as string,
    changeId:  props['change_id']  as string,
    text:      props['text']       as string,
    type:      props['type']       as string,
    createdAt: props['created_at'] as string,
    createdBy: user ? mapUser(user) : null,
  }
}

export function toInt(v: unknown, fallback = 0): number {
  if (v == null) return fallback
  if (typeof v === 'number') return v
  if (typeof (v as { toNumber?: () => number }).toNumber === 'function')
    return (v as { toNumber: () => number }).toNumber()
  return Number(v)
}
