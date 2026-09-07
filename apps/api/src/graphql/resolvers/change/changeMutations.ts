/**
 * Mutations on the Change aggregate itself:
 *   createChange, addCIToChange, removeCIFromChange,
 *   executeChangeTransition, sendTaskReminder.
 */
import { GraphQLError } from 'graphql'
import { workflowEngine } from '@opengraphity/workflow'
import type { ActionContext } from '@opengraphity/workflow'
import { TASK_STATUS, ASSESSMENT_ROLE } from '../../../lib/taskStatus.js'
import { withSession, runQueryOne, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { logger } from '../../../lib/logger.js'
import { requireRole } from '../../../lib/requireRole.js'
import { createChangeRFC } from '../../../services/changeCreationService.js'
import { change as getChange } from './queries.js'
import { evaluateAutoTransitions } from './autoTransitions.js'
import {
  writeAudit,
  getNextTaskCodes,
  assertCIHasOwnerAndSupport,
  assertInitialStep,
  getCIName,
  getInstanceId,
  loadChange,
  afterEnterStep,
} from './helpers.js'

// ── createChange ───────────────────────────────────────────────────────────────

export async function createChange(
  _: unknown,
  args: { input: { title: string; why: string; what: string; changeOwner?: string | null; affectedCIIds: string[]; changeType?: string | null; problemId?: string | null; incidentId?: string | null } },
  ctx: GraphQLContext,
) {
  // Thin wrapper: the whole RFC bootstrap (validation, CHG code, tasks,
  // workflow instance, audit) lives in the shared changeCreationService,
  // reused by the REST v1 route.
  const { id, code } = await createChangeRFC(args.input, { tenantId: ctx.tenantId, userId: ctx.userId })
  // RFC risolutiva di un problem: collega la change e fa avanzare il problem a
  // "change_requested" (la guardia has_linked_change è ora soddisfatta).
  if (args.input.problemId) {
    await linkChangeToRequestingProblem(args.input.problemId, id, code, ctx)
  }
  // RFC risolutiva di un incident: solo collegamento (l'incident non ha uno step
  // "change_requested"). Si risolverà quando la change arriva a "closed".
  if (args.input.incidentId) {
    await linkChangeToRequestingIncident(args.input.incidentId, id, ctx)
  }
  return getChange(null, { id }, ctx)
}

// ── deleteChange (cancellazione logica) ─────────────────────────────────────────
// Marca la change come deleted: sparisce dagli elenchi e dai ticket collegati.
// È l'unico modo per rimuovere i collegamenti RESOLVED_BY creati automaticamente.
export async function deleteChange(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const now = new Date().toISOString()
  return withSession(async (session) => {
    const r = await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      SET c.deleted = true, c.deleted_at = $now, c.updated_at = $now
      RETURN c.id AS id
    `, { id: args.id, tenantId: ctx.tenantId, now }))
    if (r.records.length === 0) throw new GraphQLError('Change non trovata', { extensions: { code: 'NOT_FOUND' } })
    return true
  }, true)
}

/** Collega/scollega un ticket (incident|problem) alla change (RESOLVED_BY). */
export async function linkResolvedTicket(_: unknown, args: { changeId: string; entityType: string; entityId: string }, ctx: GraphQLContext) {
  const label = args.entityType === 'incident' ? 'Incident' : args.entityType === 'problem' ? 'Problem' : null
  if (!label) throw new GraphQLError(`Tipo ticket non valido: ${args.entityType}`, { extensions: { code: 'BAD_USER_INPUT' } })
  await withSession(async (session) => {
    const r = await session.executeWrite((tx) => tx.run(`
      MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      MERGE (e)-[:RESOLVED_BY]->(c)
      SET e.updated_at = $now
      RETURN c.id AS id
    `, { changeId: args.changeId, entityId: args.entityId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    if (r.records.length === 0) throw new GraphQLError('Change o ticket non trovato', { extensions: { code: 'NOT_FOUND' } })
  }, true)
  return getChange(null, { id: args.changeId }, ctx)
}

export async function unlinkResolvedTicket(_: unknown, args: { changeId: string; entityType: string; entityId: string }, ctx: GraphQLContext) {
  const label = args.entityType === 'incident' ? 'Incident' : args.entityType === 'problem' ? 'Problem' : null
  if (!label) throw new GraphQLError(`Tipo ticket non valido: ${args.entityType}`, { extensions: { code: 'BAD_USER_INPUT' } })
  await withSession(async (session) => {
    const r = await session.executeWrite((tx) => tx.run(`
      MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})-[r:RESOLVED_BY]->(c:Change {id: $changeId, tenant_id: $tenantId})
      RETURN coalesce(r.auto, false) AS auto
    `, { changeId: args.changeId, entityId: args.entityId, tenantId: ctx.tenantId }))
    if (r.records.length === 0) throw new GraphQLError('Change o ticket non trovato', { extensions: { code: 'NOT_FOUND' } })
    if (r.records[0].get('auto') === true) {
      throw new GraphQLError('Questo collegamento è stato creato automaticamente e non può essere rimosso. Elimina la change per rimuoverlo.', { extensions: { code: 'FORBIDDEN' } })
    }
    await session.executeWrite((tx) => tx.run(`
      MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})-[r:RESOLVED_BY]->(c:Change {id: $changeId, tenant_id: $tenantId})
      DELETE r
    `, { changeId: args.changeId, entityId: args.entityId, tenantId: ctx.tenantId }))
  }, true)
  return getChange(null, { id: args.changeId }, ctx)
}

/** Collega la nuova change all'incident richiedente (nessuna transizione). */
async function linkChangeToRequestingIncident(
  incidentId: string,
  changeId: string,
  ctx: GraphQLContext,
) {
  await withSession(async (session) => {
    const linked = await session.executeWrite((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
        MATCH (c:Change   {id: $changeId,   tenant_id: $tenantId})
        MERGE (i)-[rel:RESOLVED_BY]->(c)
        SET rel.auto = true, i.updated_at = $now
        RETURN i.id AS id
      `, { incidentId, changeId, tenantId: ctx.tenantId, now: new Date().toISOString() }),
    )
    if (linked.records.length === 0) {
      throw new GraphQLError('Incident non trovato per il collegamento della change', { extensions: { code: 'NOT_FOUND' } })
    }
  }, true)
}

