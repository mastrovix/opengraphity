import { v4 as uuidv4 } from 'uuid'
import { workflowEngine } from '@opengraphity/workflow'
import type { ActionContext } from '@opengraphity/workflow'
import { withSession, runQuery, runQueryOne, getSession, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { logger } from '../../../lib/logger.js'
import {
  mapChange,
  mapAssessmentTask,
  mapValidationTest,
  mapDeployPlanTask,
  mapDeploymentTask,
  mapReviewTask,
  mapUser,
  toInt,
} from './mappers.js'
import { change as getChange } from './queries.js'
import { evaluateAutoTransitions } from './autoTransitions.js'
import { getInitialStepName } from '../../../lib/workflowHelpers.js'

type Session = ReturnType<typeof getSession>

// ── audit helper ───────────────────────────────────────────────────────────────

async function writeAudit(
  session: Session,
  changeId: string,
  tenantId: string,
  action: string,
  actorId: string | null,
  detail: string | null,
) {
  const now = new Date().toISOString()
  await session.executeWrite((tx) => tx.run(`
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    CREATE (e:ChangeAuditEntry {
      id: $id, tenant_id: $tenantId, timestamp: $now,
      action: $action, detail: $detail
    })
    CREATE (c)-[:HAS_AUDIT]->(e)
    WITH e, $actorId AS aid
    OPTIONAL MATCH (u:User {id: aid, tenant_id: $tenantId})
    FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END |
      CREATE (e)-[:BY]->(u)
    )
  `, { changeId, tenantId, id: uuidv4(), now, action, detail, actorId }))
}

async function nextChangeCode(session: Session, tenantId: string): Promise<string> {
  const rows = await runQuery<{ maxNum: unknown }>(session, `
    MATCH (c:Change {tenant_id: $tenantId})
    WHERE c.code STARTS WITH 'CHG'
    WITH max(toInteger(substring(c.code, 3))) AS maxNum
    RETURN coalesce(maxNum, 0) AS maxNum
  `, { tenantId })
  const maxNum = toInt(rows[0]?.maxNum)
  return 'CHG' + String(maxNum + 1).padStart(8, '0')
}

async function getNextTaskCodes(session: Session, tenantId: string, count: number): Promise<string[]> {
  const rows = await runQuery<{ code: string }>(session, `
    MATCH (t)
    WHERE t.tenant_id = $tenantId AND t.code STARTS WITH 'TASK'
    RETURN t.code AS code
    ORDER BY t.code DESC
    LIMIT 1
  `, { tenantId })
  let next = 1
  if (rows.length > 0) {
    const n = parseInt(rows[0]!.code.slice(4), 10)
    if (!isNaN(n)) next = n + 1
  }
  return Array.from({ length: count }, (_, i) => 'TASK' + String(next + i).padStart(8, '0'))
}

async function assertCIHasOwnerAndSupport(session: Session, tenantId: string, ciIds: string[]) {
  const rows = await runQuery<{ id: string; name: string; ownerTeamId: string | null; supportTeamId: string | null }>(session, `
    UNWIND $ciIds AS ciId
    MATCH (ci {id: ciId, tenant_id: $tenantId})
    OPTIONAL MATCH (ci)-[:OWNED_BY]->(ownerT:Team)
    OPTIONAL MATCH (ci)-[:SUPPORTED_BY]->(supportT:Team)
    RETURN ci.id AS id, ci.name AS name,
           ownerT.id AS ownerTeamId,
           supportT.id AS supportTeamId
  `, { ciIds, tenantId })
  for (const r of rows) {
    if (!r.ownerTeamId || !r.supportTeamId) {
      logger.error({ ciId: r.id, ciName: r.name, hasOwner: !!r.ownerTeamId, hasSupport: !!r.supportTeamId },
        '[createChange] CI manca di Owner Group o Support Group')
      throw new Error(`CI ${r.name} manca di Owner Group o Support Group`)
    }
  }
}

async function loadChange(session: Session, changeId: string, tenantId: string): Promise<Props | null> {
  const row = await runQueryOne<{ props: Props }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})
    RETURN properties(c) AS props
  `, { id: changeId, tenantId })
  return row?.props ?? null
}

async function getCIName(session: Session, ciId: string, tenantId: string): Promise<string> {
  const row = await runQueryOne<{ name: string }>(session, `
    MATCH (ci {id: $ciId, tenant_id: $tenantId})
    RETURN coalesce(ci.name, ci.id) AS name
  `, { ciId, tenantId })
  return row?.name ?? ciId
}

async function getQuestionText(session: Session, questionId: string, tenantId: string): Promise<string> {
  const row = await runQueryOne<{ text: string }>(session, `
    MATCH (q:AssessmentQuestion {id: $id, tenant_id: $tenantId})
    RETURN q.text AS text
  `, { id: questionId, tenantId })
  return row?.text ?? questionId
}

async function getAnswerLabel(session: Session, optionId: string): Promise<string> {
  const row = await runQueryOne<{ label: string }>(session, `
    MATCH (o:AnswerOption {id: $id})
    RETURN o.label AS label
  `, { id: optionId })
  return row?.label ?? optionId
}

async function getCurrentStep(session: Session, changeId: string, tenantId: string): Promise<string | null> {
  const row = await runQueryOne<{ step: string }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    RETURN wi.current_step AS step
  `, { id: changeId, tenantId })
  return row?.step ?? null
}

