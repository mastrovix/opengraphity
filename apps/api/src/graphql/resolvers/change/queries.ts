import { withSession, runQuery, runQueryOne, getSession, type Props } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import {
  mapChange,
  mapAssessmentTask,
  mapAssessmentQuestion,
  mapAnswerOption,
  mapValidationTest,
  mapDeployPlanTask,
  mapDeploymentTask,
  mapReviewTask,
  mapAuditEntry,
  mapUser,
  mapTeam,
  mapCI,
  toInt,
} from './mappers.js'

type Session = ReturnType<typeof getSession>

function userOrNull(p: Props | null | undefined) {
  return p && p['id'] ? mapUser(p) : null
}

async function loadOptionsForQuestions(session: Session, questionIds: string[]): Promise<Record<string, ReturnType<typeof mapAnswerOption>[]>> {
  if (questionIds.length === 0) return {}
  const rows = await runQuery<{ questionId: string; props: Props }>(session, `
    UNWIND $ids AS qid
    MATCH (q:AssessmentQuestion {id: qid})-[:HAS_OPTION]->(o:AnswerOption)
    RETURN qid AS questionId, properties(o) AS props
    ORDER BY o.sort_order
  `, { ids: questionIds })
  const map: Record<string, ReturnType<typeof mapAnswerOption>[]> = {}
  for (const r of rows) {
    if (!map[r.questionId]) map[r.questionId] = []
    map[r.questionId]!.push(mapAnswerOption(r.props))
  }
  return map
}

type TaskResponses = Array<{
  question: ReturnType<typeof mapAssessmentQuestion>
  selectedOption: ReturnType<typeof mapAnswerOption>
  answeredBy: ReturnType<typeof mapUser> | null
  answeredAt: string
}>

async function loadResponsesForTasks(session: Session, taskIds: string[]): Promise<Record<string, TaskResponses>> {
  if (taskIds.length === 0) return {}
  const rows = await runQuery<{ taskId: string; respId: string; questionProps: Props; optionProps: Props; answeredAt: string; userProps: Props | null }>(session, `
    UNWIND $taskIds AS tid
    MATCH (t:AssessmentTask {id: tid})-[:HAS_RESPONSE]->(resp:AssessmentResponse)-[:ANSWERS]->(q:AssessmentQuestion),
          (resp)-[:SELECTED]->(opt:AnswerOption)
    OPTIONAL MATCH (resp)-[:ANSWERED_BY]->(u:User)
    RETURN DISTINCT tid AS taskId,
           resp.id AS respId,
           properties(q) AS questionProps,
           properties(opt) AS optionProps,
           resp.answered_at AS answeredAt,
           properties(u) AS userProps
  `, { taskIds })
  const map: Record<string, TaskResponses> = {}
  const seen = new Set<string>()
  for (const r of rows) {
    const key = `${r.taskId}:${r.respId}`
    if (seen.has(key)) continue
    seen.add(key)
    if (!map[r.taskId]) map[r.taskId] = []
    map[r.taskId]!.push({
      question:       { ...mapAssessmentQuestion(r.questionProps), options: [] },
      selectedOption: mapAnswerOption(r.optionProps),
      answeredBy:     userOrNull(r.userProps),
      answeredAt:     r.answeredAt,
    })
  }
  return map
}

async function loadCompletedByForTasks(session: Session, taskIds: string[]): Promise<Record<string, ReturnType<typeof mapUser>>> {
  if (taskIds.length === 0) return {}
  const rows = await runQuery<{ taskId: string; userProps: Props }>(session, `
    UNWIND $taskIds AS tid
    MATCH (t:AssessmentTask {id: tid})-[:COMPLETED_BY]->(u:User)
    RETURN tid AS taskId, properties(u) AS userProps
  `, { taskIds })
  const map: Record<string, ReturnType<typeof mapUser>> = {}
  for (const r of rows) map[r.taskId] = mapUser(r.userProps)
  return map
}

