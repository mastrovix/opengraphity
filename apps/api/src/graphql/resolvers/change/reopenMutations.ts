/**
 * Admin-only "reopen" mutations: revert a completed task back to an open state.
 */
import { GraphQLError } from 'graphql'
import { TASK_STATUS } from '../../../lib/taskStatus.js'
import { withSession, runQueryOne, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import {
  mapAssessmentTask,
  mapDeployPlanTask,
  mapValidationTest,
  mapDeploymentTask,
  mapReviewTask,
} from './mappers.js'
import {
  assertAdmin,
  writeAudit,
  getCIName,
} from './helpers.js'

// ── Assessment ────────────────────────────────────────────────────────────────

export async function reopenAssessmentTask(_: unknown, args: { taskId: string; reason: string }, ctx: GraphQLContext) {
  assertAdmin(ctx)
  return withSession(async (session) => {
    const tctx = await runQueryOne<{ changeId: string; ciId: string; role: string }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_ASSESSMENT]->(t:AssessmentTask {id: $taskId})
      RETURN c.id AS changeId, t.ci_id AS ciId, t.responder_role AS role
    `, { taskId: args.taskId, tenantId: ctx.tenantId })
    if (!tctx) throw new GraphQLError(`AssessmentTask ${args.taskId} non trovata`, { extensions: { code: 'NOT_FOUND' } })

    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (t:AssessmentTask {id: $taskId, tenant_id: $tenantId})
      SET t.status = '${TASK_STATUS.IN_PROGRESS}', t.score = null, t.completed_at = null
      WITH t
      OPTIONAL MATCH (t)-[r:COMPLETED_BY]->()
      DELETE r
    `, { taskId: args.taskId, tenantId: ctx.tenantId }))

    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->(ci {id: $ciId})
      SET r.risk_score = null
    `, { changeId: tctx.changeId, ciId: tctx.ciId, tenantId: ctx.tenantId }))

    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      SET c.aggregate_risk_score = null,
          c.approval_route = null,
          c.approval_status = null,
          c.updated_at = $now
    `, { changeId: tctx.changeId, tenantId: ctx.tenantId, now }))

    const ciName = await getCIName(session, tctx.ciId, ctx.tenantId)
    await writeAudit(session, tctx.changeId, ctx.tenantId, 'task_reopened', ctx.userId,
      `Assessment ${tctx.role} · ${ciName} riaperto: ${args.reason}`)

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (t:AssessmentTask {id: $taskId}) RETURN properties(t) AS props
    `, { taskId: args.taskId })
    return row ? mapAssessmentTask(row.props) : null
  }, true)
}

// ── Deploy plan ───────────────────────────────────────────────────────────────

export async function reopenDeployPlanTask(_: unknown, args: { taskId: string; reason: string }, ctx: GraphQLContext) {
  assertAdmin(ctx)
  return withSession(async (session) => {
    const tctx = await runQueryOne<{ changeId: string; ciId: string }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask {id: $taskId})
      RETURN c.id AS changeId, dp.ci_id AS ciId
    `, { taskId: args.taskId, tenantId: ctx.tenantId })
    if (!tctx) throw new GraphQLError(`DeployPlanTask ${args.taskId} non trovata`, { extensions: { code: 'NOT_FOUND' } })

    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (dp:DeployPlanTask {id: $taskId, tenant_id: $tenantId})
      SET dp.status = '${TASK_STATUS.IN_PROGRESS}', dp.completed_at = null
      WITH dp
      OPTIONAL MATCH (dp)-[r:COMPLETED_BY]->()
      DELETE r
    `, { taskId: args.taskId, tenantId: ctx.tenantId }))

    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      SET c.updated_at = $now
    `, { changeId: tctx.changeId, tenantId: ctx.tenantId, now }))

    const ciName = await getCIName(session, tctx.ciId, ctx.tenantId)
    await writeAudit(session, tctx.changeId, ctx.tenantId, 'task_reopened', ctx.userId,
      `Piano deploy · ${ciName} riaperto: ${args.reason}`)

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (dp:DeployPlanTask {id: $taskId}) RETURN properties(dp) AS props
    `, { taskId: args.taskId })
    return row ? mapDeployPlanTask(row.props) : null
  }, true)
}

// ── Validation ────────────────────────────────────────────────────────────────

export async function reopenValidationTest(_: unknown, args: { id: string; reason: string }, ctx: GraphQLContext) {
  assertAdmin(ctx)
  return withSession(async (session) => {
    const tctx = await runQueryOne<{ changeId: string; ciId: string }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_VALIDATION]->(vt:ValidationTest {id: $id})
      RETURN c.id AS changeId, vt.ci_id AS ciId
    `, { id: args.id, tenantId: ctx.tenantId })
    if (!tctx) throw new GraphQLError(`ValidationTest ${args.id} non trovata`, { extensions: { code: 'NOT_FOUND' } })

    await session.executeWrite((tx) => tx.run(`
      MATCH (vt:ValidationTest {id: $id, tenant_id: $tenantId})
      SET vt.status = '${TASK_STATUS.PENDING}', vt.result = null, vt.tested_at = null
      WITH vt
      OPTIONAL MATCH (vt)-[r:TESTED_BY]->()
      DELETE r
    `, { id: args.id, tenantId: ctx.tenantId }))

    const ciName = await getCIName(session, tctx.ciId, ctx.tenantId)
    await writeAudit(session, tctx.changeId, ctx.tenantId, 'task_reopened', ctx.userId,
      `Validation · ${ciName} riaperto: ${args.reason}`)

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (vt:ValidationTest {id: $id}) RETURN properties(vt) AS props
    `, { id: args.id })
    return row ? mapValidationTest(row.props) : null
  }, true)
}

// ── Deployment ────────────────────────────────────────────────────────────────

export async function reopenDeploymentTask(_: unknown, args: { id: string; reason: string }, ctx: GraphQLContext) {
  assertAdmin(ctx)
  return withSession(async (session) => {
    const tctx = await runQueryOne<{ changeId: string; ciId: string }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_DEPLOYMENT]->(dt:DeploymentTask {id: $id})
      RETURN c.id AS changeId, dt.ci_id AS ciId
    `, { id: args.id, tenantId: ctx.tenantId })
    if (!tctx) throw new GraphQLError(`DeploymentTask ${args.id} non trovata`, { extensions: { code: 'NOT_FOUND' } })

    await session.executeWrite((tx) => tx.run(`
      MATCH (dt:DeploymentTask {id: $id, tenant_id: $tenantId})
      SET dt.status = '${TASK_STATUS.PENDING}', dt.deployed_at = null
      WITH dt
      OPTIONAL MATCH (dt)-[r:DEPLOYED_BY]->()
      DELETE r
    `, { id: args.id, tenantId: ctx.tenantId }))

    const ciName = await getCIName(session, tctx.ciId, ctx.tenantId)
    await writeAudit(session, tctx.changeId, ctx.tenantId, 'task_reopened', ctx.userId,
      `Deployment · ${ciName} riaperto: ${args.reason}`)

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (dt:DeploymentTask {id: $id}) RETURN properties(dt) AS props
    `, { id: args.id })
    return row ? mapDeploymentTask(row.props) : null
  }, true)
}

// ── Review ────────────────────────────────────────────────────────────────────

export async function reopenReviewTask(_: unknown, args: { id: string; reason: string }, ctx: GraphQLContext) {
  assertAdmin(ctx)
  return withSession(async (session) => {
    const tctx = await runQueryOne<{ changeId: string; ciId: string }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_REVIEW]->(rv:ReviewTask {id: $id})
      RETURN c.id AS changeId, rv.ci_id AS ciId
    `, { id: args.id, tenantId: ctx.tenantId })
    if (!tctx) throw new GraphQLError(`ReviewTask ${args.id} non trovata`, { extensions: { code: 'NOT_FOUND' } })

    await session.executeWrite((tx) => tx.run(`
      MATCH (rv:ReviewTask {id: $id, tenant_id: $tenantId})
      SET rv.status = '${TASK_STATUS.PENDING}', rv.result = null, rv.reviewed_at = null
      WITH rv
      OPTIONAL MATCH (rv)-[r:REVIEWED_BY]->()
      DELETE r
    `, { id: args.id, tenantId: ctx.tenantId }))

    const ciName = await getCIName(session, tctx.ciId, ctx.tenantId)
    await writeAudit(session, tctx.changeId, ctx.tenantId, 'task_reopened', ctx.userId,
      `Review · ${ciName} riaperto: ${args.reason}`)

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (rv:ReviewTask {id: $id}) RETURN properties(rv) AS props
    `, { id: args.id })
    return row ? mapReviewTask(row.props) : null
  }, true)
}
