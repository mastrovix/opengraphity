import { GraphQLError } from 'graphql'
import { workflowEngine } from '@opengraphity/workflow'
import type { ActionContext, ConditionContext } from '@opengraphity/workflow'
import type { Session as NeoSession } from 'neo4j-driver'
import { toNumber } from '@opengraphity/neo4j'
import { runQuery, runQueryOne, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { logger } from '../../../lib/logger.js'
// Side-effect: registra le condizioni ITSM (all_assessments_complete, …)
// sull'engine. Il walker le valuta dal registro, come fa l'engine stesso.
import '../../../workflow/conditions.js'

type Session2 = Parameters<typeof runQuery>[0]
export type AfterEnterStep = (session: Session2, changeId: string, tenantId: string, stepName: string) => Promise<void>

// Strict driver Session: evaluateAutoTransitions apre transazioni proprie
// (workflowEngine.transition) e non può girare dentro una tx esterna.
type Session = NeoSession

/**
 * After a domain mutation that may satisfy an automatic transition,
 * walk the workflow forward as far as the current step's automatic
 * conditions allow. Each iteration: read the current step, load its
 * outgoing automatic transitions, evaluate their condition, fire the
 * first that passes. Stops when no automatic transition is available
 * or no condition holds.
 */
export async function evaluateAutoTransitions(
  session: Session,
  changeId: string,
  ctx: GraphQLContext,
  afterEnterStep?: AfterEnterStep,
): Promise<void> {
  await walkAutoTransitions(session, changeId, ctx, afterEnterStep)
  // Dopo aver fatto avanzare la change, allinea le entità che essa risolve.
  await syncLinkedProblems(session, changeId, ctx)
  await syncLinkedIncidents(session, changeId, ctx)
  await syncSuppressedEvents(session, changeId, ctx)
}

/**
 * Fine finestra di change (Event Management, ondata 3 + revisione): se la
 * change non è più in un passo "di finestra" (deployment / scheduled) e ha
 * ancora allarmi silenziati, la mutation ACCODA il job
 * `reevaluate-change-window` (coda events-correlate, id deterministico per
 * tenant/change/epoca del passo) e torna: la rivalutazione — lunga e
 * ritentabile — gira nel job, non in linea nella mutation (che non deve né
 * aspettare minuti né fallire dopo che la transizione è già persistita).
 * L'accodamento NON è protetto da try/catch: è locale a Redis e se fallisce
 * deve propagare come ogni altro errore. Import dinamico: il modulo del
 * worker trascina la pipeline, inutile alle mutation senza eventi soppressi.
 */
async function syncSuppressedEvents(
  session: Session,
  changeId: string,
  ctx: GraphQLContext,
): Promise<void> {
  const row = await runQueryOne<{ step: string; enteredAt: string | null; suppressed: unknown }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
    OPTIONAL MATCH (e:Event {tenant_id: $tenantId, status: 'suppressed', suppressed_by_change_id: c.id})
    RETURN wi.current_step AS step, wi.updated_at AS enteredAt, count(e) AS suppressed
  `, { changeId, tenantId: ctx.tenantId })
  if (!row || toNumber(row.suppressed) === 0) return
  const { CHANGE_WINDOW_STEPS } = await import('../../../services/eventCorrelation.js')
  if (CHANGE_WINDOW_STEPS.includes(row.step)) return
  const { enqueueChangeWindowReevaluation } = await import('../../../jobs/eventCorrelateWorker.js')
  // Epoca del passo = ingresso nel passo corrente (WorkflowInstance.updated_at):
  // stessa uscita dalla finestra → stesso job id (le mutation a raffica non
  // accodano N job); un'istanza senza data leggibile usa l'istante corrente.
  const epoch = Date.parse(row.enteredAt ?? '')
  if (Number.isNaN(epoch)) logger.warn({ changeId, enteredAt: row.enteredAt }, '[change] WorkflowInstance.updated_at non leggibile: job di fine finestra con epoca corrente')
  await enqueueChangeWindowReevaluation(ctx.tenantId, changeId, Number.isNaN(epoch) ? Date.now() : epoch)
  logger.info({ changeId, step: row.step, suppressed: toNumber(row.suppressed) }, '[change] finestra chiusa: rivalutazione degli eventi soppressi accodata')
}

/**
 * Risolve gli Incident collegati (RESOLVED_BY) quando la change arriva a
 * "closed". L'incident non ha step "change_requested"/"change_in_progress":
 * resta dov'è mentre la change gira, poi si risolve. La transizione a resolved
 * esiste solo da in_progress/escalated; da altri step non viene forzata (l'op.
 * risolverà a mano). root_cause valorizzata dalla change.
 */
async function syncLinkedIncidents(
  session: Session,
  changeId: string,
  ctx: GraphQLContext,
): Promise<void> {
  const rows = await runQuery<{ changeStep: string; code: string; instanceId: string; incidentStep: string }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(cw:WorkflowInstance)
    MATCH (i:Incident {tenant_id: $tenantId})-[:RESOLVED_BY]->(c)
    MATCH (i)-[:HAS_WORKFLOW]->(iw:WorkflowInstance)
    RETURN cw.current_step AS changeStep, c.code AS code, iw.id AS instanceId, iw.current_step AS incidentStep
  `, { changeId, tenantId: ctx.tenantId })

  for (const r of rows) {
    if (r.changeStep !== 'closed') continue
    if (r.incidentStep !== 'in_progress' && r.incidentStep !== 'escalated') {
      logger.info({ changeId, instanceId: r.instanceId, incidentStep: r.incidentStep },
        '[syncLinkedIncidents] change chiusa ma incident non in uno step risolvibile — nessun auto-resolve')
      continue
    }
    const res = await workflowEngine.transition(
      session,
      { instanceId: r.instanceId, toStepName: 'resolved', triggeredBy: ctx.userId ?? 'system', triggerType: 'automatic', notes: `Risolto dalla change ${r.code}` },
      { userId: ctx.userId ?? 'system', entityData: {} },
    )
    if (!res.success) logger.warn({ changeId, instanceId: r.instanceId, error: res.error }, '[syncLinkedIncidents] auto-resolve incident non riuscito')
  }
}