async function loadAssignmentsForTasks(session: Session, taskIds: string[]): Promise<{
  teams: Record<string, ReturnType<typeof mapTeam>>
  users: Record<string, ReturnType<typeof mapUser>>
}> {
  if (taskIds.length === 0) return { teams: {}, users: {} }
  const teamRows = await runQuery<{ taskId: string; teamProps: Props }>(session, `
    UNWIND $taskIds AS tid
    MATCH (t:AssessmentTask {id: tid})-[:ASSIGNED_TO_TEAM]->(tm:Team)
    RETURN tid AS taskId, properties(tm) AS teamProps
  `, { taskIds })
  const userRows = await runQuery<{ taskId: string; userProps: Props }>(session, `
    UNWIND $taskIds AS tid
    MATCH (t:AssessmentTask {id: tid})-[:ASSIGNED_TO]->(u:User)
    RETURN tid AS taskId, properties(u) AS userProps
  `, { taskIds })
  const teams: Record<string, ReturnType<typeof mapTeam>> = {}
  const users: Record<string, ReturnType<typeof mapUser>> = {}
  for (const r of teamRows) teams[r.taskId] = mapTeam(r.teamProps)
  for (const r of userRows) users[r.taskId] = mapUser(r.userProps)
  return { teams, users }
}

export async function changes(_: unknown, args: { currentStep?: string; limit?: number; offset?: number }, ctx: GraphQLContext) {
  const limit  = args.limit  ?? 50
  const offset = args.offset ?? 0
  return withSession(async (session) => {
    const joinWF = args.currentStep
      ? 'MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {current_step: $currentStep})'
      : ''
    const items = await runQuery<{
      props: Props
      reqUser: Props | null
      ownerUser: Props | null
      appUser: Props | null
    }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})
      ${joinWF}
      OPTIONAL MATCH (c)-[:REQUESTED_BY]->(req:User)
      OPTIONAL MATCH (c)-[:OWNED_BY]->(owner:User)
      OPTIONAL MATCH (c)-[:APPROVED_BY]->(app:User)
      RETURN properties(c) AS props,
             properties(req)   AS reqUser,
             properties(owner) AS ownerUser,
             properties(app)   AS appUser
      ORDER BY c.created_at DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
    `, { tenantId: ctx.tenantId, currentStep: args.currentStep ?? null, limit, offset })

    const countRows = await runQuery<{ total: unknown }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})
      ${joinWF}
      RETURN count(c) AS total
    `, { tenantId: ctx.tenantId, currentStep: args.currentStep ?? null })

    return {
      items: items.map((r) => ({
        ...mapChange(r.props),
        requester:   userOrNull(r.reqUser),
        changeOwner: userOrNull(r.ownerUser),
        approvalBy:  userOrNull(r.appUser),
      })),
      total: toInt(countRows[0]?.total),
    }
  })
}

