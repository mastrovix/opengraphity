/**
 * Approvazione multi-parte della Change (normal/emergency).
 *
 * Una change, entrando nello step "approval", richiede:
 *   - 1 approvazione del team "Change Manager" (team designato, is_change_manager)
 *   - 1 approvazione per ciascun OWNER GROUP distinto dei CI affected
 *
 * Ogni requisito è un nodo (c)-[:HAS_APPROVAL]->(:ChangeApproval {kind, team_id,
 * status}). Quando TUTTI sono 'approved' la change avanza automaticamente a
 * "scheduled". Un rifiuto riporta la change ad "assessment" e azzera i record.
 * Le change 'standard' sono pre-approvate: nessun record, nessun gate.
 */
import { GraphQLError } from 'graphql'
import { workflowEngine } from '@opengraphity/workflow'
import { withSession, runQuery, runQueryOne } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { logger } from '../../../lib/logger.js'
import { change as getChange } from './queries.js'
import { evaluateAutoTransitions } from './autoTransitions.js'
import { afterEnterStep, getInstanceId } from './helpers.js'

/** True quando l'utente può agire su un requisito del team: admin o membro. */
function eligibilityQuery(): string {
  return `exists((:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(:Team {id: $teamId}))`
}

async function assertEligible(session: Parameters<typeof runQuery>[0], teamId: string, ctx: GraphQLContext): Promise<void> {
  if (ctx.role === 'admin') return
  const row = await runQueryOne<{ ok: boolean }>(session, `RETURN ${eligibilityQuery()} AS ok`, { userId: ctx.userId, tenantId: ctx.tenantId, teamId })
  if (!row?.ok) throw new GraphQLError('Non sei autorizzato ad approvare per questo team', { extensions: { code: 'FORBIDDEN' } })
}

export async function approveChangeApproval(_: unknown, args: { changeId: string; teamId: string; note?: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    // La change deve essere nello step approval.
    const step = await runQueryOne<{ step: string }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi)-[:CURRENT_STEP]->(s:WorkflowStep)
      RETURN s.name AS step
    `, { changeId: args.changeId, tenantId: ctx.tenantId })
    if (step?.step !== 'approval') throw new GraphQLError('La change non è in fase di approvazione', { extensions: { code: 'BAD_USER_INPUT' } })
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

    // Tutte approvate? → avanza automaticamente a scheduled.
    const pending = await runQueryOne<{ n: number }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_APPROVAL]->(a:ChangeApproval)
      WHERE a.status <> 'approved'
      RETURN count(a) AS n
    `, { changeId: args.changeId, tenantId: ctx.tenantId })
    if (pending && Number(pending.n) === 0) {
      const instanceId = await getInstanceId(session, args.changeId, ctx.tenantId)
      const res = await workflowEngine.transition(session, { instanceId, toStepName: 'scheduled', triggeredBy: ctx.userId ?? 'system', triggerType: 'manual', notes: 'Approvazioni complete' }, { userId: ctx.userId ?? 'system', entityData: {} })
      if (res.success) {
        await afterEnterStep(session, args.changeId, ctx.tenantId, 'scheduled')
        await evaluateAutoTransitions(session, args.changeId, ctx, afterEnterStep)
      } else {
        logger.warn({ changeId: args.changeId, error: res.error }, '[approvalGate] approvazioni complete ma transizione a scheduled non riuscita')
      }
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
    const step = await runQueryOne<{ step: string }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi)-[:CURRENT_STEP]->(s:WorkflowStep)
      RETURN s.name AS step
    `, { changeId: args.changeId, tenantId: ctx.tenantId })
    if (step?.step !== 'approval') throw new GraphQLError('La change non è in fase di approvazione', { extensions: { code: 'BAD_USER_INPUT' } })
    await assertEligible(session, args.teamId, ctx)

    // 1) Riapri i task scelti della fase assessment (AssessmentTask +
    //    DeployPlanTask/planning) portandoli a in_progress e azzerando punteggi:
    //    così all_assessments_complete torna falso e la change resta in
    //    assessment finché non vengono ricompilati.
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_ASSESSMENT|HAS_DEPLOY_PLAN]->(t)
      WHERE $all OR t.id IN $ids
      SET t.status = 'in_progress', t.score = null, t.completed_at = null
      WITH c, t
      OPTIONAL MATCH (t)-[cb:COMPLETED_BY]->() DELETE cb
      WITH c, t
      OPTIONAL MATCH (c)-[r:AFFECTS_CI]->(ci {id: t.ci_id}) SET r.risk_score = null, r.ci_phase = 'assessment'
    `, { changeId: args.changeId, tenantId: ctx.tenantId, all: reopenAll, ids: reopenIds }))
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      SET c.aggregate_risk_score = null, c.approval_route = null, c.updated_at = $now
    `, { changeId: args.changeId, tenantId: ctx.tenantId, now: new Date().toISOString() }))

    // 2) Azzera i requisiti di approvazione e riporta la change ad assessment.
    await runQuery(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_APPROVAL]->(a:ChangeApproval)
      DETACH DELETE a
    `, { changeId: args.changeId, tenantId: ctx.tenantId })

    const instanceId = await getInstanceId(session, args.changeId, ctx.tenantId)
    const res = await workflowEngine.transition(session, { instanceId, toStepName: 'assessment', triggeredBy: ctx.userId ?? 'system', triggerType: 'manual', notes: `Approvazione rifiutata: ${args.note.trim()}` }, { userId: ctx.userId ?? 'system', entityData: {} })
    if (!res.success) throw new GraphQLError(res.error ?? 'Rigetto non riuscito', { extensions: { code: 'CONFLICT' } })
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
