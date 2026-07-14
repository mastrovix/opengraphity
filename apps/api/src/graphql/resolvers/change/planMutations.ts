/**
 * Mutations on DeployPlanTask — editing and completion of the deploy plan.
 */
import { GraphQLError } from 'graphql'
import { ValidationError } from '../../../lib/errors.js'
import { TASK_STATUS } from '../../../lib/taskStatus.js'
import { withSession, runQueryOne, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { mapDeployPlanTask } from './mappers.js'
import { evaluateAutoTransitions } from './autoTransitions.js'
import { getInitialStepName } from '../../../lib/workflowHelpers.js'
import {
  writeAudit,
  getCIName,
  assertUserInCITeam,
  computeAggregateRisk,
  afterEnterStep,
} from './helpers.js'

type TimeWindowInput = { start: string; end: string }
type DeployStepInput = { title: string; validationWindow: TimeWindowInput; releaseWindow: TimeWindowInput }

function validateWindow(label: string, w: TimeWindowInput) {
  if (!w || !w.start || !w.end) throw new ValidationError(`${label}: start e end obbligatori`)
  if (new Date(w.start).getTime() >= new Date(w.end).getTime()) {
    throw new ValidationError(`${label}: end deve essere dopo start`)
  }
}

function validateStep(idx: number, s: DeployStepInput) {
  if (!s.title || !s.title.trim()) throw new ValidationError(`Step ${idx + 1}: titolo obbligatorio`)
  validateWindow(`Step ${idx + 1} — finestra di validazione`, s.validationWindow)
  validateWindow(`Step ${idx + 1} — finestra di deploy`, s.releaseWindow)
}

// ── saveDeployPlan ────────────────────────────────────────────────────────────

export async function saveDeployPlan(
  _: unknown,
  args: { taskId: string; steps: DeployStepInput[] },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const tctx = await runQueryOne<{ ciId: string; changeId: string; status: string; currentStep: string }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask {id: $taskId})
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN dp.ci_id AS ciId, c.id AS changeId, dp.status AS status, wi.current_step AS currentStep
    `, { taskId: args.taskId, tenantId: ctx.tenantId })
    if (!tctx) throw new GraphQLError(`DeployPlanTask ${args.taskId} non trovata`, { extensions: { code: 'NOT_FOUND' } })
    if (tctx.status === TASK_STATUS.COMPLETED) throw new GraphQLError('Task già completata', { extensions: { code: 'CONFLICT' } })
    const initialStepName = await getInitialStepName(session, ctx.tenantId, 'change')
    if (tctx.currentStep !== initialStepName) throw new GraphQLError(`Piano deploy editabile solo nello step iniziale (${initialStepName})`, { extensions: { code: 'CONFLICT' } })
    await assertUserInCITeam(session, tctx.ciId, ctx.tenantId, ctx, 'support')
    if (!Array.isArray(args.steps) || args.steps.length < 1) throw new ValidationError('Almeno 1 step obbligatorio')
    args.steps.forEach((s, i) => validateStep(i, s))

    const normalized = args.steps.map(s => ({
      title: s.title.trim(),
      validationWindow: { start: s.validationWindow.start, end: s.validationWindow.end },
      releaseWindow:    { start: s.releaseWindow.start,    end: s.releaseWindow.end    },
    }))

    await session.executeWrite((tx) => tx.run(`
      MATCH (dp:DeployPlanTask {id: $taskId, tenant_id: $tenantId})
      SET dp.steps = $steps, dp.status = '${TASK_STATUS.IN_PROGRESS}'
    `, { taskId: args.taskId, tenantId: ctx.tenantId, steps: JSON.stringify(normalized) }))

    const ciName = await getCIName(session, tctx.ciId, ctx.tenantId)
    await writeAudit(session, tctx.changeId, ctx.tenantId, 'deploy_plan_saved', ctx.userId,
      `${ciName}: ${normalized.length} step — ${normalized.map(s => `"${s.title}"`).join(', ')}`)

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (dp:DeployPlanTask {id: $taskId}) RETURN properties(dp) AS props
    `, { taskId: args.taskId })
    return row ? mapDeployPlanTask(row.props) : null
  }, true)
}

// ── completeDeployPlanTask ────────────────────────────────────────────────────

export async function completeDeployPlanTask(_: unknown, args: { taskId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const tctx = await runQueryOne<{ ciId: string; changeId: string; status: string; steps: string | null }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask {id: $taskId})
      RETURN dp.ci_id AS ciId, c.id AS changeId, dp.status AS status, dp.steps AS steps
    `, { taskId: args.taskId, tenantId: ctx.tenantId })
    if (!tctx) throw new GraphQLError(`DeployPlanTask ${args.taskId} non trovata`, { extensions: { code: 'NOT_FOUND' } })
    if (tctx.status === TASK_STATUS.COMPLETED) throw new GraphQLError('Task già completata', { extensions: { code: 'CONFLICT' } })
    await assertUserInCITeam(session, tctx.ciId, ctx.tenantId, ctx, 'support')

    const steps = tctx.steps ? JSON.parse(tctx.steps) as unknown[] : []
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new GraphQLError('Almeno 1 step deve essere compilato prima di completare', { extensions: { code: 'CONFLICT' } })
    }

    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (dp:DeployPlanTask {id: $taskId, tenant_id: $tenantId})
      SET dp.status = '${TASK_STATUS.COMPLETED}', dp.completed_at = $now
      WITH dp
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END |
        CREATE (dp)-[:COMPLETED_BY]->(u)
      )
    `, { taskId: args.taskId, tenantId: ctx.tenantId, now, userId: ctx.userId }))

    const ciName = await getCIName(session, tctx.ciId, ctx.tenantId)
    await writeAudit(session, tctx.changeId, ctx.tenantId, 'deploy_plan_completed', ctx.userId,
      `${ciName}: piano completato (${steps.length} step)`)

    await computeAggregateRisk(session, tctx.changeId, ctx.tenantId)
    await evaluateAutoTransitions(session, tctx.changeId, ctx, afterEnterStep)

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (dp:DeployPlanTask {id: $taskId}) RETURN properties(dp) AS props
    `, { taskId: args.taskId })
    return row ? mapDeployPlanTask(row.props) : null
  }, true)
}