export async function change(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const row = await runQueryOne<{
      props: Props
      reqUser: Props | null
      ownerUser: Props | null
      appUser: Props | null
    }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (c)-[:REQUESTED_BY]->(req:User)
      OPTIONAL MATCH (c)-[:OWNED_BY]->(owner:User)
      OPTIONAL MATCH (c)-[:APPROVED_BY]->(app:User)
      RETURN properties(c) AS props,
             properties(req)   AS reqUser,
             properties(owner) AS ownerUser,
             properties(app)   AS appUser
    `, { id: args.id, tenantId: ctx.tenantId })
    if (!row) return null
    return {
      ...mapChange(row.props),
      requester:   userOrNull(row.reqUser),
      changeOwner: userOrNull(row.ownerUser),
      approvalBy:  userOrNull(row.appUser),
    }
  })
}

export async function changeAffectedCIs(_: unknown, args: { changeId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{
      ciProps: Props
      ciLabel: string
      ciPhase: string
      riskScore: unknown
      ownerTask: Props | null
      supportTask: Props | null
      deployPlan: Props | null
      validation: Props | null
      deployment: Props | null
      review: Props | null
    }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->(ci)
      WHERE ci.tenant_id = $tenantId
      OPTIONAL MATCH (c)-[:HAS_ASSESSMENT]->(ownerT:AssessmentTask)
        WHERE ownerT.ci_id = ci.id AND ownerT.responder_role = 'owner'
      OPTIONAL MATCH (c)-[:HAS_ASSESSMENT]->(supportT:AssessmentTask)
        WHERE supportT.ci_id = ci.id AND supportT.responder_role = 'support'
      OPTIONAL MATCH (c)-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask) WHERE dp.ci_id = ci.id
      OPTIONAL MATCH (c)-[:HAS_VALIDATION]->(vt:ValidationTest) WHERE vt.ci_id = ci.id
      OPTIONAL MATCH (c)-[:HAS_DEPLOYMENT]->(dt:DeploymentTask) WHERE dt.ci_id = ci.id
      OPTIONAL MATCH (c)-[:HAS_REVIEW]->(rv:ReviewTask) WHERE rv.ci_id = ci.id
      RETURN properties(ci) AS ciProps, labels(ci)[0] AS ciLabel,
             coalesce(r.ci_phase, 'assessment') AS ciPhase,
             r.risk_score AS riskScore,
             properties(ownerT)  AS ownerTask,
             properties(supportT) AS supportTask,
             properties(dp) AS deployPlan,
             properties(vt) AS validation,
             properties(dt) AS deployment,
             properties(rv) AS review
      ORDER BY ci.name
    `, { changeId: args.changeId, tenantId: ctx.tenantId })

    // Collect IDs of assessment tasks and deploy plan tasks for batch loading
    const assessTaskIds: string[] = []
    const planTaskIds: string[] = []
    for (const r of rows) {
      if (r.ownerTask && r.ownerTask['id']) assessTaskIds.push(r.ownerTask['id'] as string)
      if (r.supportTask && r.supportTask['id']) assessTaskIds.push(r.supportTask['id'] as string)
      if (r.deployPlan && r.deployPlan['id']) planTaskIds.push(r.deployPlan['id'] as string)
    }
    const allTaskIds = [...assessTaskIds, ...planTaskIds]
    const responsesByTask = await loadResponsesForTasks(session, assessTaskIds)
    const completedByMap  = await loadCompletedByForTasks(session, allTaskIds)
    const assignments     = await loadAssignmentsForTasks(session, allTaskIds)

    return rows.map((r) => {
      r.ciProps['type'] = r.ciProps['type'] as string | undefined ?? r.ciLabel.toLowerCase()
      const buildAssessTask = (t: Props | null) => {
        if (!t || !t['id']) return null
        const id = t['id'] as string
        return {
          ...mapAssessmentTask(t),
          responses:    responsesByTask[id] ?? [],
          completedBy:  completedByMap[id]  ?? null,
          assignedTeam: assignments.teams[id] ?? null,
          assignee:     assignments.users[id] ?? null,
        }
      }
      const buildDeployPlan = (t: Props | null) => {
        if (!t || !t['id']) return null
        const id = t['id'] as string
        return {
          ...mapDeployPlanTask(t),
          completedBy:  completedByMap[id]  ?? null,
          assignedTeam: assignments.teams[id] ?? null,
          assignee:     assignments.users[id] ?? null,
        }
      }
      return {
        ci:                mapCI(r.ciProps),
        ciPhase:           r.ciPhase,
        riskScore:         r.riskScore != null ? toInt(r.riskScore) : null,
        assessmentOwner:   buildAssessTask(r.ownerTask),
        assessmentSupport: buildAssessTask(r.supportTask),
        deployPlan:        buildDeployPlan(r.deployPlan),
        validation:        r.validation ? mapValidationTest(r.validation) : null,
        deployment:        r.deployment ? mapDeploymentTask(r.deployment) : null,
        review:            r.review     ? mapReviewTask(r.review) : null,
      }
    })
  })
}