/** Collega la nuova change al problem richiedente e ne avanza il workflow. */
async function linkChangeToRequestingProblem(
  problemId: string,
  changeId: string,
  changeCode: string,
  ctx: GraphQLContext,
) {
  await withSession(async (session) => {
    const now = new Date().toISOString()
    // 1. Collega: (problem)-[:RESOLVED_BY]->(change). Fallisce se il problem non
    // esiste (nessun collegamento silenzioso a un id inesistente).
    const linked = await session.executeWrite((tx) =>
      tx.run(`
        MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})
        MATCH (c:Change  {id: $changeId,  tenant_id: $tenantId})
        MERGE (p)-[rel:RESOLVED_BY]->(c)
        SET rel.auto = true, p.updated_at = $now
        RETURN p.id AS id
      `, { problemId, changeId, tenantId: ctx.tenantId, now }),
    )
    if (linked.records.length === 0) {
      throw new GraphQLError('Problem non trovato per il collegamento della change', { extensions: { code: 'NOT_FOUND' } })
    }
    // 2. Avanza il problem a change_requested, se la transizione è disponibile
    // dallo step corrente (lo è da under_investigation e known_error).
    const wi = await session.executeRead((tx) =>
      tx.run(`MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(w:WorkflowInstance) RETURN w.id AS id`, { problemId, tenantId: ctx.tenantId }),
    )
    const instanceId = wi.records[0]?.get('id') as string | undefined
    if (!instanceId) return
    const avail = await workflowEngine.getAvailableTransitions(session, instanceId)
    if (!avail.some((t) => t.toStep === 'change_requested')) return
    const res = await workflowEngine.transition(
      session,
      { instanceId, toStepName: 'change_requested', triggeredBy: ctx.userId, triggerType: 'manual', notes: `RFC ${changeCode} creata` },
      { userId: ctx.userId, entityData: {} } as ActionContext,
    )
    if (!res.success) {
      logger.warn({ problemId, changeId, error: res.error }, '[createChange] problem collegato ma transizione a change_requested non riuscita')
    }
  }, true)
}

// ── addCIToChange / removeCIFromChange ────────────────────────────────────────

