/**
 * THE APPROVAL REQUEST A STEP CREATES (`create_approval_request`), for every
 * path that moves a ticket (wave 7 · B1).
 *
 * It lived inside the manual transition as a callback of its ActionContext:
 * the other twenty-five paths could not create it, and a step «the budget
 * owner approves» entered by a rule or an escalation failed with the ticket
 * moved on. Now it is the handler the process registers
 * (workflow/stepActions.ts).
 */
import { GraphQLError } from 'graphql'
import type { Session } from 'neo4j-driver'
import { v4 as uuidv4 } from 'uuid'
import { sseManager } from '@opengraphity/notifications'
import type { StepActionActor, StepActionEntity, StepApprovalRequestParams } from '@opengraphity/workflow'
import { systemText } from './systemText.js'

/**
 * CHI APPROVA (moduli del catalogo, ondata 3).
 *
 * Prima solo il RUOLO: «tutti gli admin», o tutti quelli di un ruolo. Per un
 * catalogo servizi non basta — l'approvazione di una spesa è del responsabile
 * di budget, non di chi amministra il prodotto.
 *
 * Ora tre sorgenti che si UNISCONO senza ripetizioni: il ruolo, le persone
 * indicate, i membri delle squadre indicate. Se non è indicato niente vale il
 * ruolo `admin`, come prima.
 *
 * Le persone e i membri si verificano nel tenant: un id inventato non diventa
 * un approvatore fantasma che blocca il ticket per sempre.
 */
export async function createStepApprovalRequest(
  session: Session, actor: StepActionActor, entity: StepActionEntity, params: StepApprovalRequestParams,
): Promise<string> {
  const { approverRole, approverUserIds, approverTeamIds, approvalType, title } = params
  const now = new Date().toISOString()

  const perRuolo = approverUserIds?.length || approverTeamIds?.length
    ? []
    : (await session.executeRead((tx) => tx.run(
      // Only active people approve (review of 23 Sep 2026): a deactivated
      // admin counted, and an «all» approval could never complete.
      `MATCH (u:User {tenant_id: $tenantId, role: $role}) WHERE coalesce(u.active, true) RETURN u.id AS id`,
      { tenantId: actor.tenantId, role: approverRole ?? 'admin' },
    ))).records.map((r) => r.get('id') as string)

  const perNome = approverUserIds?.length
    ? (await session.executeRead((tx) => tx.run(
      `MATCH (u:User {tenant_id: $tenantId}) WHERE u.id IN $ids AND coalesce(u.active, true) RETURN u.id AS id`,
      { tenantId: actor.tenantId, ids: approverUserIds },
    ))).records.map((r) => r.get('id') as string)
    : []

  const perSquadra = approverTeamIds?.length
    ? (await session.executeRead((tx) => tx.run(
      `MATCH (t:Team {tenant_id: $tenantId})<-[:MEMBER_OF]-(u:User {tenant_id: $tenantId})
       WHERE t.id IN $ids AND coalesce(u.active, true)
       RETURN DISTINCT u.id AS id`,
      { tenantId: actor.tenantId, ids: approverTeamIds },
    ))).records.map((r) => r.get('id') as string)
    : []

  const finalApprovers = [...new Set([...perRuolo, ...perNome, ...perSquadra])]
  if (finalApprovers.length === 0) {
    // Il messaggio dice QUALE delle tre sorgenti era stata chiesta: «nessun
    // admin» e «la squadra indicata è vuota» si correggono in due posti diversi.
    const chiesto = approverUserIds?.length || approverTeamIds?.length
      ? `the people/teams configured to approve (users: ${(approverUserIds ?? []).length}, teams: ${(approverTeamIds ?? []).length}) have no active member in this organization`
      : `no user with role "${approverRole ?? 'admin'}" configured to approve`
    throw new GraphQLError(`Approval cannot start: ${chiesto}`, {
      extensions: {
        code: 'NO_APPROVER',
        i18n: approverUserIds?.length || approverTeamIds?.length
          ? { key: 'errors.workflow.noApproverTarget', params: {} }
          : { key: 'errors.workflow.noApprover', params: { role: approverRole ?? 'admin' } },
      },
    })
  }

  const approvalId = uuidv4()
  await session.executeWrite((tx) =>
    tx.run(`
      CREATE (ap:ApprovalRequest {
        id:              $id,
        tenant_id:       $tenantId,
        entity_type:     $entityType,
        entity_id:       $entityId,
        title:           $title,
        description:     null,
        status:          'pending',
        requested_by:    $requestedBy,
        requested_at:    $now,
        approvers:       $approvers,
        approved_by:     '[]',
        rejected_by:     null,
        approval_type:   $approvalType,
        due_date:        null,
        resolved_at:     null,
        resolution_note: null,
        step_name:       $stepName
      })
    `, {
      id:           approvalId,
      // The step it holds: the one being entered (lib/ticketApprovalGate.ts).
      stepName:     actor.stepName,
      tenantId:     actor.tenantId,
      entityType:   entity.type,
      entityId:     entity.id,
      title,
      requestedBy:  actor.userId,
      now,
      approvers:    JSON.stringify(finalApprovers),
      approvalType: approvalType ?? 'any',
    }),
  )

  // Notify each approver via SSE
  for (const approverId of finalApprovers) {
    sseManager.sendToUser(actor.tenantId, approverId, {
      id:          uuidv4(),
      type:        'approval.requested',
      title:          'notification.approval.requested.title',
      title_fallback: await systemText(actor.tenantId, 'approval.requested'),
      message:     title,
      severity:    'info',
      entity_id:   approvalId,
      entity_type: 'ApprovalRequest',
      timestamp:   now,
      read:        false,
    })
  }

  return approvalId
}