export async function changeAuditTrail(_: unknown, args: { changeId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props; userProps: Props | null }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_AUDIT]->(e:ChangeAuditEntry)
      OPTIONAL MATCH (e)-[:BY]->(u:User)
      RETURN properties(e) AS props, properties(u) AS userProps
      ORDER BY e.timestamp DESC
    `, { changeId: args.changeId, tenantId: ctx.tenantId })
    return rows.map((r) => ({
      ...mapAuditEntry(r.props),
      actor: userOrNull(r.userProps),
    }))
  })
}

export async function assessmentQuestionCatalog(_: unknown, args: { category?: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const where = args.category ? 'AND q.category = $category' : ''
    const rows = await runQuery<{ questionProps: Props; weight: unknown; sortOrder: unknown }>(session, `
      MATCH (q:AssessmentQuestion {tenant_id: $tenantId, is_active: true, is_core: true})
      WHERE 1=1 ${where}
      OPTIONAL MATCH (:CITypeDefinition {active: true, scope: 'base'})-[rel:HAS_QUESTION]->(q)
      WITH q, avg(rel.weight) AS weight, min(rel.sort_order) AS sortOrder
      RETURN properties(q) AS questionProps, weight, sortOrder
      ORDER BY sortOrder, q.created_at
    `, { tenantId: ctx.tenantId, category: args.category ?? null })
    const questionIds = rows.map(r => r.questionProps['id'] as string)
    const optsMap = await loadOptionsForQuestions(session, questionIds)
    return rows.map((r) => ({
      question:  { ...mapAssessmentQuestion(r.questionProps), options: optsMap[r.questionProps['id'] as string] ?? [] },
      weight:    toInt(r.weight, 1),
      sortOrder: toInt(r.sortOrder, 0),
    }))
  })
}

export async function assessmentQuestionsAdmin(_: unknown, __: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (q:AssessmentQuestion {tenant_id: $tenantId})
      RETURN properties(q) AS props
      ORDER BY q.category, q.created_at
    `, { tenantId: ctx.tenantId })
    const questionIds = rows.map(r => r.props['id'] as string)
    const optsMap = await loadOptionsForQuestions(session, questionIds)
    return rows.map((r) => ({
      ...mapAssessmentQuestion(r.props),
      options: optsMap[r.props['id'] as string] ?? [],
    }))
  })
}

type MyTaskRow = {
  id:         string
  code:       string
  kind:       string
  role:       string
  action:     string
  status:     string
  changeId:   string
  changeCode: string
  ciId:       string
  ciName:     string
  phase:      string
  createdAt:  string
}

const ASSESSMENT_ACTIVE = "['pending','in-progress']"

