/**
 * Mutations on the Change aggregate itself:
 *   createChange, addCIToChange, removeCIFromChange,
 *   executeChangeTransition, sendTaskReminder.
 */
import { GraphQLError } from 'graphql'
import { ValidationError } from '../../../lib/errors.js'
import { v4 as uuidv4 } from 'uuid'
import { workflowEngine } from '@opengraphity/workflow'
import type { ActionContext } from '@opengraphity/workflow'
import { TASK_STATUS, ASSESSMENT_ROLE } from '../../../lib/taskStatus.js'
import { withSession, runQueryOne, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { logger } from '../../../lib/logger.js'
import { change as getChange } from './queries.js'
import { evaluateAutoTransitions } from './autoTransitions.js'
import {
  writeAudit,
  nextChangeCode,
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
  args: { input: { title: string; description?: string | null; changeOwner?: string | null; affectedCIIds: string[] } },
  ctx: GraphQLContext,
) {
  const { title, description, changeOwner, affectedCIIds } = args.input
  if (!affectedCIIds || affectedCIIds.length === 0) {
    throw new ValidationError('Un change deve avere almeno un CI impattato')
  }
  return withSession(async (session) => {
    await assertCIHasOwnerAndSupport(session, ctx.tenantId, affectedCIIds)
    const code = await nextChangeCode(session, ctx.tenantId)
    const taskCodes = await getNextTaskCodes(session, ctx.tenantId, affectedCIIds.length * 3)
    const ciTasks = affectedCIIds.map((ciId, i) => ({
      ciId,
      ownerCode:   taskCodes[i * 3]!,
      supportCode: taskCodes[i * 3 + 1]!,
      planCode:    taskCodes[i * 3 + 2]!,
    }))
    const id = uuidv4()
    const now = new Date().toISOString()

    await session.executeWrite((tx) => tx.run(`
      CREATE (c:Change {
        id: $id, tenant_id: $tenantId, code: $code,
        title: $title, description: $description,
        aggregate_risk_score: null,
        approval_route: null, approval_status: null,
        created_at: $now, updated_at: $now
      })
      WITH c
      OPTIONAL MATCH (req:User {id: $requesterId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN req IS NULL THEN [] ELSE [1] END |
        CREATE (c)-[:REQUESTED_BY]->(req)
      )
      WITH c
      OPTIONAL MATCH (owner:User {id: $ownerId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN owner IS NULL THEN [] ELSE [1] END |
        CREATE (c)-[:OWNED_BY]->(owner)
      )
      WITH c
      UNWIND $ciTasks AS ct
      MATCH (ci {id: ct.ciId, tenant_id: $tenantId})
      MATCH (ci)-[:OWNED_BY]->(ownerTeam:Team)
      MATCH (ci)-[:SUPPORTED_BY]->(supportTeam:Team)
      CREATE (c)-[:AFFECTS_CI {ci_phase: 'assessment'}]->(ci)
      CREATE (ownerT:AssessmentTask {
        id: randomUUID(), code: ct.ownerCode, tenant_id: $tenantId, ci_id: ci.id,
        responder_role: '${ASSESSMENT_ROLE.OWNER}', status: '${TASK_STATUS.PENDING}', score: null, created_at: $now
      })
      CREATE (c)-[:HAS_ASSESSMENT]->(ownerT)
      CREATE (ownerT)-[:ASSIGNED_TO_TEAM]->(ownerTeam)
      CREATE (supportT:AssessmentTask {
        id: randomUUID(), code: ct.supportCode, tenant_id: $tenantId, ci_id: ci.id,
        responder_role: '${ASSESSMENT_ROLE.SUPPORT}', status: '${TASK_STATUS.PENDING}', score: null, created_at: $now
      })
      CREATE (c)-[:HAS_ASSESSMENT]->(supportT)
      CREATE (supportT)-[:ASSIGNED_TO_TEAM]->(supportTeam)
      CREATE (dp:DeployPlanTask {
        id: randomUUID(), code: ct.planCode, tenant_id: $tenantId, ci_id: ci.id,
        status: '${TASK_STATUS.PENDING}', steps: '[]',
        created_at: $now
      })
      CREATE (c)-[:HAS_DEPLOY_PLAN]->(dp)
      CREATE (dp)-[:ASSIGNED_TO_TEAM]->(supportTeam)
    `, {
      id, code, title,
      description: description ?? null,
      requesterId: ctx.userId,
      ownerId: changeOwner ?? null,
      ciTasks,
      tenantId: ctx.tenantId,
      now,
    }))

    await workflowEngine.createInstance(session, ctx.tenantId, id, 'change')

    await writeAudit(session, id, ctx.tenantId, 'change_created', ctx.userId,
      `Change ${code} creato con ${affectedCIIds.length} CI`)

    return getChange(null, { id }, ctx)
  }, true)
}

// ── addCIToChange / removeCIFromChange ────────────────────────────────────────

export async function addCIToChange(_: unknown, args: { changeId: string; ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    await assertInitialStep(session, args.changeId, ctx.tenantId)
    await assertCIHasOwnerAndSupport(session, ctx.tenantId, [args.ciId])
    const [ownerCode, supportCode, planCode] = await getNextTaskCodes(session, ctx.tenantId, 3)
    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
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
         ownerCode, supportCode, planCode }))

    const ciName = await getCIName(session, args.ciId, ctx.tenantId)
    await writeAudit(session, args.changeId, ctx.tenantId, 'ci_added', ctx.userId, `CI ${ciName} aggiunto`)

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

export async function removeCIFromChange(_: unknown, args: { changeId: string; ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    await assertInitialStep(session, args.changeId, ctx.tenantId)
    const ciName = await getCIName(session, args.ciId, ctx.tenantId)
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->(ci {id: $ciId})
      DELETE r
      WITH c
      OPTIONAL MATCH (c)-[:HAS_ASSESSMENT]->(t:AssessmentTask {ci_id: $ciId})
      OPTIONAL MATCH (t)-[:HAS_RESPONSE]->(resp:AssessmentResponse)
      OPTIONAL MATCH (c)-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask {ci_id: $ciId})
      DETACH DELETE resp, t, dp
      SET c.updated_at = $now
    `, { changeId: args.changeId, ciId: args.ciId, tenantId: ctx.tenantId, now: new Date().toISOString() }))

    await writeAudit(session, args.changeId, ctx.tenantId, 'ci_removed', ctx.userId, `CI ${ciName} rimosso`)
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