async function getInstanceId(session: Session, changeId: string, tenantId: string): Promise<string> {
  const row = await runQueryOne<{ id: string }>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    RETURN wi.id AS id
  `, { id: changeId, tenantId })
  if (!row) throw new Error(`Change ${changeId} senza WorkflowInstance collegata`)
  return row.id
}

async function assertInitialStep(session: Session, changeId: string, tenantId: string): Promise<Props> {
  const props = await loadChange(session, changeId, tenantId)
  if (!props) throw new Error(`Change ${changeId} non trovato`)
  const current = await getCurrentStep(session, changeId, tenantId)
  const initial = await getInitialStepName(session, tenantId, 'change')
  if (current !== initial) {
    logger.error({ changeId, current, initial }, '[change] operazione permessa solo nello step iniziale')
    throw new Error(`Operazione permessa solo nello step iniziale: step corrente "${current}"`)
  }
  return props
}

/**
 * Verifica che l'utente corrente sia membro dell'Owner Group o del Support Group
 * del CI. Solleva errore "Non autorizzato" altrimenti.
 * Gli utenti con role 'admin' bypassano il check (possono tutto).
 */
async function assertUserInCITeam(
  session: Session,
  ciId: string,
  tenantId: string,
  ctx: GraphQLContext,
  role: 'owner' | 'support',
) {
  if (ctx.role === 'admin') return
  if (!ctx.userId) {
    logger.error({ ciId, role }, '[authz] utente non identificato')
    throw new Error('Non autorizzato: utente non identificato')
  }
  const rel = role === 'owner' ? 'OWNED_BY' : 'SUPPORTED_BY'
  const roleLabel = role === 'owner' ? 'Owner' : 'Support'
  const row = await runQueryOne<{ ok: boolean | null }>(session, `
    MATCH (ci {id: $ciId, tenant_id: $tenantId})-[:${rel}]->(team:Team)
    OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(team)
    RETURN u IS NOT NULL AS ok
  `, { ciId, tenantId, userId: ctx.userId })
  if (!row || !row.ok) {
    logger.error({ userId: ctx.userId, ciId, role, tenantId }, `[authz] user ${ctx.userId} non è nel ${roleLabel} Group del CI ${ciId}`)
    throw new Error(`Non autorizzato: solo il ${roleLabel} Group del CI può eseguire questa azione`)
  }
}

// ── createChange ───────────────────────────────────────────────────────────────

export async function createChange(
  _: unknown,
  args: { input: { title: string; description?: string | null; changeOwner?: string | null; affectedCIIds: string[] } },
  ctx: GraphQLContext,
) {
  const { title, description, changeOwner, affectedCIIds } = args.input
  if (!affectedCIIds || affectedCIIds.length === 0) {
    throw new Error('Un change deve avere almeno un CI impattato')
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
        responder_role: 'owner', status: 'pending', score: null, created_at: $now
      })
      CREATE (c)-[:HAS_ASSESSMENT]->(ownerT)
      CREATE (ownerT)-[:ASSIGNED_TO_TEAM]->(ownerTeam)
      CREATE (supportT:AssessmentTask {
        id: randomUUID(), code: ct.supportCode, tenant_id: $tenantId, ci_id: ci.id,
        responder_role: 'support', status: 'pending', score: null, created_at: $now
      })
      CREATE (c)-[:HAS_ASSESSMENT]->(supportT)
      CREATE (supportT)-[:ASSIGNED_TO_TEAM]->(supportTeam)
      CREATE (dp:DeployPlanTask {
        id: randomUUID(), code: ct.planCode, tenant_id: $tenantId, ci_id: ci.id,
        status: 'pending', steps: '[]',
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
          ownerT.ci_id = $ciId, ownerT.responder_role = 'owner',
          ownerT.status = 'pending', ownerT.score = null, ownerT.created_at = $now
      MERGE (c)-[:HAS_ASSESSMENT]->(ownerT)
      MERGE (ownerT)-[:ASSIGNED_TO_TEAM]->(ownerTeam)
      MERGE (supportT:AssessmentTask {change_key: $changeId + '-' + $ciId + '-support'})
        ON CREATE SET supportT.id = randomUUID(), supportT.code = $supportCode, supportT.tenant_id = $tenantId,
          supportT.ci_id = $ciId, supportT.responder_role = 'support',
          supportT.status = 'pending', supportT.score = null, supportT.created_at = $now
      MERGE (c)-[:HAS_ASSESSMENT]->(supportT)
      MERGE (supportT)-[:ASSIGNED_TO_TEAM]->(supportTeam)
      MERGE (dp:DeployPlanTask {change_key: $changeId + '-' + $ciId + '-deployplan'})
        ON CREATE SET dp.id = randomUUID(), dp.code = $planCode, dp.tenant_id = $tenantId,
          dp.ci_id = $ciId, dp.status = 'pending',
          dp.steps = '[]',
          dp.created_at = $now
      MERGE (c)-[:HAS_DEPLOY_PLAN]->(dp)
      MERGE (dp)-[:ASSIGNED_TO_TEAM]->(supportTeam)
      SET c.updated_at = $now
    `, { changeId: args.changeId, ciId: args.ciId, tenantId: ctx.tenantId, now,
         ownerCode, supportCode, planCode }))

    const ciName = await getCIName(session, args.ciId, ctx.tenantId)
    await writeAudit(session, args.changeId, ctx.tenantId, 'ci_added', ctx.userId, `CI ${ciName} aggiunto`)

    // Return the affected CI entry
    const row = await runQueryOne<{ ciProps: Props; ciLabel: string }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->(ci {id: $ciId})
      RETURN properties(ci) AS ciProps, labels(ci)[0] AS ciLabel
    `, { changeId: args.changeId, ciId: args.ciId, tenantId: ctx.tenantId })
    if (!row) throw new Error('CI non trovato dopo aggiunta')
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

// ── Assessment ────────────────────────────────────────────────────────────────

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
    if (!task) throw new Error(`AssessmentTask ${args.taskId} non trovata`)
    if (task.props['status'] === 'completed') {
      throw new Error('Task già completata, impossibile modificare le risposte')
    }
    const role = task.props['responder_role'] === 'support' ? 'support' : 'owner'
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
      SET t.status = 'in-progress'
    `, { taskId: args.taskId, questionId: args.questionId, optionId: args.optionId,
         tenantId: ctx.tenantId, userId: ctx.userId, now }))

    const ciName   = await getCIName(session, task.props['ci_id'] as string, ctx.tenantId)
    const qText    = await getQuestionText(session, args.questionId, ctx.tenantId)
    const optLabel = await getAnswerLabel(session, args.optionId)
    await writeAudit(session, task.changeId, ctx.tenantId, 'assessment_response_submitted', ctx.userId,
      `${role === 'owner' ? 'Owner' : 'Support'} · ${ciName}: "${qText}" → ${optLabel}`)

    const updated = await runQueryOne<{ props: Props }>(session, `
      MATCH (t:AssessmentTask {id: $taskId}) RETURN properties(t) AS props
    `, { taskId: args.taskId })
    return updated ? mapAssessmentTask(updated.props) : null
  }, true)
}

