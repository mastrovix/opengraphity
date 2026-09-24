/**
 * Approvazione multi-parte della Change (normal/emergency).
 *
 * Una change, entrando in un passo di scopo `approval`, richiede:
 *   - 1 approvazione del team "Change Manager" (team designato, is_change_manager)
 *   - 1 approvazione per ciascun OWNER GROUP distinto dei CI affected
 *
 * Ogni requisito è un nodo (c)-[:HAS_APPROVAL]->(:ChangeApproval {kind, team_id,
 * status}). Quando TUTTI sono 'approved' (incluso il Change Manager) la change
 * avanza automaticamente al passo di SCOPO `scheduled`; un rifiuto la riporta a
 * quello di scopo `assessment`, riaprendo i task scelti. I passi si
 * riconoscono dallo scopo e non dal nome (ondata 4 · A4-2): il cliente può
 * chiamarli «CAB settimanale», «in calendario», «valutazione». Le change
 * 'standard' sono pre-approvate: nessun record, nessun gate.
 *
 * I requisiti vengono creati/riconciliati in approvalCreation.ts; il gate
 * (assertAllApprovalsSatisfied) è condiviso con executeChangeTransition.
 */
import { GraphQLError } from 'graphql'
import { ForbiddenError, NotFoundError } from '../../../lib/errors.js'
import { workflowEngine } from '@opengraphity/workflow'
import { withSession, runQuery, runQueryOne } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { TASK_STATUS } from '../../../lib/taskStatus.js'
import { change as getChange } from './queries.js'
import { evaluateAutoTransitions } from '../../../services/change/autoTransitions.js'
import { afterEnterStep, getInstanceId, writeAudit } from '../../../services/change/helpers.js'
import { areAllApprovalsSatisfied } from '../../../services/change/approvalCreation.js'
import { targetStepByPurpose } from '../../../lib/workflowTargets.js'
import { deriveChangePriority } from '../../../services/change/scoring.js'
import { systemText } from '../../../lib/systemText.js'
import { transitionTicket } from '../../../services/ticketTransition.js'
import { hasPermission } from '../../../lib/permissions.js'

type Session = Parameters<typeof runQueryOne>[0]

/**
 * Può agire su un requisito del team: chi ne è membro, o chi decide per
 * qualunque team — mai chi ha chiesto la change (decisione del 24 set 2026:
 * «No, mai. La approva un altro membro del suo gruppo»), neanche con
 * `approval.override`.
 */
async function assertEligible(session: Session, changeId: string, teamId: string, ctx: GraphQLContext): Promise<void> {
  const own = await runQueryOne<{ own: boolean }>(session, `
    RETURN exists((:Change {id: $changeId, tenant_id: $tenantId})-[:REQUESTED_BY]->(:User {id: $userId, tenant_id: $tenantId})) AS own
  `, { changeId, userId: ctx.userId, tenantId: ctx.tenantId })
  if (own?.own === true) {
    throw new ForbiddenError('You asked for this change: another member of the team decides its approval', { key: 'errors.approval.ownChange' })
  }
  if (hasPermission(ctx, 'approval.override')) return
  const row = await runQueryOne<{ ok: boolean }>(session, `
    RETURN exists((:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(:Team {id: $teamId, tenant_id: $tenantId})) AS ok
  `, { userId: ctx.userId, tenantId: ctx.tenantId, teamId })
  if (!row?.ok) throw new ForbiddenError('You are not authorized to approve for this team', { key: 'errors.approval.notForThisTeam' })
}

/**
 * La change (non eliminata) deve essere in un passo di **scopo** `approval`;
 * ritorna tipo e nome team. Lo scopo si legge dal nodo del passo, che questa
 * query ha già in mano (ondata 4 · A4-2): prima il confronto era
 * `s.name <> 'approval'`, e un cliente che chiamava il suo passo «CAB
 * settimanale» non riusciva più né ad approvare né a rifiutare.
 */
