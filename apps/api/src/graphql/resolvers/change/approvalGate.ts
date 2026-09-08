/**
 * Approvazione multi-parte della Change (normal/emergency).
 *
 * Una change, entrando nello step "approval", richiede:
 *   - 1 approvazione del team "Change Manager" (team designato, is_change_manager)
 *   - 1 approvazione per ciascun OWNER GROUP distinto dei CI affected
 *
 * Ogni requisito è un nodo (c)-[:HAS_APPROVAL]->(:ChangeApproval {kind, team_id,
 * status}). Quando TUTTI sono 'approved' (incluso il Change Manager) la change
 * avanza automaticamente a "scheduled". Un rifiuto riporta la change ad
 * "assessment" riaprendo i task scelti. Le change 'standard' sono
 * pre-approvate: nessun record, nessun gate.
 *
 * I requisiti vengono creati/riconciliati in approvalCreation.ts; il gate
 * (assertAllApprovalsSatisfied) è condiviso con executeChangeTransition.
 */
import { GraphQLError } from 'graphql'
import { workflowEngine } from '@opengraphity/workflow'
import { withSession, runQuery, runQueryOne } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { TASK_STATUS } from '../../../lib/taskStatus.js'
import { change as getChange } from './queries.js'
import { evaluateAutoTransitions } from './autoTransitions.js'
import { afterEnterStep, getInstanceId, writeAudit } from './helpers.js'
import { areAllApprovalsSatisfied } from './approvalCreation.js'
import { deriveChangePriority } from './scoring.js'

type Session = Parameters<typeof runQueryOne>[0]

/** True quando l'utente può agire su un requisito del team: admin o membro. */
async function assertEligible(session: Session, teamId: string, ctx: GraphQLContext): Promise<void> {
  if (ctx.role === 'admin') return
  const row = await runQueryOne<{ ok: boolean }>(session, `
    RETURN exists((:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(:Team {id: $teamId, tenant_id: $tenantId})) AS ok
  `, { userId: ctx.userId, tenantId: ctx.tenantId, teamId })
  if (!row?.ok) throw new GraphQLError('Non sei autorizzato ad approvare per questo team', { extensions: { code: 'FORBIDDEN' } })
}

/** La change (non eliminata) deve essere in "approval"; ritorna tipo e nome team. */
async function assertInApproval(session: Session, changeId: string, teamId: string, tenantId: string): Promise<{ changeType: string; teamName: string }> {
  const row = await runQueryOne<{ step: string; changeType: string | null; teamName: string | null }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi)-[:CURRENT_STEP]->(s:WorkflowStep)
    WHERE coalesce(c.deleted, false) = false
    OPTIONAL MATCH (t:Team {id: $teamId, tenant_id: $tenantId})
    RETURN s.name AS step, c.change_type AS changeType, t.name AS teamName
  `, { changeId, teamId, tenantId })
  if (!row) throw new GraphQLError('Change non trovata', { extensions: { code: 'NOT_FOUND' } })
  if (row.step !== 'approval') throw new GraphQLError('La change non è in fase di approvazione', { extensions: { code: 'BAD_USER_INPUT' } })
  return { changeType: row.changeType ?? 'normal', teamName: row.teamName ?? teamId }
}

export async function approveChangeApproval(_: unknown, args: { changeId: string; teamId: string; note?: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const { teamName } = await assertInApproval(session, args.changeId, args.teamId, ctx.tenantId)
    await assertEligible(session, args.teamId, ctx)

    const now = new Date().toISOString()
    const upd = await runQueryOne<{ id: string }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_APPROVAL]->(a:ChangeApproval {team_id: $teamId, status: 'pending'})
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      SET a.status = 'approved', a.approved_by_id = $userId, a.approved_by_name = coalesce(u.name, $userId),
          a.approved_at = $now, a.note = $note
      RETURN a.id AS id
    `, { changeId: args.changeId, teamId: args.teamId, userId: ctx.userId, now, note: args.note ?? null, tenantId: ctx.tenantId })
    if (!upd) throw new GraphQLError('Requisito di approvazione non trovato o già risolto', { extensions: { code: 'NOT_FOUND' } })
    await writeAudit(session, args.changeId, ctx.tenantId, 'change_approved', ctx.userId,
      `${teamName}${args.note?.trim() ? `: ${args.note.trim()}` : ''}`)

    // Tutti i requisiti soddisfatti (Change Manager incluso)? → avanza a scheduled.
    // Una transizione fallita qui NON è tollerabile: l'utente vedrebbe
    // "approvato" con la change ferma per sempre in approval.
    if (await areAllApprovalsSatisfied(session, args.changeId, ctx.tenantId)) {
      const instanceId = await getInstanceId(session, args.changeId, ctx.tenantId)
      const res = await workflowEngine.transition(session, { instanceId, toStepName: 'scheduled', triggeredBy: ctx.userId ?? 'system', triggerType: 'manual', notes: 'Approvazioni complete' }, { userId: ctx.userId ?? 'system', entityData: {} })
      if (!res.success) {
        throw new GraphQLError(`Approvazioni complete ma la change non è avanzata a "scheduled": ${res.error ?? 'transizione fallita'}`, { extensions: { code: 'CONFLICT' } })
      }
      await afterEnterStep(session, args.changeId, ctx.tenantId, 'scheduled')
      await evaluateAutoTransitions(session, args.changeId, ctx, afterEnterStep)
    }
    return getChange(null, { id: args.changeId }, ctx)
  }, true)
}

