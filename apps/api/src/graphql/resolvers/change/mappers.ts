import { mapCI } from '../ci-utils.js'
import { mapUser, mapTeam } from '../../../lib/mappers.js'

export type Props = Record<string, unknown>

export { mapCI, mapUser, mapTeam }

export function toInt(v: unknown, fallback = 0): number {
  if (v == null) return fallback
  if (typeof v === 'number') return v
  if (typeof (v as { toNumber?: () => number }).toNumber === 'function')
    return (v as { toNumber: () => number }).toNumber()
  return Number(v)
}

export function mapChange(props: Props) {
  return {
    id:                 props['id']                  as string,
    tenantId:           props['tenant_id']           as string,
    code:               props['code']                as string,
    title:              props['title']               as string,
    description:        (props['description']          ?? null) as string | null,
    aggregateRiskScore: props['aggregate_risk_score'] != null ? toInt(props['aggregate_risk_score']) : null,
    approvalRoute:      (props['approval_route']       ?? null) as string | null,
    approvalStatus:     (props['approval_status']      ?? null) as string | null,
    approvalAt:         (props['approval_at']          ?? null) as string | null,
    createdAt:          props['created_at']          as string,
    updatedAt:          props['updated_at']          as string,
    requester:   null,
    changeOwner: null,
    approvalBy:  null,
  }
}

export function mapAssessmentTask(props: Props) {
  return {
    id:            props['id']             as string,
    code:          (props['code'] ?? '')   as string,
    responderRole: props['responder_role'] as string,
    status:        props['status']         as string,
    score:         props['score'] != null ? toInt(props['score']) : null,
    completedAt:   (props['completed_at']    ?? null) as string | null,
    createdAt:     props['created_at']     as string,
    completedBy:   null,
    assignedTeam:  null,
    assignee:      null,
    responses:     [] as unknown[],
  }
}

export function mapAnswerOption(props: Props) {
  return {
    id:        props['id']    as string,
    label:     props['label'] as string,
    score:     toInt(props['score']),
    sortOrder: toInt(props['sort_order']),
  }
}

export function mapAssessmentQuestion(props: Props) {
  return {
    id:        props['id']         as string,
    text:      props['text']       as string,
    category:  props['category']   as string,
    isCore:    Boolean(props['is_core']),
    isActive:  Boolean(props['is_active']),
    createdAt: props['created_at'] as string,
    options:   [] as ReturnType<typeof mapAnswerOption>[],
  }
}

export function mapValidationTest(props: Props) {
  return {
    id:       props['id']        as string,
    code:     (props['code'] ?? '') as string,
    status:   props['status']    as string,
    result:   (props['result']     ?? null) as string | null,
    testedAt: (props['tested_at']  ?? null) as string | null,
    testedBy: null,
  }
}

type RawWindow = { start?: unknown; end?: unknown }
type RawStep   = { title?: unknown; validationWindow?: RawWindow; releaseWindow?: RawWindow }

function parseSteps(v: unknown): Array<{ title: string; validationWindow: { start: string; end: string }; releaseWindow: { start: string; end: string } }> {
  if (typeof v !== 'string' || v.length === 0) return []
  try {
    const arr = JSON.parse(v) as unknown
    if (!Array.isArray(arr)) return []
    return (arr as RawStep[])
      .filter((s): s is RawStep => typeof s === 'object' && s !== null)
      .map((s) => ({
        title: String(s.title ?? ''),
        validationWindow: {
          start: String(s.validationWindow?.start ?? ''),
          end:   String(s.validationWindow?.end   ?? ''),
        },
        releaseWindow: {
          start: String(s.releaseWindow?.start ?? ''),
          end:   String(s.releaseWindow?.end   ?? ''),
        },
      }))
  } catch {
    return []
  }
}

export function mapDeployPlanTask(props: Props) {
  return {
    id:          props['id']            as string,
    code:        (props['code'] ?? '')  as string,
    status:      props['status']        as string,
    steps:       parseSteps(props['steps']),
    completedAt: (props['completed_at'] ?? null) as string | null,
    createdAt:   props['created_at']    as string,
    assignedTeam: null,
    assignee:     null,
    completedBy:  null,
  }
}

export function mapDeploymentTask(props: Props) {
  return {
    id:         props['id']         as string,
    code:       (props['code'] ?? '') as string,
    status:     props['status']     as string,
    deployedAt: (props['deployed_at'] ?? null) as string | null,
    deployedBy: null,
  }
}

export function mapReviewTask(props: Props) {
  return {
    id:         props['id']         as string,
    code:       (props['code'] ?? '') as string,
    status:     props['status']     as string,
    result:     (props['result']      ?? null) as string | null,
    reviewedAt: (props['reviewed_at']  ?? null) as string | null,
    reviewedBy: null,
  }
}

export function mapAuditEntry(props: Props) {
  return {
    timestamp: props['timestamp'] as string,
    action:    props['action']    as string,
    detail:    (props['detail']     ?? null) as string | null,
    actor:     null,
  }
}
