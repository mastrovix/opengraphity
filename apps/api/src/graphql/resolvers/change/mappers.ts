import { mapCI } from '../ci-utils.js'
import { mapUser, mapTeam } from '../../../lib/mappers.js'
import { toNumber } from '@opengraphity/neo4j'
import { parseDeploySteps } from '../../../lib/deployWindows.js'

export type Props = Record<string, unknown>

export { mapCI, mapUser, mapTeam }

export function mapChange(props: Props) {
  const aggregateRiskScore = props['aggregate_risk_score'] != null ? toNumber(props['aggregate_risk_score']) : null
  const changeType = (props['change_type'] ?? 'normal') as string
  return {
    id:                 props['id']                  as string,
    tenantId:           props['tenant_id']           as string,
    code:               props['code']                as string,
    title:              props['title']               as string,
    why:                (props['why']                  ?? null) as string | null,
    what:               (props['what']                 ?? null) as string | null,
    aggregateRiskScore,
    // Priorità (ITIL): tipo × fascia di rischio. Memorizzata sul nodo
    // (aggiornata a creazione e ad ogni ricalcolo del rischio).
    //
    // Ondata 7 (B-14): qui NON si deriva più niente. Il fallback derivato
    // «per i change creati prima dell'introduzione del campo» era una
    // seconda sorgente della priorità — sincrona, quindi cieca alla matrice
    // del cliente — che a ogni lettura poteva contraddire quella scritta sul
    // nodo. Una change senza `priority` è un dato incompleto e si mostra
    // così: il campo SDL è nullabile, il web lo rende «—». Dal vivo
    // (12 set 2026) le change senza `priority` sono zero.
    priority:           (props['priority'] ?? null) as string | null,
    approvalRoute:      (props['approval_route']       ?? null) as string | null,
    changeType,
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
    score:         props['score'] != null ? toNumber(props['score']) : null,
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
    score:     toNumber(props['score']),
    sortOrder: toNumber(props['sort_order']),
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

export function mapDeployPlanTask(props: Props) {
  return {
    id:          props['id']            as string,
    code:        (props['code'] ?? '')  as string,
    status:      props['status']        as string,
    // Parser condiviso con la soppressione degli allarmi (lib/deployWindows):
    // JSON corrotto → errore, mai un piano "vuoto" al posto di uno rotto.
    steps:       parseDeploySteps(props['steps']),
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
