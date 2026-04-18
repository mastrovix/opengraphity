import { workflowEngine } from '@opengraphity/workflow'
import type { ActionContext } from '@opengraphity/workflow'
import { runQuery, runQueryOne, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { logger } from '../../../lib/logger.js'

type Session2 = Parameters<typeof runQuery>[0]
export type AfterEnterStep = (session: Session2, changeId: string, tenantId: string, stepName: string) => Promise<void>

type Session = Parameters<typeof runQuery>[0]

// Mapping condition → async evaluator returning true when condition holds.
// Every condition inspects DB state for the given Change.
const CONDITIONS: Record<string, (session: Session, changeId: string, tenantId: string) => Promise<boolean>> = {
  // All assessments completed = for every AFFECTS_CI on this change,
  // the Functional, Technical and Planning tasks are all in status 'completed'.
  all_assessments_complete: async (session, changeId, tenantId) => {
    const row = await runQueryOne<{ pending: number }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
      WITH c, count(ci) AS ciCount
      OPTIONAL MATCH (c)-[:HAS_ASSESSMENT]->(at:AssessmentTask)
        WHERE at.status <> 'completed'
      OPTIONAL MATCH (c)-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask)
        WHERE dp.status <> 'completed'
      WITH ciCount, count(DISTINCT at) + count(DISTINCT dp) AS pending
      RETURN CASE WHEN ciCount = 0 THEN 1 ELSE pending END AS pending
    `, { changeId, tenantId })
    return (row?.pending ?? 1) === 0
  },

  // All deployments completed = for every AFFECTS_CI, validation passed
  // AND deployment completed.
  all_deployments_complete: async (session, changeId, tenantId) => {
    const row = await runQueryOne<{ pending: number }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
      WITH c, count(ci) AS ciCount
      OPTIONAL MATCH (c)-[:HAS_VALIDATION]->(vt:ValidationTest)
        WHERE vt.status <> 'completed' OR vt.result <> 'pass'
      OPTIONAL MATCH (c)-[:HAS_DEPLOYMENT]->(dt:DeploymentTask)
        WHERE dt.status <> 'completed'
      WITH ciCount, count(DISTINCT vt) + count(DISTINCT dt) AS pending
      RETURN CASE WHEN ciCount = 0 THEN 1 ELSE pending END AS pending
    `, { changeId, tenantId })
    return (row?.pending ?? 1) === 0
  },

  // All reviews confirmed = for every AFFECTS_CI, review task completed
  // with result = 'confirmed'.
  all_reviews_confirmed: async (session, changeId, tenantId) => {
    const row = await runQueryOne<{ pending: number }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
      WITH c, count(ci) AS ciCount
      OPTIONAL MATCH (c)-[:HAS_REVIEW]->(rv:ReviewTask)
        WHERE rv.status <> 'completed' OR rv.result <> 'confirmed'
      WITH ciCount, count(DISTINCT rv) AS pending
      RETURN CASE WHEN ciCount = 0 THEN 1 ELSE pending END AS pending
    `, { changeId, tenantId })
    return (row?.pending ?? 1) === 0
  },
}

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
  // Max 10 hops to defend against misconfigured cycles.
  for (let i = 0; i < 10; i++) {
    const wi = await runQueryOne<{ instanceId: string; step: string; tenantId: string; entityProps: Props }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN wi.id AS instanceId, wi.current_step AS step, wi.tenant_id AS tenantId,
             properties(c) AS entityProps
    `, { changeId, tenantId: ctx.tenantId })
    if (!wi) return

    const transitions = await runQuery<{ toStep: string; condition: string | null }>(session, `
      MATCH (wi:WorkflowInstance {id: $instanceId})-[:CURRENT_STEP]->(current:WorkflowStep)
      MATCH (current)-[tr:TRANSITIONS_TO {trigger: 'automatic'}]->(next:WorkflowStep)
      RETURN next.name AS toStep, tr.condition AS condition
    `, { instanceId: wi.instanceId })
    if (transitions.length === 0) return

    let fired = false
    for (const tr of transitions) {
      const evaluator = tr.condition ? CONDITIONS[tr.condition] : null
      const ok = evaluator ? await evaluator(session, changeId, ctx.tenantId) : (tr.condition === null)
      if (!ok) continue

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