async function assertInApproval(session: Session, changeId: string, teamId: string, tenantId: string): Promise<{ changeType: string; teamName: string }> {
  const row = await runQueryOne<{ step: string; purpose: string | null; changeType: string | null; teamName: string | null }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi)-[:CURRENT_STEP]->(s:WorkflowStep)
    WHERE coalesce(c.deleted, false) = false
    OPTIONAL MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
    RETURN s.name AS step, s.purpose AS purpose, c.change_type AS changeType, t.name AS teamName
  `, { changeId, teamId, tenantId })
  if (!row) throw new NotFoundError('Change')
  if (row.purpose !== 'approval') {
    throw new GraphQLError(`The change is not in the approval stage (step "${row.step}", purpose ${row.purpose ?? 'not declared'})`, { extensions: { code: 'BAD_USER_INPUT', i18n: { key: row.purpose ? 'errors.approval.notInApproval' : 'errors.approval.notInApprovalNoPurpose', params: { step: row.step, purpose: row.purpose ?? '' } } } })
  }
  // Il tipo della change DECIDE il varco (tipi pre-approvati, priorità): un
  // ripiego su «normal» faceva valutare un tipo che il cliente può avere
  // rinominato o non avere affatto (revisione totale · B-25). Un dato
  // incompleto si dice, non si indovina.
  if (row.changeType == null || String(row.changeType).trim() === '') {
    throw new GraphQLError(
      `The change ${changeId} has no change type: the approval gate cannot be evaluated. Set the type on the change.`,
      { extensions: { code: 'CONFLICT', i18n: { key: 'errors.change.noChangeType', params: { change: changeId } } } },
    )
  }
  return { changeType: String(row.changeType), teamName: row.teamName ?? teamId }
}

export async function approveChangeApproval(_: unknown, args: { changeId: string; teamId: string; note?: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const { teamName } = await assertInApproval(session, args.changeId, args.teamId, ctx.tenantId)
    await assertEligible(session, args.changeId, args.teamId, ctx)

    const now = new Date().toISOString()
    const upd = await runQueryOne<{ id: string }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_APPROVAL]->(a:ChangeApproval {team_id: $teamId, status: 'pending'})
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      SET a.status = 'approved', a.approved_by_id = $userId, a.approved_by_name = coalesce(u.name, $userId),
          a.approved_at = $now, a.note = $note
      RETURN a.id AS id
    `, { changeId: args.changeId, teamId: args.teamId, userId: ctx.userId, now, note: args.note ?? null, tenantId: ctx.tenantId })
    if (!upd) throw new GraphQLError('Approval requirement not found, or already resolved', { extensions: { code: 'NOT_FOUND', i18n: { key: 'errors.approval.requirementGone' } } })
    await writeAudit(session, args.changeId, ctx.tenantId, 'change_approved', ctx.userId,
      `${teamName}${args.note?.trim() ? `: ${args.note.trim()}` : ''}`)

    // Tutti i requisiti soddisfatti (Change Manager incluso)? → avanza a scheduled.
    // Una transizione fallita qui NON è tollerabile: l'utente vedrebbe
    // "approvato" con la change ferma per sempre in approval.
    if (await areAllApprovalsSatisfied(session, args.changeId, ctx.tenantId)) {
      // L'esito si scrive: prima `approval_status` restava null anche con tutti
      // i requisiti approvati (giro nel browser del 14 set 2026), e REST, PDF,
      // impatto e ticket collegati mostravano la change senza esito.
      // `approval_at` e la relazione APPROVED_BY: nessuno le scriveva, quindi
      // `Change.approvalAt` e `Change.approvalBy` erano SEMPRE null e il
      // dettaglio diceva «Approvata da: —, il: —» su una change approvata
      // (revisione totale · B-14). Chi chiude il varco è chi approva per
      // ultimo: è lui che rende la change approvata.
      await runQueryOne(session, `
        MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
        SET c.approval_status = 'approved', c.approval_at = $now, c.updated_at = $now
        WITH c
        OPTIONAL MATCH (c)-[old:APPROVED_BY]->(:User)
        DELETE old
        WITH c
        MATCH (u:User {id: $userId, tenant_id: $tenantId})
        MERGE (c)-[:APPROVED_BY]->(u)
        RETURN c.id AS id
      `, { changeId: args.changeId, tenantId: ctx.tenantId, userId: ctx.userId, now })
      const instanceId = await getInstanceId(session, args.changeId, ctx.tenantId)
      // Il bersaglio è il passo di SCOPO `scheduled` del tenant, non il nome
      // `scheduled`: fra i candidati si preferisce quello davvero raggiungibile
      // dal passo corrente. Se nessun passo dichiara lo scopo, l'errore lo dice
      // e indica il disegnatore (prima: un CONFLICT che non spiegava niente).
      const avail = await workflowEngine.getAvailableTransitions(session, instanceId, ctx.tenantId)
      const toStep = await targetStepByPurpose(session, ctx.tenantId, 'change', ['scheduled'],
        'change advance after all approvals', avail.map((t) => t.toStep))
      // The outcome of the approvals, through the pipeline of the transitions
      // (wave 7 · B1): the guards of the step still hold.
      const outcome = await transitionTicket(session, {
        tenantId: ctx.tenantId, instanceId, toStep, notes: await systemText(ctx.tenantId, 'change.approvalsComplete'),
        actor: { kind: 'system', path: 'approval', userId: ctx.userId }, triggerType: 'manual',
      })
      if (!outcome.moved) {
        const reason = outcome.refusal.message
        throw new GraphQLError(`Approvals complete but the change did not move to "${toStep}": ${reason}`, { extensions: { code: 'CONFLICT', i18n: { key: 'errors.approval.didNotAdvance', params: { step: toStep, reason } } } })
      }
      await afterEnterStep(session, args.changeId, ctx.tenantId, toStep)
      await evaluateAutoTransitions(session, args.changeId, ctx, afterEnterStep)
    }
    return getChange(null, { id: args.changeId }, ctx)
  }, true)
}

