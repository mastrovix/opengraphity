/**
 * Mutations on the Change aggregate itself:
 *   createChange, addCIToChange, removeCIFromChange,
 *   executeChangeTransition, sendTaskReminder.
 */
import { GraphQLError } from 'graphql'
import { systemText } from '../../../lib/systemText.js'
import { workflowEngine } from '@opengraphity/workflow'
import type { ActionContext } from '@opengraphity/workflow'
import { TASK_STATUS, ASSESSMENT_ROLE } from '../../../lib/taskStatus.js'
import { withSession, runQuery, runQueryOne, getSession, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { logger } from '../../../lib/logger.js'
import { requireRole } from '../../../lib/requireRole.js'
import { validateRequiredFields, propsToFieldValues } from '../../../lib/validateRequiredFields.js'
import { stepNamesByPurposeOrdered } from '../../../lib/workflowTargets.js'
import { createChangeRFC } from '../../../services/changeCreationService.js'
import { change as getChange } from './queries.js'
import { evaluateAutoTransitions, revertProblemAfterChangeDetached } from './autoTransitions.js'
import { assertChangeWindowGate } from './windowGate.js'
import { transitionFailed } from '../../../lib/transitionError.js'
import { TASK_KINDS } from './taskKinds.js'
import { NotFoundError } from '../../../lib/errors.js'
import { publishEvent } from '../../../lib/publishEvent.js'
import { audit } from '../../../lib/audit.js'
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
        action: 'change_deleted', detail: 'Soft deletion', detail_key: 'softDeleted', detail_params: '{}'
      })
      WITH c, e
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END | CREATE (e)-[:BY]->(u))
      RETURN c.id AS id
    `, { id: args.id, tenantId: ctx.tenantId, now, userId: ctx.userId ?? null }))
    if (r.records.length === 0) throw new GraphQLError('Change not found, or already deleted', { extensions: { code: 'NOT_FOUND', i18n: { key: 'errors.change.notFoundOrDeleted' } } })
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
  // Gli eventi di monitoraggio silenziati dalla finestra di questa change
  // (Event.suppressed_by_change_id) vanno rivalutati (T-2): la change non
  // esiste più, `Event.suppressedBy` tornerebbe null lasciando l'evento
  // `suppressed` senza dire da chi.
  // Revisione 2 · B2-05: la rivalutazione ACCODA il job `reevaluate-change-window`
  // (come le transizioni in autoTransitions.ts) invece di girare in linea: ogni
  // evento costa una pipeline intera (lock di gruppo compreso) e una change con
  // 300 allarmi silenziati teneva la mutation per minuti — il client andava in
  // timeout e la ripeteva. L'accodamento NON è protetto da try/catch: è locale
  // a Redis e se fallisce deve propagare come ogni altro errore (fail-loud, come
  // documentato nel worker); l'esecuzione, lunga e ritentabile, sta nel job e la
  // passata periodica reevaluateClosedWindows resta la rete di sicurezza.
  // `stepEpoch` = istante dell'eliminazione: un job per eliminazione.
  {
    const { enqueueChangeWindowReevaluation } = await import('../../../jobs/eventCorrelateWorker.js')
    await enqueueChangeWindowReevaluation(ctx.tenantId, args.id, Date.now())
  }
  // Servizi monitorati (revisione 2 · D6.1): la finestra di questa change
  // sparisce con lei, quindi i componenti che «pesavano zero» tornano a pesare.
  // Post-commit e senza mai lanciare: la passata periodica è la rete di
  // sicurezza. Le AFFECTS_CI restano (la cancellazione è logica): si leggono
  // ancora.
  {
    const { notifyChangeWindowChanged } = await import('../../../services/serviceImpact/sync.js')
    await notifyChangeWindowChanged(ctx.tenantId, args.id, 'change.deleted')
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
  if (!label) throw new GraphQLError(`Invalid ticket type: ${args.entityType}`, { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.change.badTicketType', params: { entityType: args.entityType } } } })
  await withSession(async (session) => {
    const r = await session.executeWrite((tx) => tx.run(`
      MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      WHERE coalesce(c.deleted, false) = false
      MERGE (e)-[:RESOLVED_BY]->(c)
      SET e.updated_at = $now
      RETURN c.id AS id
    `, { changeId: args.changeId, entityId: args.entityId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    if (r.records.length === 0) throw new GraphQLError('Change or ticket not found', { extensions: { code: 'NOT_FOUND', i18n: { key: 'errors.change.changeOrTicketNotFound' } } })
  }, true)
  return getChange(null, { id: args.changeId }, ctx)
}

export async function unlinkResolvedTicket(_: unknown, args: { changeId: string; entityType: string; entityId: string }, ctx: GraphQLContext) {
  const label = args.entityType === 'incident' ? 'Incident' : args.entityType === 'problem' ? 'Problem' : null
  if (!label) throw new GraphQLError(`Invalid ticket type: ${args.entityType}`, { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.change.badTicketType', params: { entityType: args.entityType } } } })
  await withSession(async (session) => {
    const r = await session.executeWrite((tx) => tx.run(`
      MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})-[r:RESOLVED_BY]->(c:Change {id: $changeId, tenant_id: $tenantId})
      RETURN coalesce(r.auto, false) AS auto
    `, { changeId: args.changeId, entityId: args.entityId, tenantId: ctx.tenantId }))
    if (r.records.length === 0) throw new GraphQLError('Change or ticket not found', { extensions: { code: 'NOT_FOUND', i18n: { key: 'errors.change.changeOrTicketNotFound' } } })
    if (r.records[0].get('auto') === true) {
      throw new GraphQLError('This link was created automatically and cannot be removed. Delete the change to remove it.', { extensions: { code: 'FORBIDDEN', i18n: { key: 'errors.change.automaticLink' } } })
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
      throw new GraphQLError('Incident not found for the change link', { extensions: { code: 'NOT_FOUND', i18n: { key: 'errors.change.linkIncidentNotFound' } } })
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
      throw new GraphQLError('Problem not found for the change link', { extensions: { code: 'NOT_FOUND', i18n: { key: 'errors.change.linkProblemNotFound' } } })
    }
    // 2. Avanza il problem al passo di SCOPO `change_requested` (ondata 4 ·
    // A4-2: lo scopo, non il nome), se la transizione è disponibile dallo step
    // corrente (di fabbrica lo è da under_investigation e known_error).
    const wi = await session.executeRead((tx) =>
      tx.run(`MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(w:WorkflowInstance) RETURN w.id AS id`, { problemId, tenantId: ctx.tenantId }),
    )
    const instanceId = wi.records[0]?.get('id') as string | undefined
    if (!instanceId) return
    const avail = await workflowEngine.getAvailableTransitions(session, instanceId)
    const candidates = await stepNamesByPurposeOrdered(session, ctx.tenantId, 'problem', ['change_requested'])
    const toStep = candidates.find((n) => avail.some((t) => t.toStep === n))
    if (!toStep) {
      // Non è un errore (il problem può essere in un passo da cui quella
      // transizione non parte), ma non è più muto: prima un `return` secco
      // nascondeva anche il caso «nessun passo dichiara lo scopo».
      logger.warn({ problemId, changeId, candidates, available: avail.map((t) => t.toStep) },
        '[createChange] problem collegato ma nessun passo di scopo change_requested è raggiungibile: il problem resta dov\'è')
      return
    }
    const res = await workflowEngine.transition(
      session,
      { instanceId, toStepName: toStep, triggeredBy: ctx.userId, triggerType: 'manual', notes: await systemText(ctx.tenantId, 'change.rfcCreated', { code: changeCode }) },
      { userId: ctx.userId, entityData: {} } as ActionContext,
    )
    if (!res.success) {
      logger.warn({ problemId, changeId, toStep, error: res.error }, '[createChange] problem collegato ma transizione al passo di scopo change_requested non riuscita')
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

      await writeAudit(tx, args.changeId, ctx.tenantId, 'ci_added', ctx.userId, `CI ${ciName} added`, { key: 'ciAdded', params: { ci: ciName } })
    })

    const row = await runQueryOne<{ ciProps: Props; ciLabel: string }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->(ci {id: $ciId})
      RETURN properties(ci) AS ciProps, head([l IN labels(ci) WHERE l <> 'ConfigurationItem']) AS ciLabel
    `, { changeId: args.changeId, ciId: args.ciId, tenantId: ctx.tenantId })
    if (!row) throw new GraphQLError('CI not found after being added', { extensions: { code: 'INTERNAL_SERVER_ERROR' } })
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

      await writeAudit(tx, args.changeId, ctx.tenantId, 'ci_removed', ctx.userId, `CI ${ciName} removed`, { key: 'ciRemoved', params: { ci: ciName } })
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
    // Il varco della finestra di rilascio vive in `windowGate.ts`, non qui.
    // Terza revisione * C1: stava scritto qui dentro, e il suo commento
    // affermava di valere «da qualunque passo arrivi e qualunque scopo abbia
    // quel passo» — mentre valeva per questo cammino e non per i due
    // automatici (`evaluateAutoTransitions`, job `timer_wait`), dove le cinque
    // guardie avevano ZERO occorrenze. Ora la regola di dominio sta in un
    // posto solo e i tre cammini la chiamano; il lint
    // `__tests__/changeWindowGate.test.ts` pretende che resti cosi.
    await assertChangeWindowGate(session, ctx, {
      tenantId: ctx.tenantId, changeId: args.changeId, changeType,
      currentStep, toStep: args.toStep,
    })

    // Campi obbligatori del passo di ARRIVO (ondata 8 · B-21). Le regole
    // `FieldRequirementRule` con `workflow_step` erano valutate solo da
    // `executeWorkflowTransition` (la mutation generica, che le change non
    // usano): una regola «la data di rilascio è obbligatoria entrando in
    // programmata» valeva per un bottone e non per quello delle change, e chi
    // l'aveva configurata non poteva accorgersene. Le note della transizione
    // contano come valore, come nella mutation generica.
    const requirementValues: Record<string, unknown> = { ...propsToFieldValues(entityProps) }
    if (args.notes) {
      requirementValues['resolution_notes'] = args.notes
      requirementValues['root_cause']       = args.notes
    }
    await validateRequiredFields(session, {
      entityType:  'change',
      fieldValues: requirementValues,
      tenantId:    ctx.tenantId,
      toStep:      args.toStep,
    })

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
    if (!result.success) throw transitionFailed(result, 'Transition failed')
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