export async function rejectChangeApproval(_: unknown, args: { changeId: string; teamId: string; note: string; reopenAll?: boolean; reopenTaskIds?: string[] }, ctx: GraphQLContext) {
  if (!args.note?.trim()) throw new GraphQLError('Il motivo del rifiuto è obbligatorio', { extensions: { code: 'BAD_USER_INPUT' } })
  const reopenAll = args.reopenAll ?? false
  const reopenIds = args.reopenTaskIds ?? []
  if (!reopenAll && reopenIds.length === 0) {
    throw new GraphQLError('Seleziona quali assessment riaprire (o scegli "tutti")', { extensions: { code: 'BAD_USER_INPUT' } })
  }
  return withSession(async (session) => {
    const { changeType, teamName } = await assertInApproval(session, args.changeId, args.teamId, ctx.tenantId)
    await assertEligible(session, args.teamId, ctx)
    const now = new Date().toISOString()

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
      SET c.aggregate_risk_score = null, c.approval_route = null, c.approval_status = null,
          c.priority = $priority, c.updated_at = $now
      WITH c
      OPTIONAL MATCH (c)-[:HAS_APPROVAL]->(a:ChangeApproval)
      DETACH DELETE a
    `, { changeId: args.changeId, tenantId: ctx.tenantId, all: reopenAll, ids: reopenIds, now, priority: deriveChangePriority(changeType, null) }))

    const instanceId = await getInstanceId(session, args.changeId, ctx.tenantId)
    const res = await workflowEngine.transition(session, { instanceId, toStepName: 'assessment', triggeredBy: ctx.userId ?? 'system', triggerType: 'manual', notes: `Approvazione rifiutata: ${args.note.trim()}` }, { userId: ctx.userId ?? 'system', entityData: {} })
    // Se fallisce, la change resta in approval con i task riaperti e senza
    // requisiti: il gate blocca l'approvazione e il rigetto è ripetibile.
    if (!res.success) throw new GraphQLError(res.error ?? 'Rigetto non riuscito', { extensions: { code: 'CONFLICT' } })
    await writeAudit(session, args.changeId, ctx.tenantId, 'change_rejected', ctx.userId, `${teamName}: ${args.note.trim()}`)
    await afterEnterStep(session, args.changeId, ctx.tenantId, 'assessment')
    return getChange(null, { id: args.changeId }, ctx)
  }, true)
}

/** Field resolver Change.approvals. */
export async function changeApprovals(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{
      kind: string; teamId: string | null; teamName: string | null
      status: string; approvedByName: string | null; approvedAt: string | null
      isMember: boolean
    }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_APPROVAL]->(a:ChangeApproval)
      OPTIONAL MATCH (team:Team {id: a.team_id, tenant_id: $tenantId})
      RETURN a.kind AS kind, a.team_id AS teamId, team.name AS teamName,
             a.status AS status, a.approved_by_name AS approvedByName, a.approved_at AS approvedAt,
             exists((:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(team)) AS isMember
      ORDER BY CASE a.kind WHEN 'change_manager' THEN 0 ELSE 1 END, team.name
    `, { changeId: parent.id, tenantId: ctx.tenantId, userId: ctx.userId })
    const isAdmin = ctx.role === 'admin'
    return rows.map((r) => ({
      kind:           r.kind,
      teamId:         r.teamId,
      teamName:       r.teamName,
      status:         r.status,
      approvedByName: r.approvedByName,
      approvedAt:     r.approvedAt,
      canApprove:     r.status === 'pending' && (isAdmin || r.isMember),
    }))
  })
}