// TRANSACTIONAL: all writes in single tx — relazione AFFECTS_CI + 2 AssessmentTask
// + DeployPlanTask + ASSIGNED_TO_TEAM + audit entry committano o rollbackano insieme.
// Le validazioni (step iniziale, owner/support del CI) e le letture (task codes,
// nome CI) restano PRIMA della transazione.
export async function addCIToChange(_: unknown, args: { changeId: string; ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    await assertInitialStep(session, args.changeId, ctx.tenantId)
    await assertCIHasOwnerAndSupport(session, ctx.tenantId, [args.ciId])
    const [ownerCode, supportCode, planCode] = await getNextTaskCodes(session, ctx.tenantId, 3)
    const ciName = await getCIName(session, args.ciId, ctx.tenantId)
    const now = new Date().toISOString()
    await session.executeWrite(async (tx) => {
      await tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      MATCH (ci)-[:OWNED_BY]->(ownerTeam:Team)
      MATCH (ci)-[:SUPPORTED_BY]->(supportTeam:Team)
      MERGE (c)-[r_aci:AFFECTS_CI]->(ci)
      ON CREATE SET r_aci.ci_phase = 'assessment'
      MERGE (ownerT:AssessmentTask {change_key: $changeId + '-' + $ciId + '-owner'})
        ON CREATE SET ownerT.id = randomUUID(), ownerT.code = $ownerCode, ownerT.tenant_id = $tenantId,
          ownerT.ci_id = $ciId, ownerT.responder_role = '${ASSESSMENT_ROLE.OWNER}',
          ownerT.status = '${TASK_STATUS.PENDING}', ownerT.score = null, ownerT.created_at = $now
      MERGE (c)-[:HAS_ASSESSMENT]->(ownerT)
      MERGE (ownerT)-[:ASSIGNED_TO_TEAM]->(ownerTeam)
      MERGE (supportT:AssessmentTask {change_key: $changeId + '-' + $ciId + '-support'})
        ON CREATE SET supportT.id = randomUUID(), supportT.code = $supportCode, supportT.tenant_id = $tenantId,
          supportT.ci_id = $ciId, supportT.responder_role = '${ASSESSMENT_ROLE.SUPPORT}',
          supportT.status = '${TASK_STATUS.PENDING}', supportT.score = null, supportT.created_at = $now
      MERGE (c)-[:HAS_ASSESSMENT]->(supportT)
      MERGE (supportT)-[:ASSIGNED_TO_TEAM]->(supportTeam)
      MERGE (dp:DeployPlanTask {change_key: $changeId + '-' + $ciId + '-deployplan'})
        ON CREATE SET dp.id = randomUUID(), dp.code = $planCode, dp.tenant_id = $tenantId,
          dp.ci_id = $ciId, dp.status = '${TASK_STATUS.PENDING}',
          dp.steps = '[]',
          dp.created_at = $now
      MERGE (c)-[:HAS_DEPLOY_PLAN]->(dp)
      MERGE (dp)-[:ASSIGNED_TO_TEAM]->(supportTeam)
      SET c.updated_at = $now
      `, { changeId: args.changeId, ciId: args.ciId, tenantId: ctx.tenantId, now,
           ownerCode, supportCode, planCode })

      await writeAudit(tx, args.changeId, ctx.tenantId, 'ci_added', ctx.userId, `CI ${ciName} aggiunto`)
    })

    const row = await runQueryOne<{ ciProps: Props; ciLabel: string }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->(ci {id: $ciId})
      RETURN properties(ci) AS ciProps, labels(ci)[0] AS ciLabel
    `, { changeId: args.changeId, ciId: args.ciId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('CI non trovato dopo aggiunta', { extensions: { code: 'INTERNAL_SERVER_ERROR' } })
    row.ciProps['type'] = row.ciProps['type'] as string | undefined ?? row.ciLabel.toLowerCase()
    const { mapCI } = await import('../ci-utils.js')
    return {
      ci: mapCI(row.ciProps),
      ciPhase: 'assessment',
      riskScore: null,
      assessmentOwner: null,
      assessmentSupport: null,
      validation: null,
      deployment: null,
      review: null,
    }
  }, true)
}

// TRANSACTIONAL: all writes in single tx — DELETE della relazione AFFECTS_CI,
// DETACH DELETE dei task collegati (assessment + risposte + deploy plan) e
// audit entry committano o rollbackano insieme. Le letture (step iniziale,
// nome CI) restano PRIMA della transazione.
export async function removeCIFromChange(_: unknown, args: { changeId: string; ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    await assertInitialStep(session, args.changeId, ctx.tenantId)
    const ciName = await getCIName(session, args.ciId, ctx.tenantId)
    await session.executeWrite(async (tx) => {
      await tx.run(`
        MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->(ci {id: $ciId})
        DELETE r
        WITH c
        OPTIONAL MATCH (c)-[:HAS_ASSESSMENT]->(t:AssessmentTask {ci_id: $ciId})
        OPTIONAL MATCH (t)-[:HAS_RESPONSE]->(resp:AssessmentResponse)
        OPTIONAL MATCH (c)-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask {ci_id: $ciId})
        DETACH DELETE resp, t, dp
        SET c.updated_at = $now
      `, { changeId: args.changeId, ciId: args.ciId, tenantId: ctx.tenantId, now: new Date().toISOString() })

      await writeAudit(tx, args.changeId, ctx.tenantId, 'ci_removed', ctx.userId, `CI ${ciName} rimosso`)
    })
    return true
  }, true)
}

// ── executeChangeTransition ───────────────────────────────────────────────────

export async function executeChangeTransition(
  _: unknown,
  args: { changeId: string; toStep: string; notes?: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const instanceId = await getInstanceId(session, args.changeId, ctx.tenantId)
    const entityProps = await loadChange(session, args.changeId, ctx.tenantId) ?? {}

    // ── Current step (for the approval gate) ──────────────────────────────────
    const stepRow = await runQueryOne<{ step: string }>(session,
      'MATCH (wi:WorkflowInstance {id: $instanceId})-[:CURRENT_STEP]->(s:WorkflowStep) RETURN s.name AS step',
      { instanceId })
    const currentStep = stepRow?.step ?? null
    const changeType = (entityProps['change_type'] as string) ?? 'normal'

    // ── CAB role gate: authorization rigor depends on the change type ─────────
    // Leaving the `approval` step means the change is being approved.
    if (currentStep === 'approval' && args.toStep !== 'approval') {
      // standard = pre-approved (no gate); normal → Change Manager (admin);
      // emergency → ECAB (admin). The token role model is admin/operator/
      // viewer/end_user, so the CAB gate is the admin role.
      if (changeType !== 'standard') {
        requireRole(ctx, 'admin')
      }
    }

    // Il rollback non è più un campo del change: è valutato (con punteggio)
    // nell'assessment tecnico ("Is a tested rollback plan available?"), che si
    // completa prima del deploy. Nessun gate sul testo qui.

    const actionCtx: ActionContext = {
      userId:     ctx.userId ?? 'system',
      notes:      args.notes,
      entityData: entityProps,
    }
    const result = await workflowEngine.transition(session, {
      instanceId,
      toStepName:  args.toStep,
      triggeredBy: ctx.userId ?? 'system',
      triggerType: 'manual',
      notes:       args.notes,
    }, actionCtx)
    if (!result.success) throw new GraphQLError(result.error ?? 'Transizione fallita', { extensions: { code: 'CONFLICT' } })
    if (result.actionErrors?.length) {
      logger.error({ changeId: args.changeId, actionErrors: result.actionErrors },
        '[change] transition persisted but step actions failed')
    }

    await afterEnterStep(session, args.changeId, ctx.tenantId, args.toStep)
    await writeAudit(session, args.changeId, ctx.tenantId,
      `change_transition_${args.toStep}`, ctx.userId, args.notes ?? null)

    await evaluateAutoTransitions(session, args.changeId, ctx, afterEnterStep)

    return getChange(null, { id: args.changeId }, ctx)
  }, true)
}

// ── Task Reminders ────────────────────────────────────────────────────────────

export async function sendTaskReminder(_: unknown, args: { taskId: string; userId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      CREATE (n:Notification {
        id: randomUUID(), tenant_id: $tenantId,
        type: 'task_reminder', task_id: $taskId,
        message: 'Hai un task in attesa di completamento',
        read: false, created_at: $now
      })
      CREATE (n)-[:FOR_USER]->(u)
    `, { userId: args.userId, taskId: args.taskId, tenantId: ctx.tenantId, now }))
    logger.info({ taskId: args.taskId, targetUser: args.userId, sender: ctx.userId }, '[sendTaskReminder] notification sent')
    return true
  }, true)
}
