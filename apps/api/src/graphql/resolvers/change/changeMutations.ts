/**
 * Mutations on the Change aggregate itself:
 *   createChange, addCIToChange, removeCIFromChange,
 *   executeChangeTransition, sendTaskReminder.
 */
import { GraphQLError } from 'graphql'
import { workflowEngine } from '@opengraphity/workflow'
import type { ActionContext } from '@opengraphity/workflow'
import { TASK_STATUS, ASSESSMENT_ROLE } from '../../../lib/taskStatus.js'
import { withSession, runQuery, runQueryOne, getSession, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { logger } from '../../../lib/logger.js'
import { requireRole } from '../../../lib/requireRole.js'
import { createChangeRFC } from '../../../services/changeCreationService.js'
import { change as getChange } from './queries.js'
import { evaluateAutoTransitions, revertProblemAfterChangeDetached } from './autoTransitions.js'
import { assertAllApprovalsSatisfied } from './approvalCreation.js'
import {
  writeAudit,
  getNextTaskCodes,
  assertCIHasOwnerAndSupport,
  assertInitialStep,
  getCIName,
  loadChangeWorkflow,
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
  // Solo admin: eliminare una change (anche logicamente) rimuove dai flussi
  // approvazioni, task e collegamenti di tutto il tenant.
  requireRole(ctx, 'admin')
  const now = new Date().toISOString()
  await withSession(async (session) => {
    // Unica transazione: marca la change, chiude l'istanza di workflow (così
    // nessuna transizione/approvazione è più possibile) e scrive l'audit.
    const r = await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      WHERE coalesce(c.deleted, false) = false
      SET c.deleted = true, c.deleted_at = $now, c.deleted_by = $userId, c.updated_at = $now
      WITH c
      OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      SET wi.status = 'cancelled', wi.updated_at = $now
      WITH c
      CREATE (c)-[:HAS_AUDIT]->(e:ChangeAuditEntry {
        id: randomUUID(), tenant_id: $tenantId, timestamp: $now,
        action: 'change_deleted', detail: 'Eliminazione logica'
      })
      WITH c, e
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END | CREATE (e)-[:BY]->(u))
      RETURN c.id AS id
    `, { id: args.id, tenantId: ctx.tenantId, now, userId: ctx.userId ?? null }))
    if (r.records.length === 0) throw new GraphQLError('Change non trovata o già eliminata', { extensions: { code: 'NOT_FOUND' } })
  }, true)
  // I timer di breach OLA/UC schedulati alla creazione non devono più
  // notificare per una change eliminata. Cleanup post-commit: un errore qui
  // non annulla l'eliminazione ma viene registrato ad alta severità.
  try {
    // Import dinamico: il modulo sla apre la connessione BullMQ/Neo4j al
    // caricamento, non deve pesare su chi importa le mutation.
    const { getActiveOLAContractsFor, cancelOLABreaches } = await import('@opengraphity/sla')
    const contracts = await getActiveOLAContractsFor(ctx.tenantId, 'change')
    if (contracts.length > 0) await cancelOLABreaches(args.id, contracts.map((c) => c.id))
  } catch (err) {
    logger.error({ err, changeId: args.id }, '[deleteChange] cancellazione job OLA non riuscita')
  }
  // I problem che dipendevano da questa change tornano in analisi.
  const problemIds = await withSession((session) => runQuery<{ id: string }>(session, `
    MATCH (p:Problem {tenant_id: $tenantId})-[:RESOLVED_BY]->(c:Change {id: $id, tenant_id: $tenantId})
    RETURN p.id AS id
  `, { id: args.id, tenantId: ctx.tenantId }))
  if (problemIds.length > 0) {
    const session = getSession(undefined, 'WRITE')
    try {
      for (const { id } of problemIds) await revertProblemAfterChangeDetached(session, id, ctx)
    } finally {
      await session.close()
    }
  }
  return true
}

/** Collega/scollega un ticket (incident|problem) alla change (RESOLVED_BY). */
export async function linkResolvedTicket(_: unknown, args: { changeId: string; entityType: string; entityId: string }, ctx: GraphQLContext) {
  const label = args.entityType === 'incident' ? 'Incident' : args.entityType === 'problem' ? 'Problem' : null
  if (!label) throw new GraphQLError(`Tipo ticket non valido: ${args.entityType}`, { extensions: { code: 'BAD_USER_INPUT' } })
  await withSession(async (session) => {
    const r = await session.executeWrite((tx) => tx.run(`
      MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      WHERE coalesce(c.deleted, false) = false
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
  // Se il ticket è un problem che era avanzato grazie a questa change, torna in analisi.
  if (label === 'Problem') {
    const session = getSession(undefined, 'WRITE')
    try {
      await revertProblemAfterChangeDetached(session, args.entityId, ctx)
    } finally {
      await session.close()
    }
  }
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
    // Una sola lettura coerente: change non eliminata + istanza + step corrente
    // (dalla relazione CURRENT_STEP, verificata contro wi.current_step).
    const { instanceId, currentStep, props: entityProps } = await loadChangeWorkflow(session, args.changeId, ctx.tenantId)
    const changeType = (entityProps['change_type'] as string) ?? 'normal'

    // ── Gate di approvazione ──────────────────────────────────────────────────
    // Uscire da `approval` verso avanti significa approvare la change: oltre
    // al ruolo admin, TUTTI i requisiti multi-parte (Change Manager + owner
    // group) devono essere 'approved' — lo stesso gate dell'auto-advance.
    // Il rigetto (approval → assessment) deve passare da rejectChangeApproval,
    // che riapre i task: una transizione "nuda" lascerebbe gli assessment
    // completi e la change rimbalzerebbe subito in approval.
    if (currentStep === 'approval' && args.toStep !== 'approval') {
      if (args.toStep === 'assessment') {
        throw new GraphQLError('Per rigettare usa "Rigetta" nella sezione Approvazione (rejectChangeApproval), che riapre gli assessment', { extensions: { code: 'CONFLICT' } })
      }
      if (changeType !== 'standard') {
        requireRole(ctx, 'admin')
        await assertAllApprovalsSatisfied(session, args.changeId, ctx.tenantId)
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
      tenantId:    ctx.tenantId,
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

    // Le azioni di step fallite dopo il commit (SLA, eventi, timer) non vanno
    // perse: esposte al client come Change.actionErrors (solo su questa mutation).
    const changed = await getChange(null, { id: args.changeId }, ctx)
    return changed ? { ...changed, actionErrors: result.actionErrors?.length ? result.actionErrors : null } : null
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