/**
 * «Invia promemoria» a chi deve completare un task della change — revisione
 * del 14 set 2026 · CH-13.
 *
 * Prima scriveva un nodo `:Notification` che nessuna query leggeva e nessun
 * pannello mostrava: il pulsante confermava un invio che non avveniva. Ora il
 * task e il destinatario si verificano nel tenant, e il promemoria arriva come
 * notifica in-app all'utente (evento `change.task_reminder`, consegnato dal
 * dispatcher delle notifiche).
 */
export async function sendTaskReminder(_: unknown, args: { taskId: string; userId: string }, ctx: GraphQLContext) {
  const labels = Object.values(TASK_KINDS).map((k) => k.label)
  const row = await withSession((session) => runQueryOne<{ changeId: string; code: string | null; title: string | null; userName: string | null }>(session, `
    MATCH (c:Change {tenant_id: $tenantId})-[]->(t {id: $taskId, tenant_id: $tenantId})
    WHERE coalesce(c.deleted, false) = false AND any(l IN labels(t) WHERE l IN $labels)
    MATCH (u:User {id: $userId, tenant_id: $tenantId})
    RETURN c.id AS changeId, c.code AS code, c.title AS title, u.name AS userName
    LIMIT 1
  `, { taskId: args.taskId, userId: args.userId, tenantId: ctx.tenantId, labels }))
  if (!row) throw new NotFoundError('Task or user', `${args.taskId} / ${args.userId}`)
  await publishEvent('change.task_reminder', ctx.tenantId, ctx.userId, {
    id: row.changeId, entity_type: 'change', entity_id: row.changeId, task_id: args.taskId,
    recipient_user_id: args.userId, code: row.code, title: row.title,
  })
  void audit(ctx, 'change.task_reminder_sent', 'Change', row.changeId, { taskId: args.taskId, recipient: args.userId })
  return true
}
