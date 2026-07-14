/**
 * Mutations on AssessmentTask — response submission, completion, assignment.
 */
import { GraphQLError } from 'graphql'
import { ForbiddenError } from '../../../lib/errors.js'
import {
  TASK_STATUS, ASSESSMENT_ROLE, ROLE_LABEL, ROLE_TO_CATEGORY,
} from '../../../lib/taskStatus.js'
import { withSession, runQuery, runQueryOne, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { logger } from '../../../lib/logger.js'
import { mapAssessmentTask, toInt } from './mappers.js'
import { evaluateAutoTransitions } from './autoTransitions.js'
import {
  writeAudit,
  getCIName,
  getQuestionText,
  getAnswerLabel,
  assertUserInCITeam,
  recomputeCIRiskIfReady,
  computeAggregateRisk,
  afterEnterStep,
  type Session,
} from './helpers.js'

// ── submitAssessmentResponse ──────────────────────────────────────────────────

export async function submitAssessmentResponse(
  _: unknown,
  args: { taskId: string; questionId: string; optionId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const task = await runQueryOne<{ props: Props; changeId: string }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_ASSESSMENT]->(t:AssessmentTask {id: $taskId})
      RETURN properties(t) AS props, c.id AS changeId
    `, { taskId: args.taskId, tenantId: ctx.tenantId })
    if (!task) throw new GraphQLError(`AssessmentTask ${args.taskId} non trovata`, { extensions: { code: 'NOT_FOUND' } })
    if (task.props['status'] === TASK_STATUS.COMPLETED) {
      throw new GraphQLError('Task già completata, impossibile modificare le risposte', { extensions: { code: 'CONFLICT' } })
    }
    const role = task.props['responder_role'] === ASSESSMENT_ROLE.SUPPORT ? ASSESSMENT_ROLE.SUPPORT : ASSESSMENT_ROLE.OWNER
    await assertUserInCITeam(session, task.props['ci_id'] as string, ctx.tenantId, ctx, role)
    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (t:AssessmentTask {id: $taskId, tenant_id: $tenantId})
      MATCH (q:AssessmentQuestion {id: $questionId, tenant_id: $tenantId})
      MATCH (opt:AnswerOption {id: $optionId})
      OPTIONAL MATCH (t)-[:HAS_RESPONSE]->(old:AssessmentResponse)-[:ANSWERS]->(q)
      DETACH DELETE old
      WITH t, q, opt
      CREATE (resp:AssessmentResponse {
        id: randomUUID(), tenant_id: $tenantId, answered_at: $now
      })
      CREATE (t)-[:HAS_RESPONSE]->(resp)
      CREATE (resp)-[:ANSWERS]->(q)
      CREATE (resp)-[:SELECTED]->(opt)
      WITH t, resp
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END |
        CREATE (resp)-[:ANSWERED_BY]->(u)
      )
      SET t.status = '${TASK_STATUS.IN_PROGRESS}'
    `, { taskId: args.taskId, questionId: args.questionId, optionId: args.optionId,
         tenantId: ctx.tenantId, userId: ctx.userId, now }))

    const ciName   = await getCIName(session, task.props['ci_id'] as string, ctx.tenantId)
    const qText    = await getQuestionText(session, args.questionId, ctx.tenantId)
    const optLabel = await getAnswerLabel(session, args.optionId)
    await writeAudit(session, task.changeId, ctx.tenantId, 'assessment_response_submitted', ctx.userId,
      `${ROLE_LABEL[role]} · ${ciName}: "${qText}" → ${optLabel}`)

    const updated = await runQueryOne<{ props: Props }>(session, `
      MATCH (t:AssessmentTask {id: $taskId}) RETURN properties(t) AS props
    `, { taskId: args.taskId })
    return updated ? mapAssessmentTask(updated.props) : null
  }, true)
}

// ── completeAssessmentTask ────────────────────────────────────────────────────