export async function myTasks(_: unknown, __: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const params = { userId: ctx.userId, tenantId: ctx.tenantId }

    // ── Assigned to me: AssessmentTask con ASSIGNED_TO → user ──────────────────
    const assignedAssessRows = await runQuery<Omit<MyTaskRow, 'kind' | 'action'>>(session, `
      MATCH (t:AssessmentTask)-[:ASSIGNED_TO]->(u:User {id: $userId, tenant_id: $tenantId})
      WHERE t.tenant_id = $tenantId AND t.status IN ${ASSESSMENT_ACTIVE}
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_ASSESSMENT]->(t)
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      MATCH (ci {id: t.ci_id, tenant_id: $tenantId})
      RETURN DISTINCT
        t.id             AS id,
        coalesce(t.code, '') AS code,
        t.responder_role AS role,
        t.status         AS status,
        c.id             AS changeId,
        c.code           AS changeCode,
        ci.id            AS ciId,
        ci.name          AS ciName,
        wi.current_step  AS phase,
        t.created_at     AS createdAt
    `, params)

    // ── Unassigned: AssessmentTask del team del user, NO ASSIGNED_TO ──────────
    const unassignedAssessRows = await runQuery<Omit<MyTaskRow, 'kind' | 'action'>>(session, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(team:Team)<-[:ASSIGNED_TO_TEAM]-(t:AssessmentTask)
      WHERE t.tenant_id = $tenantId
        AND t.status IN ${ASSESSMENT_ACTIVE}
        AND NOT (t)-[:ASSIGNED_TO]->()
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_ASSESSMENT]->(t)
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      MATCH (ci {id: t.ci_id, tenant_id: $tenantId})
      RETURN DISTINCT
        t.id             AS id,
        coalesce(t.code, '') AS code,
        t.responder_role AS role,
        t.status         AS status,
        c.id             AS changeId,
        c.code           AS changeCode,
        ci.id            AS ciId,
        ci.name          AS ciName,
        wi.current_step  AS phase,
        t.created_at     AS createdAt
    `, params)

    // ── Unassigned: ValidationTest — OWNED_BY team, step deployment ───────────
    const valRows = await runQuery<Omit<MyTaskRow, 'kind' | 'role' | 'action'>>(session, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(team:Team)
      MATCH (ci)-[:OWNED_BY]->(team)
      WHERE ci.tenant_id = $tenantId
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_VALIDATION]->(vt:ValidationTest)
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      WHERE vt.ci_id = ci.id
        AND vt.status IN ${ASSESSMENT_ACTIVE}
      RETURN DISTINCT
        vt.id          AS id,
        coalesce(vt.code, '') AS code,
        vt.status      AS status,
        c.id           AS changeId,
        c.code         AS changeCode,
        ci.id          AS ciId,
        ci.name        AS ciName,
        wi.current_step AS phase,
        vt.created_at  AS createdAt
    `, params)

    // ── Assigned to me: DeployPlanTask ────────────────────────────────────────
    const assignedPlanRows = await runQuery<Omit<MyTaskRow, 'kind' | 'role' | 'action'>>(session, `
      MATCH (dp:DeployPlanTask)-[:ASSIGNED_TO]->(u:User {id: $userId, tenant_id: $tenantId})
      WHERE dp.tenant_id = $tenantId AND dp.status IN ${ASSESSMENT_ACTIVE}
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_DEPLOY_PLAN]->(dp)
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      MATCH (ci {id: dp.ci_id, tenant_id: $tenantId})
      RETURN DISTINCT
        dp.id          AS id,
        coalesce(dp.code, '') AS code,
        dp.status      AS status,
        c.id           AS changeId,
        c.code         AS changeCode,
        ci.id          AS ciId,
        ci.name        AS ciName,
        wi.current_step AS phase,
        dp.created_at  AS createdAt
    `, params)

    // ── Unassigned: DeployPlanTask ────────────────────────────────────────────
    const unassignedPlanRows = await runQuery<Omit<MyTaskRow, 'kind' | 'role' | 'action'>>(session, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(team:Team)<-[:ASSIGNED_TO_TEAM]-(dp:DeployPlanTask)
      WHERE dp.tenant_id = $tenantId
        AND dp.status IN ${ASSESSMENT_ACTIVE}
        AND NOT (dp)-[:ASSIGNED_TO]->()
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_DEPLOY_PLAN]->(dp)
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      MATCH (ci {id: dp.ci_id, tenant_id: $tenantId})
      RETURN DISTINCT
        dp.id          AS id,
        coalesce(dp.code, '') AS code,
        dp.status      AS status,
        c.id           AS changeId,
        c.code         AS changeCode,
        ci.id          AS ciId,
        ci.name        AS ciName,
        wi.current_step AS phase,
        dp.created_at  AS createdAt
    `, params)

    // ── Unassigned: DeploymentTask — SUPPORTED_BY team, step deployment ──────
    const depRows = await runQuery<Omit<MyTaskRow, 'kind' | 'role' | 'action'>>(session, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(team:Team)
      MATCH (ci)-[:SUPPORTED_BY]->(team)
      WHERE ci.tenant_id = $tenantId
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_DEPLOYMENT]->(dt:DeploymentTask)
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      WHERE dt.ci_id = ci.id
        AND dt.status IN ${ASSESSMENT_ACTIVE}
      RETURN DISTINCT
        dt.id          AS id,
        coalesce(dt.code, '') AS code,
        dt.status      AS status,
        c.id           AS changeId,
        c.code         AS changeCode,
        ci.id          AS ciId,
        ci.name        AS ciName,
        wi.current_step AS phase,
        dt.created_at  AS createdAt
    `, params)

    // ── Unassigned: ReviewTask — OWNED_BY team, step review ──────────────────
    const revRows = await runQuery<Omit<MyTaskRow, 'kind' | 'role' | 'action'>>(session, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(team:Team)
      MATCH (ci)-[:OWNED_BY]->(team)
      WHERE ci.tenant_id = $tenantId
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_REVIEW]->(rv:ReviewTask)
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      WHERE rv.ci_id = ci.id
        AND rv.status IN ${ASSESSMENT_ACTIVE}
      RETURN DISTINCT
        rv.id          AS id,
        coalesce(rv.code, '') AS code,
        rv.status      AS status,
        c.id           AS changeId,
        c.code         AS changeCode,
        ci.id          AS ciId,
        ci.name        AS ciName,
        wi.current_step AS phase,
        rv.created_at  AS createdAt
    `, params)

    const assessmentAction = (role: string) => role === 'owner'
      ? 'Compila assessment Functional'
      : 'Compila assessment Technical'

    const assignedToMe: MyTaskRow[] = [
      ...assignedAssessRows.map((r) => ({
        ...r,
        kind:   'assessment',
        action: assessmentAction(r.role),
      })),
      ...assignedPlanRows.map((r) => ({
        ...r,
        kind:   'deploy-plan',
        role:   'support',
        action: 'Compila piano di deploy',
      })),
    ]

    const unassigned: MyTaskRow[] = [
      ...unassignedAssessRows.map((r) => ({
        ...r,
        kind:   'assessment',
        action: assessmentAction(r.role),
      })),
      ...unassignedPlanRows.map((r) => ({
        ...r,
        kind:   'deploy-plan',
        role:   'support',
        action: 'Compila piano di deploy',
      })),
      ...valRows.map((r) => ({
        ...r,
        kind:   'validation',
        role:   'owner',
        action: 'Esegui validation (Pass/Fail)',
      })),
      ...depRows.map((r) => ({
        ...r,
        kind:   'deployment',
        role:   'support',
        action: 'Conferma il deploy',
      })),
      ...revRows.map((r) => ({
        ...r,
        kind:   'review',
        role:   'owner',
        action: 'Conferma l\'esito (Confirmed/Rejected)',
      })),
    ]

    assignedToMe.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    unassigned.sort((a, b)   => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))

    return { assignedToMe, unassigned }
  })
}

export async function changeImpactedCIs(_: unknown, args: { changeId: string; depth?: number }, ctx: GraphQLContext) {
  const depth = Math.max(1, Math.min(args.depth ?? 1, 5))
  return withSession(async (session) => {
    const rows = await runQuery<{
      impactedProps: Props; impactedLabel: string
      affectedProps: Props; affectedLabel: string
      distance: unknown; pathNames: string[]
    }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(affected)
      WHERE affected.tenant_id = $tenantId
      MATCH path = (impacted)-[:DEPENDS_ON|HOSTED_ON|USES_CERTIFICATE*1..${depth}]->(affected)
      WHERE impacted.tenant_id = $tenantId
        AND NOT (c)-[:AFFECTS_CI]->(impacted)
      WITH impacted, affected, path, length(path) AS dist
      ORDER BY dist ASC
      WITH impacted, affected,
           collect(path)[0] AS bestPath,
           min(dist) AS distance
      WITH impacted, affected, bestPath, distance
      RETURN DISTINCT
        properties(impacted) AS impactedProps, labels(impacted)[0] AS impactedLabel,
        properties(affected) AS affectedProps, labels(affected)[0] AS affectedLabel,
        distance,
        [n IN nodes(bestPath) | n.name] AS pathNames
      ORDER BY distance ASC, impactedProps.name ASC
    `, { changeId: args.changeId, tenantId: ctx.tenantId })

    return rows.map((r) => {
      r.impactedProps['type'] = r.impactedProps['type'] as string | undefined ?? r.impactedLabel.toLowerCase()
      r.affectedProps['type'] = r.affectedProps['type'] as string | undefined ?? r.affectedLabel.toLowerCase()
      return {
        ci: mapCI(r.impactedProps),
        distance: toInt(r.distance, 1),
        affectedBy: mapCI(r.affectedProps),
        impactPath: (r.pathNames ?? []).map(String),
      }
    })
  })
}