/**
 * Fa avanzare i Problem collegati (RESOLVED_BY) in base allo step attuale della
 * change: deployment/review → change_in_progress, closed → resolved. Le loro
 * transizioni sono automatiche e nessun altro le innescherebbe (il problem
 * resterebbe bloccato su change_requested, non chiudibile). Da "resolved" il
 * problem si chiude poi manualmente ("Verifica soluzione e chiudi").
 */
async function syncLinkedProblems(
  session: Session,
  changeId: string,
  ctx: GraphQLContext,
): Promise<void> {
  const rows = await runQuery<{ changeStep: string; instanceId: string; problemStep: string }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(cw:WorkflowInstance)
    MATCH (p:Problem {tenant_id: $tenantId})-[:RESOLVED_BY]->(c)
    MATCH (p)-[:HAS_WORKFLOW]->(pw:WorkflowInstance)
    RETURN cw.current_step AS changeStep, pw.id AS instanceId, pw.current_step AS problemStep
  `, { changeId, tenantId: ctx.tenantId })

  for (const r of rows) {
    const changeStep = r.changeStep
    const instanceId = r.instanceId
    let problemStep  = r.problemStep

    const drive = async (toStep: string): Promise<void> => {
      const res = await workflowEngine.transition(
        session,
        { instanceId, toStepName: toStep, triggeredBy: ctx.userId ?? 'system', triggerType: 'automatic', notes: `Change in stato "${changeStep}"` },
        { userId: ctx.userId ?? 'system', entityData: {} },
      )
      if (res.success) problemStep = toStep
      else logger.warn({ changeId, instanceId, toStep, error: res.error }, '[syncLinkedProblems] transizione problem non riuscita')
    }

    if (changeStep === 'deployment' || changeStep === 'review') {
      if (problemStep === 'change_requested') await drive('change_in_progress')
    } else if (changeStep === 'closed') {
      if (problemStep === 'change_requested') await drive('change_in_progress')
      if (problemStep === 'change_in_progress') await drive('resolved')
    }
  }
}

/**
 * Retrocede un problem a "under_investigation" quando la change risolutiva viene
 * scollegata o eliminata: se il problem era avanzato SOLO grazie alla change
 * (change_requested / change_in_progress) non ha più nulla che lo risolva, quindi
 * torna in analisi. Idempotente e silenzioso se il problem è in un altro step.
 */
export async function revertProblemAfterChangeDetached(
  session: Session,
  problemId: string,
  ctx: GraphQLContext,
): Promise<void> {
  const row = await runQueryOne<{ instanceId: string; step: string }>(session, `
    MATCH (p:Problem {id: $problemId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(pw:WorkflowInstance)
    RETURN pw.id AS instanceId, pw.current_step AS step
  `, { problemId, tenantId: ctx.tenantId })
  if (!row) return
  if (row.step !== 'change_requested' && row.step !== 'change_in_progress') return

  const res = await workflowEngine.transition(
    session,
    { instanceId: row.instanceId, toStepName: 'under_investigation', triggeredBy: ctx.userId ?? 'system', triggerType: 'automatic', notes: 'Change risolutiva scollegata' },
    { userId: ctx.userId ?? 'system', entityData: {} },
  )
  if (!res.success) logger.warn({ problemId, from: row.step, error: res.error }, '[revertProblemAfterChangeDetached] transizione non riuscita')
}

async function walkAutoTransitions(
  session: Session,
  changeId: string,
  ctx: GraphQLContext,
  afterEnterStep?: AfterEnterStep,
): Promise<void> {
  // Ogni step visitato una sola volta: un ciclo di archi automatici (es. due
  // step che si rimandano senza condizione) è un workflow mal configurato e
  // deve emergere, non consumare 10 hop scrivendo 10 execution.
  const visited = new Set<string>()
  for (;;) {
    const wi = await runQueryOne<{ instanceId: string; step: string; tenantId: string; entityProps: Props }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId, wi.current_step AS step, wi.tenant_id AS tenantId,
             properties(c) AS entityProps
    `, { changeId, tenantId: ctx.tenantId })
    if (!wi) return
    visited.add(wi.step)

    const transitions = await runQuery<{ toStep: string; condition: string | null }>(session, `
      MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})-[:CURRENT_STEP]->(current:WorkflowStep)
      MATCH (current)-[tr:TRANSITIONS_TO {trigger: 'automatic'}]->(next:WorkflowStep)
      RETURN next.name AS toStep, tr.condition AS condition
    `, { instanceId: wi.instanceId, tenantId: ctx.tenantId })
    if (transitions.length === 0) return

    let fired = false
    for (const tr of transitions) {
      let ok = tr.condition === null
      if (tr.condition) {
        const condCtx: ConditionContext = {
          instanceId: wi.instanceId, entityId: changeId, entityType: 'change', tenantId: ctx.tenantId,
          fromStepName: wi.step, toStepName: tr.toStep, triggerType: 'automatic', entityData: wi.entityProps,
        }
        try {
          ok = await workflowEngine.evaluateCondition(session, tr.condition, condCtx)
        } catch (e) {
          // Condizione non registrata = workflow mal configurato: fail-loud
          // (prima veniva saltata in silenzio e la change restava ferma).
          logger.error({ changeId, condition: tr.condition, toStep: tr.toStep, err: e }, '[auto-transition] condizione non valutabile')
          throw new GraphQLError(e instanceof Error ? e.message : String(e), { extensions: { code: 'CONFLICT' } })
        }
      }
      if (!ok) continue
      // Sto per rientrare in uno step già attraversato in questo walk: ciclo.
      if (visited.has(tr.toStep)) {
        throw new GraphQLError(`Workflow change mal configurato: ciclo di transizioni automatiche ${wi.step} → ${tr.toStep} (step già attraversato)`, { extensions: { code: 'CONFLICT' } })
      }

      const actionCtx: ActionContext = {
        userId:     ctx.userId ?? 'system',
        entityData: wi.entityProps,
      }
      const result = await workflowEngine.transition(session, {
        instanceId:  wi.instanceId,
        toStepName:  tr.toStep,
        triggeredBy: 'system',
        triggerType: 'automatic',
      }, actionCtx)

      if (!result.success) {
        logger.error({ changeId, from: wi.step, to: tr.toStep, error: result.error }, '[auto-transition] engine.transition failed')
        return
      }
      logger.info({ changeId, from: wi.step, to: tr.toStep }, '[auto-transition] fired')
      if (afterEnterStep) await afterEnterStep(session, changeId, ctx.tenantId, tr.toStep)
      fired = true
      break
    }
    if (!fired) return
  }
}