export async function completeAssessmentTask(_: unknown, args: { taskId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    // Load the task, its CI, its CITypeDefinition (matched by neo4j_label), and the change
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
    if (!ctx1) throw new Error(`AssessmentTask ${args.taskId} non trovata`)
    if (ctx1.taskProps['status'] === 'completed') throw new Error('Task già completata')

    const role = ctx1.taskProps['responder_role'] === 'support' ? 'support' : 'owner'
    await assertUserInCITeam(session, ctx1.ciId, ctx.tenantId, ctx, role)

    const taskCategory = role === 'owner' ? 'functional' : 'technical'

    // Load all questions assigned to this CITypeDefinition for the task's category
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
      throw new Error('Nessuna domanda di assessment assegnata al tipo di CI per la categoria richiesta')
    }

    // Load responses for this task
    const responses = await runQuery<{ questionId: string; score: unknown }>(session, `
      MATCH (t:AssessmentTask {id: $taskId})-[:HAS_RESPONSE]->(resp:AssessmentResponse)-[:ANSWERS]->(q:AssessmentQuestion)
      MATCH (resp)-[:SELECTED]->(opt:AnswerOption)
      RETURN q.id AS questionId, opt.score AS score
    `, { taskId: args.taskId })

    const answered = new Map<string, number>()
    for (const r of responses) answered.set(r.questionId, toInt(r.score))

    // Verify all required questions answered
    const missing = questions.filter(q => !answered.has(q.questionId))
    if (missing.length > 0) {
      throw new Error(`Risposte mancanti: ${missing.length} domande da completare prima di chiudere la task`)
    }

    // Compute weighted score from answered questions
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
    // Applicato con weight 5 sia al numeratore che al denominatore
    // del pool, così il max contribuisce sempre (prod è il peggior caso).
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
      SET t.status = 'completed', t.score = $score, t.completed_at = $now
      WITH t
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END |
        CREATE (t)-[:COMPLETED_BY]->(u)
      )
    `, { taskId: args.taskId, tenantId: ctx.tenantId, score, now, userId: ctx.userId }))

    const ciName1 = await getCIName(session, ctx1.ciId, ctx.tenantId)
    const role1   = ctx1.taskProps['responder_role'] as string
    await writeAudit(session, ctx1.changeId, ctx.tenantId, 'assessment_task_completed', ctx.userId,
      `${role1 === 'owner' ? 'Owner' : 'Support'} · ${ciName1}: score ${score}`)

    // Check if both tasks for this CI are completed; if so, compute CI risk score
    await recomputeCIRiskIfReady(session, ctx1.changeId, ctx1.ciId, ctx.tenantId, ctx.userId)

    // Update aggregate risk + evaluate automatic transitions
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
    if (!tctx) throw new Error(`AssessmentTask ${args.taskId} non trovata`)
    const role = tctx.role === 'support' ? 'support' : 'owner'
    await assertUserInCITeam(session, tctx.ciId, ctx.tenantId, ctx, role)

    await session.executeWrite((tx) => tx.run(`
      MATCH (t:AssessmentTask {id: $taskId, tenant_id: $tenantId})
      MATCH (tm:Team {id: $teamId, tenant_id: $tenantId})
      OPTIONAL MATCH (t)-[oldRel:ASSIGNED_TO_TEAM]->(:Team)
      DELETE oldRel
      WITH t, tm
      CREATE (t)-[:ASSIGNED_TO_TEAM]->(tm)
      WITH t
      // Se l'utente precedentemente assegnato non è nel nuovo team, scollegalo
      OPTIONAL MATCH (t)-[userRel:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (t)-[:ASSIGNED_TO_TEAM]->(newTm:Team)<-[:MEMBER_OF]-(u)
      WITH userRel, newTm
      FOREACH (_ IN CASE WHEN userRel IS NOT NULL AND newTm IS NULL THEN [1] ELSE [] END |
        DELETE userRel
      )
    `, { taskId: args.taskId, teamId: args.teamId, tenantId: ctx.tenantId }))

    const ciName = await getCIName(session, tctx.ciId, ctx.tenantId)
    await writeAudit(session, tctx.changeId, ctx.tenantId, 'assessment_team_assigned', ctx.userId,
      `${role === 'owner' ? 'Owner' : 'Support'} · ${ciName}: team riassegnato`)

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
    if (!tctx) throw new Error(`AssessmentTask ${args.taskId} non trovata`)
    const role = tctx.role === 'support' ? 'support' : 'owner'
    await assertUserInCITeam(session, tctx.ciId, ctx.tenantId, ctx, role)

    // Verify that the target user is MEMBER_OF the team assigned to this task
    const check = await runQueryOne<{ isMember: boolean }>(session, `
      MATCH (t:AssessmentTask {id: $taskId, tenant_id: $tenantId})-[:ASSIGNED_TO_TEAM]->(tm:Team)
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(tm)
      RETURN u IS NOT NULL AS isMember
    `, { taskId: args.taskId, userId: args.userId, tenantId: ctx.tenantId })
    if (!check || !check.isMember) {
      logger.error({ taskId: args.taskId, userId: args.userId },
        '[assignAssessmentTaskToUser] utente non appartiene al team assegnato')
      throw new Error('L\'utente non appartiene al team assegnato')
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
      `${role === 'owner' ? 'Owner' : 'Support'} · ${ciName}: assegnato a ${userRow?.name ?? args.userId}`)

    const updated = await runQueryOne<{ props: Props }>(session, `
      MATCH (t:AssessmentTask {id: $taskId}) RETURN properties(t) AS props
    `, { taskId: args.taskId })
    return updated ? mapAssessmentTask(updated.props) : null
  }, true)
}

async function recomputeCIRiskIfReady(session: Session, changeId: string, ciId: string, tenantId: string, actorId: string | null) {
  const row = await runQueryOne<{ ownerDone: boolean; supportDone: boolean; ownerScore: unknown; supportScore: unknown }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_ASSESSMENT]->(t:AssessmentTask {ci_id: $ciId})
    WITH collect({role: t.responder_role, status: t.status, score: t.score}) AS tasks
    RETURN
      any(x IN tasks WHERE x.role = 'owner'   AND x.status = 'completed') AS ownerDone,
      any(x IN tasks WHERE x.role = 'support' AND x.status = 'completed') AS supportDone,
      [x IN tasks WHERE x.role = 'owner'   | x.score][0] AS ownerScore,
      [x IN tasks WHERE x.role = 'support' | x.score][0] AS supportScore
  `, { changeId, ciId, tenantId })
  if (!row || !row.ownerDone || !row.supportDone) return

  // Pool both: ci risk score = average of the two scores (both contribute equally)
  const os = row.ownerScore != null ? toInt(row.ownerScore) : 0
  const ss = row.supportScore != null ? toInt(row.supportScore) : 0
  const ciRisk = Math.round((os + ss) / 2)

  await session.executeWrite((tx) => tx.run(`
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->(ci {id: $ciId})
    SET r.risk_score = $risk, r.ci_phase = 'assessed'
  `, { changeId, ciId, tenantId, risk: ciRisk }))

  const ciName = await getCIName(session, ciId, tenantId)
  await writeAudit(session, changeId, tenantId, 'ci_risk_computed', actorId, `${ciName}: risk ${ciRisk}`)
}