export async function taskById(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    // Search across all 5 task types by UUID
    const labels: Array<{ label: string; rel: string; kind: string }> = [
      { label: 'AssessmentTask',  rel: 'HAS_ASSESSMENT',  kind: 'assessment'  },
      { label: 'DeployPlanTask',  rel: 'HAS_DEPLOY_PLAN', kind: 'deploy-plan' },
      { label: 'ValidationTest',  rel: 'HAS_VALIDATION',  kind: 'validation'  },
      { label: 'DeploymentTask',  rel: 'HAS_DEPLOYMENT',  kind: 'deployment'  },
      { label: 'ReviewTask',      rel: 'HAS_REVIEW',      kind: 'review'      },
    ]
    for (const { label, rel, kind } of labels) {
      const row = await runQueryOne<{
        taskCode: string
        changeId: string; changeCode: string; changeTitle: string
        changePhase: string; changeDesc: string | null
        ciId: string; ciName: string; ciType: string; ciEnv: string | null
      }>(session, `
        MATCH (c:Change {tenant_id: $tenantId})-[:${rel}]->(t:${label} {id: $id})
        MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        MATCH (ci {id: t.ci_id, tenant_id: $tenantId})
        RETURN coalesce(t.code, '') AS taskCode,
               c.id AS changeId, c.code AS changeCode, c.title AS changeTitle,
               wi.current_step AS changePhase, c.description AS changeDesc,
               ci.id AS ciId, ci.name AS ciName,
               coalesce(ci.type, toLower(labels(ci)[0])) AS ciType,
               ci.environment AS ciEnv
      `, { id: args.id, tenantId: ctx.tenantId })
      if (row) {
        return {
          id:               args.id,
          code:             row.taskCode,
          kind,
          changeId:         row.changeId,
          changeCode:       row.changeCode,
          changeTitle:      row.changeTitle,
          changePhase:      row.changePhase,
          changeDescription: row.changeDesc ?? null,
          ciId:             row.ciId,
          ciName:           row.ciName,
          ciType:           row.ciType,
          ciEnv:            row.ciEnv,
        }
      }
    }
    return null
  })
}

export async function questionCITypeAssignments(_: unknown, args: { questionId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ ciTypeId: string; ciTypeName: string; weight: unknown; sortOrder: unknown }>(session, `
      MATCH (ct:CITypeDefinition {active: true, scope: 'base'})-[rel:HAS_QUESTION]->(q:AssessmentQuestion {id: $questionId, tenant_id: $tenantId})
      RETURN ct.id AS ciTypeId, ct.name AS ciTypeName,
             rel.weight AS weight, rel.sort_order AS sortOrder
      ORDER BY ct.name
    `, { tenantId: ctx.tenantId, questionId: args.questionId })
    return rows.map((r) => ({
      ciTypeId:   r.ciTypeId,
      ciTypeName: r.ciTypeName,
      weight:     toInt(r.weight, 1),
      sortOrder:  toInt(r.sortOrder, 0),
    }))
  })
}