export async function completeAssessmentTask(_: unknown, args: { taskId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const ctx1 = await runQueryOne<{
      taskProps: Props
      changeId: string
      ciId: string
      ciLabel: string
      ciTypeId: string | null
      ciEnv: string | null
    }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_ASSESSMENT]->(t:AssessmentTask {id: $taskId})
      MATCH (ci {id: t.ci_id, tenant_id: $tenantId})
      OPTIONAL MATCH (ct:CITypeDefinition {active: true, scope: 'base'})
        WHERE ct.neo4j_label = labels(ci)[0]
      RETURN properties(t) AS taskProps, c.id AS changeId,
             ci.id AS ciId, labels(ci)[0] AS ciLabel, ct.id AS ciTypeId,
             ci.environment AS ciEnv
    `, { taskId: args.taskId, tenantId: ctx.tenantId })
    if (!ctx1) throw new GraphQLError(`AssessmentTask ${args.taskId} non trovata`, { extensions: { code: 'NOT_FOUND' } })
    if (ctx1.taskProps['status'] === TASK_STATUS.COMPLETED) throw new GraphQLError('Task già completata', { extensions: { code: 'CONFLICT' } })

    const role = ctx1.taskProps['responder_role'] === ASSESSMENT_ROLE.SUPPORT ? ASSESSMENT_ROLE.SUPPORT : ASSESSMENT_ROLE.OWNER
    await assertUserInCITeam(session, ctx1.ciId, ctx.tenantId, ctx, role)

    const taskCategory = ROLE_TO_CATEGORY[role]

    type QRow = { questionId: string; weight: unknown; maxScore: unknown }
    const questions = await runQuery<QRow>(session, `
      MATCH (ct:CITypeDefinition {id: $ciTypeId})-[rel:HAS_QUESTION]->(q:AssessmentQuestion {tenant_id: $tenantId, is_active: true, category: $category})
      OPTIONAL MATCH (q)-[:HAS_OPTION]->(o:AnswerOption)
      WITH q, rel.weight AS weight, max(o.score) AS maxScore
      RETURN q.id AS questionId, weight, maxScore
    `, { ciTypeId: ctx1.ciTypeId, tenantId: ctx.tenantId, category: taskCategory })

    if (questions.length === 0) {
      logger.error({ taskId: args.taskId, ciTypeId: ctx1.ciTypeId, category: taskCategory },
        '[completeAssessmentTask] nessuna domanda assegnata al CIType per questa categoria')
      throw new GraphQLError('Nessuna domanda di assessment assegnata al tipo di CI per la categoria richiesta', { extensions: { code: 'CONFLICT' } })
    }

    const responses = await runQuery<{ questionId: string; score: unknown }>(session, `
      MATCH (t:AssessmentTask {id: $taskId})-[:HAS_RESPONSE]->(resp:AssessmentResponse)-[:ANSWERS]->(q:AssessmentQuestion)
      MATCH (resp)-[:SELECTED]->(opt:AnswerOption)
      RETURN q.id AS questionId, opt.score AS score
    `, { taskId: args.taskId })

    const answered = new Map<string, number>()
    for (const r of responses) answered.set(r.questionId, toInt(r.score))

    const missing = questions.filter(q => !answered.has(q.questionId))
    if (missing.length > 0) {
      throw new GraphQLError(`Risposte mancanti: ${missing.length} domande da completare prima di chiudere la task`, { extensions: { code: 'CONFLICT' } })
    }

    let num = 0, den = 0
    for (const q of questions) {
      const w = toInt(q.weight, 1)
      const max = toInt(q.maxScore, 0)
      const ans = answered.get(q.questionId) ?? 0
      num += w * ans
      den += w * max
    }

    // Automatic environment factor (replaces the removed
    // "Is the production environment affected?" question):
    //   production → score 3 (max)
    //   staging    → score 1
    //   altro      → score 0
    const ENV_WEIGHT = 5
    const ENV_MAX    = 3
    const envScore =
      ctx1.ciEnv === 'production' ? 3 :
      ctx1.ciEnv === 'staging'    ? 1 :
                                    0
    num += ENV_WEIGHT * envScore
    den += ENV_WEIGHT * ENV_MAX

    const score = den > 0 ? Math.round((num / den) * 100) : 0

    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (t:AssessmentTask {id: $taskId, tenant_id: $tenantId})
      SET t.status = '${TASK_STATUS.COMPLETED}', t.score = $score, t.completed_at = $now
      WITH t
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END |
        CREATE (t)-[:COMPLETED_BY]->(u)
      )
    `, { taskId: args.taskId, tenantId: ctx.tenantId, score, now, userId: ctx.userId }))

    const ciName1 = await getCIName(session, ctx1.ciId, ctx.tenantId)
    const role1   = ctx1.taskProps['responder_role'] as string
    await writeAudit(session, ctx1.changeId, ctx.tenantId, 'assessment_task_completed', ctx.userId,
      `${ROLE_LABEL[role1]} · ${ciName1}: score ${score}`)

    await recomputeCIRiskIfReady(session, ctx1.changeId, ctx1.ciId, ctx.tenantId, ctx.userId)
    await computeAggregateRisk(session, ctx1.changeId, ctx.tenantId)
    await evaluateAutoTransitions(session, ctx1.changeId, ctx, afterEnterStep)

    const updated = await runQueryOne<{ props: Props }>(session, `
      MATCH (t:AssessmentTask {id: $taskId}) RETURN properties(t) AS props
    `, { taskId: args.taskId })
    return updated ? mapAssessmentTask(updated.props) : null
  }, true)
}

// ── Assessment task assignment ────────────────────────────────────────────────