async function computeAggregateRisk(session: Session, changeId: string, tenantId: string) {
  // Computes aggregate_risk_score and approval_route from the per-CI risk scores.
  // Does NOT change workflow step — transitions are handled by the workflow engine.
  const row = await runQueryOne<{ maxRisk: unknown }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->()
    RETURN max(r.risk_score) AS maxRisk
  `, { changeId, tenantId })
  const maxRisk = row?.maxRisk != null ? toInt(row.maxRisk) : 0
  const approvalRoute =
    maxRisk <= 30 ? 'low' :
    maxRisk <= 60 ? 'medium' :
                    'high'
  await session.executeWrite((tx) => tx.run(`
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    SET c.aggregate_risk_score = $maxRisk,
        c.approval_route       = $route,
        c.updated_at           = $now
  `, { changeId, tenantId, maxRisk, route: approvalRoute, now: new Date().toISOString() }))
}

async function createValidationAndDeploymentTasks(session: Session, changeId: string, tenantId: string) {
  const ciRows = await runQuery<{ ciId: string }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
    RETURN ci.id AS ciId ORDER BY ci.name
  `, { changeId, tenantId })
  if (ciRows.length === 0) return
  const codes = await getNextTaskCodes(session, tenantId, ciRows.length * 2)
  const ciCodes = ciRows.map((r, i) => ({ ciId: r.ciId, valCode: codes[i * 2]!, depCode: codes[i * 2 + 1]! }))
  const now = new Date().toISOString()
  await session.executeWrite((tx) => tx.run(`
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    UNWIND $ciCodes AS cc
    MATCH (c)-[:AFFECTS_CI]->(ci {id: cc.ciId})
    MERGE (vt:ValidationTest {change_key: $changeId + '-' + ci.id})
      ON CREATE SET vt.id = randomUUID(), vt.code = cc.valCode, vt.tenant_id = $tenantId,
        vt.ci_id = ci.id, vt.status = 'pending',
        vt.result = null, vt.tested_at = null, vt.created_at = $now
    MERGE (c)-[:HAS_VALIDATION]->(vt)
    WITH c, ci, cc
    MERGE (dt:DeploymentTask {change_key: $changeId + '-' + ci.id + '-exec'})
      ON CREATE SET dt.id = randomUUID(), dt.code = cc.depCode, dt.tenant_id = $tenantId,
        dt.ci_id = ci.id, dt.status = 'pending',
        dt.created_at = $now
    MERGE (c)-[:HAS_DEPLOYMENT]->(dt)
  `, { changeId, tenantId, now, ciCodes }))
}