export async function rejectChangeApproval(_: unknown, args: { changeId: string; teamId: string; note: string; reopenAll?: boolean; reopenTaskIds?: string[] }, ctx: GraphQLContext) {
  if (!args.note?.trim()) throw new GraphQLError('The reason for the rejection is required', { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.approval.rejectNeedsNote' } } })
  const reopenAll = args.reopenAll ?? false
  const reopenIds = args.reopenTaskIds ?? []
  if (!reopenAll && reopenIds.length === 0) {
    throw new GraphQLError('Choose which assessments to reopen (or choose "all")', { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.change.chooseAssessmentsToReopen' } } })
  }
  return withSession(async (session) => {
    const { changeType, teamName } = await assertInApproval(session, args.changeId, args.teamId, ctx.tenantId)
    await assertEligible(session, args.changeId, args.teamId, ctx)
    const now = new Date().toISOString()
    // Priorità dal tipo con rischio azzerato: letta PRIMA della transazione
    // (legge la matrice del cliente, che è un'altra sessione).
    const priority = await deriveChangePriority(ctx.tenantId, changeType, null)

    // Un'unica transazione: riapre i task scelti (assessment + planning) a
    // in_progress azzerando i punteggi — così all_assessments_complete torna
    // falso e la change resta in assessment finché non vengono ricompilati —,
    // azzera rischio aggregato/rotta/priorità (che da esso derivano) e
    // cancella i requisiti (verranno ricreati al rientro in approval).
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      OPTIONAL MATCH (c)-[:HAS_ASSESSMENT|HAS_DEPLOY_PLAN]->(t)
        WHERE $all OR t.id IN $ids
      SET t.status = '${TASK_STATUS.IN_PROGRESS}', t.score = null, t.completed_at = null
      WITH c, t
      OPTIONAL MATCH (t)-[cb:COMPLETED_BY]->() DELETE cb
      WITH c, t
      OPTIONAL MATCH (c)-[r:AFFECTS_CI]->(ci {id: t.ci_id}) SET r.risk_score = null, r.ci_phase = 'assessment'
      WITH DISTINCT c
      SET c.aggregate_risk_score = null, c.approval_route = null, c.approval_status = 'rejected',
          c.priority = $priority, c.updated_at = $now
      WITH c
      OPTIONAL MATCH (c)-[:HAS_APPROVAL]->(a:ChangeApproval)
      DETACH DELETE a
    `, { changeId: args.changeId, tenantId: ctx.tenantId, all: reopenAll, ids: reopenIds, now, priority }))

    const instanceId = await getInstanceId(session, args.changeId, ctx.tenantId)
    // Il rifiuto riporta la change al passo di SCOPO `assessment` (il cliente
    // può averlo chiamato «valutazione»), preferendo quello raggiungibile.
    const availReject = await workflowEngine.getAvailableTransitions(session, instanceId, ctx.tenantId)
    const backStep = await targetStepByPurpose(session, ctx.tenantId, 'change', ['assessment'],
      'change return after an approval rejection', availReject.map((t) => t.toStep))
    // The rejection IS the move back the release window asks for: the pipeline
    // lets the approval path through (wave 7 · B1).
    const outcome = await transitionTicket(session, {
      tenantId: ctx.tenantId, instanceId, toStep: backStep,
      notes: await systemText(ctx.tenantId, 'change.approvalRejected', { note: args.note.trim() }),
      actor: { kind: 'system', path: 'approval', userId: ctx.userId }, triggerType: 'manual',
    })
    // Se fallisce, la change resta in approval con i task riaperti e senza
    // requisiti: il gate blocca l'approvazione e il rigetto è ripetibile.
    if (!outcome.moved) throw new GraphQLError(outcome.refusal.message, { extensions: { code: 'CONFLICT', i18n: outcome.refusal.i18n ?? { key: 'errors.approval.rejectFailed' } } })
    await writeAudit(session, args.changeId, ctx.tenantId, 'change_rejected', ctx.userId, `${teamName}: ${args.note.trim()}`)
    await afterEnterStep(session, args.changeId, ctx.tenantId, backStep)
    return getChange(null, { id: args.changeId }, ctx)
  }, true)
}

/** Field resolver Change.approvals. */
export async function changeApprovals(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{
      kind: string; teamId: string | null; teamName: string | null
      status: string; approvedByName: string | null; approvedAt: string | null
      isMember: boolean; ownChange: boolean
    }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_APPROVAL]->(a:ChangeApproval)
      OPTIONAL MATCH (team:Team {id: a.team_id, tenant_id: $tenantId})
      RETURN a.kind AS kind, a.team_id AS teamId, team.name AS teamName,
             a.status AS status, a.approved_by_name AS approvedByName, a.approved_at AS approvedAt,
             exists((:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(team)) AS isMember,
             exists((c)-[:REQUESTED_BY]->(:User {id: $userId, tenant_id: $tenantId})) AS ownChange
      ORDER BY CASE a.kind WHEN 'change_manager' THEN 0 ELSE 1 END, team.name
    `, { changeId: parent.id, tenantId: ctx.tenantId, userId: ctx.userId })
    const isAdmin = hasPermission(ctx, 'approval.override')
    return rows.map((r) => ({
      kind:           r.kind,
      teamId:         r.teamId,
      teamName:       r.teamName,
      status:         r.status,
      approvedByName: r.approvedByName,
      approvedAt:     r.approvedAt,
      canApprove:     r.status === 'pending' && !r.ownChange && (isAdmin || r.isMember),
      // Giro del 14 set 2026 (#34): l'admin approva anche a nome di un team di
      // cui non fa parte; la pagina glielo dice e chiede conferma.
      onBehalf:       r.status === 'pending' && !r.ownChange && isAdmin && !r.isMember,
      // The requester sees why they cannot decide (24 Sep 2026).
      ownChange:      r.status === 'pending' && r.ownChange,
    }))
  })
}
