/**
 * Mutations run during the deployment / review phases:
 *   completeValidationTest, completeDeployment, completeReview.
 */
import { ValidationError } from '../../../lib/errors.js'
import { TASK_STATUS, VALIDATION_RESULT, REVIEW_RESULT } from '../../../lib/taskStatus.js'
import { withSession, runQueryOne, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { mapValidationTest, mapDeploymentTask, mapReviewTask } from './mappers.js'
import { evaluateAutoTransitions } from './autoTransitions.js'
import {
  writeAudit,
  getCIName,
  assertUserInCITeam,
  afterEnterStep,
} from './helpers.js'

// ── completeValidationTest ────────────────────────────────────────────────────

export async function completeValidationTest(
  _: unknown,
  args: { changeId: string; ciId: string; result: string },
  ctx: GraphQLContext,
) {
  if (args.result !== VALIDATION_RESULT.PASS && args.result !== VALIDATION_RESULT.FAIL) {
    throw new ValidationError('result deve essere "pass" o "fail"')
  }
  return withSession(async (session) => {
    await assertUserInCITeam(session, args.ciId, ctx.tenantId, ctx, 'owner')
    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_VALIDATION]->(vt:ValidationTest {ci_id: $ciId})
      SET vt.status = '${TASK_STATUS.COMPLETED}', vt.result = $result, vt.tested_at = $now
      WITH c, vt
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END |
        MERGE (vt)-[:TESTED_BY]->(u)
      )
      SET c.updated_at = $now
    `, { changeId: args.changeId, ciId: args.ciId, result: args.result,
         tenantId: ctx.tenantId, userId: ctx.userId, now }))

    const valCiName = await getCIName(session, args.ciId, ctx.tenantId)
    await writeAudit(session, args.changeId, ctx.tenantId, 'validation_completed', ctx.userId,
      `${valCiName}: ${args.result}`)

    await evaluateAutoTransitions(session, args.changeId, ctx, afterEnterStep)

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (:Change {id: $changeId})-[:HAS_VALIDATION]->(vt:ValidationTest {ci_id: $ciId})
      RETURN properties(vt) AS props
    `, { changeId: args.changeId, ciId: args.ciId })
    return row ? mapValidationTest(row.props) : null
  }, true)
}

// ── completeDeployment ────────────────────────────────────────────────────────

export async function completeDeployment(_: unknown, args: { changeId: string; ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    await assertUserInCITeam(session, args.ciId, ctx.tenantId, ctx, 'support')
    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_DEPLOYMENT]->(dt:DeploymentTask {ci_id: $ciId})
      SET dt.status = '${TASK_STATUS.COMPLETED}', dt.deployed_at = $now
      WITH c, dt
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END |
        MERGE (dt)-[:DEPLOYED_BY]->(u)
      )
      SET c.updated_at = $now
    `, { changeId: args.changeId, ciId: args.ciId, tenantId: ctx.tenantId, userId: ctx.userId, now }))

    const dcCiName = await getCIName(session, args.ciId, ctx.tenantId)
    await writeAudit(session, args.changeId, ctx.tenantId, 'deployment_completed', ctx.userId, `Deployed su ${dcCiName}`)
    await evaluateAutoTransitions(session, args.changeId, ctx, afterEnterStep)

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (:Change {id: $changeId})-[:HAS_DEPLOYMENT]->(dt:DeploymentTask {ci_id: $ciId})
      RETURN properties(dt) AS props
    `, { changeId: args.changeId, ciId: args.ciId })
    return row ? mapDeploymentTask(row.props) : null
  }, true)
}

// ── completeReview ────────────────────────────────────────────────────────────

export async function completeReview(
  _: unknown,
  args: { changeId: string; ciId: string; result: string },
  ctx: GraphQLContext,
) {
  if (args.result !== REVIEW_RESULT.CONFIRMED && args.result !== REVIEW_RESULT.REJECTED) {
    throw new ValidationError('result deve essere "confirmed" o "rejected"')
  }
  return withSession(async (session) => {
    await assertUserInCITeam(session, args.ciId, ctx.tenantId, ctx, 'owner')
    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_REVIEW]->(rv:ReviewTask {ci_id: $ciId})
      SET rv.status = '${TASK_STATUS.COMPLETED}', rv.result = $result, rv.reviewed_at = $now
      WITH c, rv
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END |
        MERGE (rv)-[:REVIEWED_BY]->(u)
      )
      SET c.updated_at = $now
    `, { changeId: args.changeId, ciId: args.ciId, result: args.result,
         tenantId: ctx.tenantId, userId: ctx.userId, now }))

    const revCiName = await getCIName(session, args.ciId, ctx.tenantId)
    await writeAudit(session, args.changeId, ctx.tenantId, 'review_completed', ctx.userId, `${revCiName}: ${args.result}`)
    await evaluateAutoTransitions(session, args.changeId, ctx, afterEnterStep)

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (:Change {id: $changeId})-[:HAS_REVIEW]->(rv:ReviewTask {ci_id: $ciId})
      RETURN properties(rv) AS props
    `, { changeId: args.changeId, ciId: args.ciId })
    return row ? mapReviewTask(row.props) : null
  }, true)
}