async function createReviewTasks(session: Session, changeId: string, tenantId: string) {
  const ciRows = await runQuery<{ ciId: string }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
    RETURN ci.id AS ciId ORDER BY ci.name
  `, { changeId, tenantId })
  if (ciRows.length === 0) return
  const codes = await getNextTaskCodes(session, tenantId, ciRows.length)
  const ciCodes = ciRows.map((r, i) => ({ ciId: r.ciId, code: codes[i]! }))
  const now = new Date().toISOString()
  await session.executeWrite((tx) => tx.run(`
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
    UNWIND $ciCodes AS cc
    MERGE (rv:ReviewTask {change_key: $changeId + '-' + cc.ciId + '-review'})
      ON CREATE SET rv.id = randomUUID(), rv.code = cc.code, rv.tenant_id = $tenantId,
        rv.ci_id = cc.ciId, rv.status = 'pending', rv.created_at = $now
    MERGE (c)-[:HAS_REVIEW]->(rv)
  `, { changeId, tenantId, now, ciCodes }))
}

// Dispatch table for side-effects, keyed by the step's `on_enter_create`
// metadata. Adding a new hook is a one-line addition here — no step names
// appear in mutations / resolvers.
const ON_ENTER_CREATORS: Record<string, (session: Session, changeId: string, tenantId: string) => Promise<void>> = {
  validation_and_deployment: createValidationAndDeploymentTasks,
  review:                    createReviewTasks,
}

/**
 * Side-effects to run immediately after the workflow enters a new step.
 * Reads the step's `on_enter_create` metadata from Neo4j and dispatches
 * to the matching creator. Steps without this metadata are no-ops.
 */
export async function afterEnterStep(session: Session, changeId: string, tenantId: string, stepName: string) {
  const row = await runQueryOne<{ hook: string | null }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    MATCH (wi)-[:CURRENT_STEP]->(step:WorkflowStep)
    WHERE step.name = $stepName
    RETURN step.on_enter_create AS hook
  `, { changeId, tenantId, stepName })
  const hook = row?.hook
  if (!hook) return
  const creator = ON_ENTER_CREATORS[hook]
  if (!creator) {
    logger.warn({ changeId, stepName, hook }, '[afterEnterStep] unknown on_enter_create hook')
    return
  }
  await creator(session, changeId, tenantId)
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
    if (!result.success) throw new Error(result.error ?? 'Transizione fallita')

    await afterEnterStep(session, args.changeId, ctx.tenantId, args.toStep)
    await writeAudit(session, args.changeId, ctx.tenantId,
      `change_transition_${args.toStep}`, ctx.userId, args.notes ?? null)

    // After a manual transition, an automatic transition may now be ready.
    await evaluateAutoTransitions(session, args.changeId, ctx, afterEnterStep)

    return getChange(null, { id: args.changeId }, ctx)
  }, true)
}