async function loadTaskContext(session: Session, taskId: string, tenantId: string) {
  return runQueryOne<{ changeId: string; ciId: string; role: string; taskProps: Props }>(session, `
    MATCH (c:Change {tenant_id: $tenantId})-[:HAS_ASSESSMENT]->(t:AssessmentTask {id: $taskId})
    RETURN c.id AS changeId, t.ci_id AS ciId, t.responder_role AS role, properties(t) AS taskProps
  `, { taskId, tenantId })
}

export async function assignAssessmentTaskToTeam(
  _: unknown,
  args: { taskId: string; teamId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const tctx = await loadTaskContext(session, args.taskId, ctx.tenantId)
    if (!tctx) throw new GraphQLError(`AssessmentTask ${args.taskId} non trovata`, { extensions: { code: 'NOT_FOUND' } })
    const role = tctx.role === ASSESSMENT_ROLE.SUPPORT ? ASSESSMENT_ROLE.SUPPORT : ASSESSMENT_ROLE.OWNER
    await assertUserInCITeam(session, tctx.ciId, ctx.tenantId, ctx, role)

    await session.executeWrite((tx) => tx.run(`
      MATCH (t:AssessmentTask {id: $taskId, tenant_id: $tenantId})
      MATCH (tm:Team {id: $teamId, tenant_id: $tenantId})
      OPTIONAL MATCH (t)-[oldRel:ASSIGNED_TO_TEAM]->(:Team)
      DELETE oldRel
      WITH t, tm
      CREATE (t)-[:ASSIGNED_TO_TEAM]->(tm)
      WITH t
      OPTIONAL MATCH (t)-[userRel:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (t)-[:ASSIGNED_TO_TEAM]->(newTm:Team)<-[:MEMBER_OF]-(u)
      WITH userRel, newTm
      FOREACH (_ IN CASE WHEN userRel IS NOT NULL AND newTm IS NULL THEN [1] ELSE [] END |
        DELETE userRel
      )
    `, { taskId: args.taskId, teamId: args.teamId, tenantId: ctx.tenantId }))

    const ciName = await getCIName(session, tctx.ciId, ctx.tenantId)
    await writeAudit(session, tctx.changeId, ctx.tenantId, 'assessment_team_assigned', ctx.userId,
      `${ROLE_LABEL[role]} · ${ciName}: team riassegnato`)

    const updated = await runQueryOne<{ props: Props }>(session, `
      MATCH (t:AssessmentTask {id: $taskId}) RETURN properties(t) AS props
    `, { taskId: args.taskId })
    return updated ? mapAssessmentTask(updated.props) : null
  }, true)
}

export async function assignAssessmentTaskToUser(
  _: unknown,
  args: { taskId: string; userId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const tctx = await loadTaskContext(session, args.taskId, ctx.tenantId)
    if (!tctx) throw new GraphQLError(`AssessmentTask ${args.taskId} non trovata`, { extensions: { code: 'NOT_FOUND' } })
    const role = tctx.role === ASSESSMENT_ROLE.SUPPORT ? ASSESSMENT_ROLE.SUPPORT : ASSESSMENT_ROLE.OWNER
    await assertUserInCITeam(session, tctx.ciId, ctx.tenantId, ctx, role)

    const check = await runQueryOne<{ isMember: boolean }>(session, `
      MATCH (t:AssessmentTask {id: $taskId, tenant_id: $tenantId})-[:ASSIGNED_TO_TEAM]->(tm:Team)
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(tm)
      RETURN u IS NOT NULL AS isMember
    `, { taskId: args.taskId, userId: args.userId, tenantId: ctx.tenantId })
    if (!check || !check.isMember) {
      logger.error({ taskId: args.taskId, userId: args.userId },
        '[assignAssessmentTaskToUser] utente non appartiene al team assegnato')
      throw new ForbiddenError('L\'utente non appartiene al team assegnato')
    }

    await session.executeWrite((tx) => tx.run(`
      MATCH (t:AssessmentTask {id: $taskId, tenant_id: $tenantId})
      OPTIONAL MATCH (t)-[old:ASSIGNED_TO]->(:User)
      DELETE old
      WITH t
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      CREATE (t)-[:ASSIGNED_TO]->(u)
    `, { taskId: args.taskId, userId: args.userId, tenantId: ctx.tenantId }))

    const ciName = await getCIName(session, tctx.ciId, ctx.tenantId)
    const userRow = await runQueryOne<{ name: string }>(session, `
      MATCH (u:User {id: $id, tenant_id: $tenantId}) RETURN u.name AS name
    `, { id: args.userId, tenantId: ctx.tenantId })
    await writeAudit(session, tctx.changeId, ctx.tenantId, 'assessment_user_assigned', ctx.userId,
      `${ROLE_LABEL[role]} · ${ciName}: assegnato a ${userRow?.name ?? args.userId}`)

    const updated = await runQueryOne<{ props: Props }>(session, `
      MATCH (t:AssessmentTask {id: $taskId}) RETURN properties(t) AS props
    `, { taskId: args.taskId })
    return updated ? mapAssessmentTask(updated.props) : null
  }, true)
}