export async function completeValidationTest(
  _: unknown,
  args: { changeId: string; ciId: string; result: string },
  ctx: GraphQLContext,
) {
  if (args.result !== 'pass' && args.result !== 'fail') {
    throw new Error('result deve essere "pass" o "fail"')
  }
  return withSession(async (session) => {
    await assertUserInCITeam(session, args.ciId, ctx.tenantId, ctx, 'owner')
    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_VALIDATION]->(vt:ValidationTest {ci_id: $ciId})
      SET vt.status = 'completed', vt.result = $result, vt.tested_at = $now
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

    // Evaluate automatic transitions (e.g. deployment → review)
    await evaluateAutoTransitions(session, args.changeId, ctx, afterEnterStep)

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (:Change {id: $changeId})-[:HAS_VALIDATION]->(vt:ValidationTest {ci_id: $ciId})
      RETURN properties(vt) AS props
    `, { changeId: args.changeId, ciId: args.ciId })
    return row ? mapValidationTest(row.props) : null
  }, true)
}

// ── Deploy Plan ───────────────────────────────────────────────────────────────

type TimeWindowInput = { start: string; end: string }
type DeployStepInput = { title: string; validationWindow: TimeWindowInput; releaseWindow: TimeWindowInput }

function validateWindow(label: string, w: TimeWindowInput) {
  if (!w || !w.start || !w.end) throw new Error(`${label}: start e end obbligatori`)
  if (new Date(w.start).getTime() >= new Date(w.end).getTime()) {
    throw new Error(`${label}: end deve essere dopo start`)
  }
}

function validateStep(idx: number, s: DeployStepInput) {
  if (!s.title || !s.title.trim()) throw new Error(`Step ${idx + 1}: titolo obbligatorio`)
  validateWindow(`Step ${idx + 1} — finestra di validazione`, s.validationWindow)
  validateWindow(`Step ${idx + 1} — finestra di deploy`, s.releaseWindow)
}

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
    if (!tctx) throw new Error(`DeployPlanTask ${args.taskId} non trovata`)
    if (tctx.status === 'completed') throw new Error('Task già completata')
    const initialStepName = await getInitialStepName(session, ctx.tenantId, 'change')
    if (tctx.currentStep !== initialStepName) throw new Error(`Piano deploy editabile solo nello step iniziale (${initialStepName})`)
    await assertUserInCITeam(session, tctx.ciId, ctx.tenantId, ctx, 'support')
    if (!Array.isArray(args.steps) || args.steps.length < 1) throw new Error('Almeno 1 step obbligatorio')
    args.steps.forEach((s, i) => validateStep(i, s))

    const normalized = args.steps.map(s => ({
      title: s.title.trim(),
      validationWindow: { start: s.validationWindow.start, end: s.validationWindow.end },
      releaseWindow:    { start: s.releaseWindow.start,    end: s.releaseWindow.end    },
    }))

    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (dp:DeployPlanTask {id: $taskId, tenant_id: $tenantId})
      SET dp.steps = $steps, dp.status = 'in-progress'
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

export async function completeDeployPlanTask(_: unknown, args: { taskId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const tctx = await runQueryOne<{ ciId: string; changeId: string; status: string; steps: string | null }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask {id: $taskId})
      RETURN dp.ci_id AS ciId, c.id AS changeId, dp.status AS status, dp.steps AS steps
    `, { taskId: args.taskId, tenantId: ctx.tenantId })
    if (!tctx) throw new Error(`DeployPlanTask ${args.taskId} non trovata`)
    if (tctx.status === 'completed') throw new Error('Task già completata')
    await assertUserInCITeam(session, tctx.ciId, ctx.tenantId, ctx, 'support')

    const steps = tctx.steps ? JSON.parse(tctx.steps) as unknown[] : []
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('Almeno 1 step deve essere compilato prima di completare')
    }

    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (dp:DeployPlanTask {id: $taskId, tenant_id: $tenantId})
      SET dp.status = 'completed', dp.completed_at = $now
      WITH dp
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NULL THEN [] ELSE [1] END |
        CREATE (dp)-[:COMPLETED_BY]->(u)
      )
    `, { taskId: args.taskId, tenantId: ctx.tenantId, now, userId: ctx.userId }))

    const ciName = await getCIName(session, tctx.ciId, ctx.tenantId)
    await writeAudit(session, tctx.changeId, ctx.tenantId, 'deploy_plan_completed', ctx.userId,
      `${ciName}: piano completato (${steps.length} step)`)

    // Update aggregate risk + evaluate automatic transitions
    await computeAggregateRisk(session, tctx.changeId, ctx.tenantId)
    await evaluateAutoTransitions(session, tctx.changeId, ctx, afterEnterStep)

    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (dp:DeployPlanTask {id: $taskId}) RETURN properties(dp) AS props
    `, { taskId: args.taskId })
    return row ? mapDeployPlanTask(row.props) : null
  }, true)
}

// ── Deployment ────────────────────────────────────────────────────────────────

export async function completeDeployment(_: unknown, args: { changeId: string; ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    await assertUserInCITeam(session, args.ciId, ctx.tenantId, ctx, 'support')
    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_DEPLOYMENT]->(dt:DeploymentTask {ci_id: $ciId})
      SET dt.status = 'completed', dt.deployed_at = $now
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

// ── Review ────────────────────────────────────────────────────────────────────

export async function completeReview(
  _: unknown,
  args: { changeId: string; ciId: string; result: string },
  ctx: GraphQLContext,
) {
  if (args.result !== 'confirmed' && args.result !== 'rejected') {
    throw new Error('result deve essere "confirmed" o "rejected"')
  }
  return withSession(async (session) => {
    await assertUserInCITeam(session, args.ciId, ctx.tenantId, ctx, 'owner')
    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_REVIEW]->(rv:ReviewTask {ci_id: $ciId})
      SET rv.status = 'completed', rv.result = $result, rv.reviewed_at = $now
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

// ── Reopen task (admin only) ──────────────────────────────────────────────────

function assertAdmin(ctx: GraphQLContext) {
  if (ctx.role !== 'admin') {
    logger.error({ userId: ctx.userId, role: ctx.role }, '[authz] reopen tentativo non-admin')
    throw new Error('Solo gli admin possono riaprire task')
  }
}

export async function reopenAssessmentTask(_: unknown, args: { taskId: string; reason: string }, ctx: GraphQLContext) {
  assertAdmin(ctx)
  return withSession(async (session) => {
    const tctx = await runQueryOne<{ changeId: string; ciId: string; role: string }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_ASSESSMENT]->(t:AssessmentTask {id: $taskId})
      RETURN c.id AS changeId, t.ci_id AS ciId, t.responder_role AS role
    `, { taskId: args.taskId, tenantId: ctx.tenantId })
    if (!tctx) throw new Error(`AssessmentTask ${args.taskId} non trovata`)

    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (t:AssessmentTask {id: $taskId, tenant_id: $tenantId})
      SET t.status = 'in-progress', t.score = null, t.completed_at = null
      WITH t
      OPTIONAL MATCH (t)-[r:COMPLETED_BY]->()
      DELETE r
    `, { taskId: args.taskId, tenantId: ctx.tenantId }))

    // Reset CI risk score
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->(ci {id: $ciId})
      SET r.risk_score = null
    `, { changeId: tctx.changeId, ciId: tctx.ciId, tenantId: ctx.tenantId }))

    // Reset aggregate risk & approval metadata — workflow rollback is up to the admin
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

export async function reopenDeployPlanTask(_: unknown, args: { taskId: string; reason: string }, ctx: GraphQLContext) {
  assertAdmin(ctx)
  return withSession(async (session) => {
    const tctx = await runQueryOne<{ changeId: string; ciId: string }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask {id: $taskId})
      RETURN c.id AS changeId, dp.ci_id AS ciId
    `, { taskId: args.taskId, tenantId: ctx.tenantId })
    if (!tctx) throw new Error(`DeployPlanTask ${args.taskId} non trovata`)

    const now = new Date().toISOString()
    await session.executeWrite((tx) => tx.run(`
      MATCH (dp:DeployPlanTask {id: $taskId, tenant_id: $tenantId})
      SET dp.status = 'in-progress', dp.completed_at = null
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

export async function reopenValidationTest(_: unknown, args: { id: string; reason: string }, ctx: GraphQLContext) {
  assertAdmin(ctx)
  return withSession(async (session) => {
    const tctx = await runQueryOne<{ changeId: string; ciId: string }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_VALIDATION]->(vt:ValidationTest {id: $id})
      RETURN c.id AS changeId, vt.ci_id AS ciId
    `, { id: args.id, tenantId: ctx.tenantId })
    if (!tctx) throw new Error(`ValidationTest ${args.id} non trovata`)

    await session.executeWrite((tx) => tx.run(`
      MATCH (vt:ValidationTest {id: $id, tenant_id: $tenantId})
      SET vt.status = 'pending', vt.result = null, vt.tested_at = null
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

export async function reopenDeploymentTask(_: unknown, args: { id: string; reason: string }, ctx: GraphQLContext) {
  assertAdmin(ctx)
  return withSession(async (session) => {
    const tctx = await runQueryOne<{ changeId: string; ciId: string }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_DEPLOYMENT]->(dt:DeploymentTask {id: $id})
      RETURN c.id AS changeId, dt.ci_id AS ciId
    `, { id: args.id, tenantId: ctx.tenantId })
    if (!tctx) throw new Error(`DeploymentTask ${args.id} non trovata`)

    await session.executeWrite((tx) => tx.run(`
      MATCH (dt:DeploymentTask {id: $id, tenant_id: $tenantId})
      SET dt.status = 'pending', dt.deployed_at = null
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

export async function reopenReviewTask(_: unknown, args: { id: string; reason: string }, ctx: GraphQLContext) {
  assertAdmin(ctx)
  return withSession(async (session) => {
    const tctx = await runQueryOne<{ changeId: string; ciId: string }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_REVIEW]->(rv:ReviewTask {id: $id})
      RETURN c.id AS changeId, rv.ci_id AS ciId
    `, { id: args.id, tenantId: ctx.tenantId })
    if (!tctx) throw new Error(`ReviewTask ${args.id} non trovata`)

    await session.executeWrite((tx) => tx.run(`
      MATCH (rv:ReviewTask {id: $id, tenant_id: $tenantId})
      SET rv.status = 'pending', rv.result = null, rv.reviewed_at = null
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

// unused export to satisfy tree-shake but keep symbols
export const __touch = { mapUser }
