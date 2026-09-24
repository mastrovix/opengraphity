import { withSession, runQuery, runQueryOne, getSession, type Props } from '../ci-utils.js'
import { ciTypeFromLabels } from '../../../lib/ciTypeFromLabels.js'
import type { GraphQLContext } from '../../../context.js'
import { TASK_STATUS, ASSESSMENT_ROLE } from '../../../lib/taskStatus.js'
import { TASK_STATE } from '../../../lib/ticketTasks.js'
import { PERMESSO_LETTURA } from '../ticketTasks.js'
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
} from './mappers.js'
import { toNumber } from '@opengraphity/neo4j'
import { listPage } from '../../../lib/listLimit.js'
import { buildAdvancedWhere } from '../../../lib/filterBuilder.js'
import { getScalarFields } from '../../../lib/schemaFields.js'
import type { GraphQLResolveInfo } from 'graphql'
import { serviceRelPatternForTenant } from '../../../lib/ciMetamodelForTenant.js'
import { ValidationError } from '../../../lib/errors.js'
import { matchById } from '../../../lib/cypherLookups.js'

type Session = ReturnType<typeof getSession>

function userOrNull(p: Props | null | undefined) {
  return p && p['id'] ? mapUser(p) : null
}

async function loadOptionsForQuestions(session: Session, questionIds: string[]): Promise<Record<string, ReturnType<typeof mapAnswerOption>[]>> {
  if (questionIds.length === 0) return {}
  const rows = await runQuery<{ questionId: string; props: Props }>(session, `
    UNWIND $ids AS qid
    // tenant-ok(per-id): id provenienti da una query già scopata
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

async function loadResponsesForTasks(session: Session, taskIds: string[], tenantId: string): Promise<Record<string, TaskResponses>> {
  if (taskIds.length === 0) return {}
  const rows = await runQuery<{ taskId: string; respId: string; questionProps: Props; optionProps: Props; answeredAt: string; userProps: Props | null }>(session, `
    UNWIND $taskIds AS tid
    MATCH (t:AssessmentTask {id: tid, tenant_id: $tenantId})-[:HAS_RESPONSE]->(resp:AssessmentResponse)-[:ANSWERS]->(q:AssessmentQuestion),
          (resp)-[:SELECTED]->(opt:AnswerOption)
    OPTIONAL MATCH (resp)-[:ANSWERED_BY]->(u:User)
    RETURN DISTINCT tid AS taskId,
           resp.id AS respId,
           properties(q) AS questionProps,
           properties(opt) AS optionProps,
           resp.answered_at AS answeredAt,
           properties(u) AS userProps
  `, { taskIds, tenantId })
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

async function loadCompletedByForTasks(session: Session, taskIds: string[], tenantId: string): Promise<Record<string, ReturnType<typeof mapUser>>> {
  if (taskIds.length === 0) return {}
  const rows = await runQuery<{ taskId: string; userProps: Props }>(session, `
    UNWIND $taskIds AS tid
    MATCH (t:AssessmentTask {id: tid, tenant_id: $tenantId})-[:COMPLETED_BY]->(u:User)
    RETURN tid AS taskId, properties(u) AS userProps
  `, { taskIds, tenantId })
  const map: Record<string, ReturnType<typeof mapUser>> = {}
  for (const r of rows) map[r.taskId] = mapUser(r.userProps)
  return map
}

async function loadAssignmentsForTasks(session: Session, taskIds: string[]): Promise<{
  teams: Record<string, ReturnType<typeof mapTeam>>
  users: Record<string, ReturnType<typeof mapUser>>
}> {
  if (taskIds.length === 0) return { teams: {}, users: {} }
  // Match both task types: this loader is called with assessment AND deploy-plan
  // ids. Filtering to AssessmentTask only left DeployPlanTask.assignedTeam null,
  // so the planning task showed no team and could not be assigned.
  const teamRows = await runQuery<{ taskId: string; teamProps: Props }>(session, `
    UNWIND $taskIds AS tid
    ${matchById('t', { labels: ['AssessmentTask', 'DeployPlanTask'], id: 'tid', tenant: null, imports: ['tid'] })}
    MATCH (t)-[:ASSIGNED_TO_TEAM]->(tm:Team)
    RETURN tid AS taskId, properties(tm) AS teamProps
  `, { taskIds })
  const userRows = await runQuery<{ taskId: string; userProps: Props }>(session, `
    UNWIND $taskIds AS tid
    ${matchById('t', { labels: ['AssessmentTask', 'DeployPlanTask'], id: 'tid', tenant: null, imports: ['tid'] })}
    MATCH (t)-[:ASSIGNED_TO]->(u:User)
    RETURN tid AS taskId, properties(u) AS userProps
  `, { taskIds })
  const teams: Record<string, ReturnType<typeof mapTeam>> = {}
  const users: Record<string, ReturnType<typeof mapUser>> = {}
  for (const r of teamRows) teams[r.taskId] = mapTeam(r.teamProps)
  for (const r of userRows) users[r.taskId] = mapUser(r.userProps)
  return { teams, users }
}

/**
 * Le colonne su cui la lista delle change ordina. Erano dichiarate
 * `sortable: true` nel web e il resolver non aveva affatto l'ordinamento: il
 * clic sull'intestazione non faceva nulla (revisione totale · F-24). Il
 * guardiano `sortWhitelists.test.ts` confronta questa mappa con le colonne
 * della pagina.
 */
export const CHANGE_SORT_WHITELIST: Record<string, string> = {
  code:               'c.code',
  title:              'c.title',
  priority:           'c.priority',
  aggregateRiskScore: 'c.aggregate_risk_score',
  createdAt:          'c.created_at',
}

export async function changes(
  _: unknown,
  args: { currentStep?: string; priority?: string; limit?: number; offset?: number; filters?: string; sortField?: string | null; sortDirection?: string | null },
  ctx: GraphQLContext,
  info?: GraphQLResolveInfo,
) {
  const { limit, offset } = listPage(args, 50)
  const sortCol = args.sortField ? CHANGE_SORT_WHITELIST[args.sortField] : undefined
  const sortDir = args.sortDirection?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
  const orderBy = sortCol ? `${sortCol} ${sortDir}` : 'c.created_at DESC'
  return withSession(async (session) => {
    const joinWF = args.currentStep
      ? 'MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {current_step: $currentStep})'
      : ''
    const conds = ['coalesce(c.deleted, false) = false']
    if (args.priority) conds.push('c.priority = $priority')
    /**
     * Le change accettano i FILTRI avanzati come incident e problem
     * (revisione totale · F-8): la ricerca della modale «collega ticket»
     * caricava le 50 più recenti e filtrava nel browser, quindi su un tenant
     * con trecento change cercare per codice non trovava niente. Lo stesso
     * argomento serve all'export CSV, che ora può ripetere i filtri di
     * schermo.
     */
    const params: Record<string, unknown> = {
      tenantId: ctx.tenantId, currentStep: args.currentStep ?? null, priority: args.priority ?? null, limit, offset,
    }
    const allowedFields = new Set(info ? getScalarFields(info.schema, 'Change') : ['code', 'title', 'status', 'priority', 'change_type'])
    // The list filters by step as `status`: not a GraphQL field of Change, but
    // the engine writes the step's name there on every transition (and the
    // creation writes the first one). Through here an OR group and «is one of»
    // with several steps work like any other rule (review of 23 Sep 2026).
    allowedFields.add('status')
    const advWhere = args.filters ? buildAdvancedWhere(args.filters, params, allowedFields, 'c') : ''
    if (advWhere) conds.push(`(${advWhere})`)
    const priorityWhere = `WHERE ${conds.join(' AND ')}`
    const items = await runQuery<{
      props: Props
      reqUser: Props | null
      ownerUser: Props | null
      appUser: Props | null
    }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})
      ${joinWF}
      ${priorityWhere}
      OPTIONAL MATCH (c)-[:REQUESTED_BY]->(req:User)
      OPTIONAL MATCH (c)-[:OWNED_BY]->(owner:User)
      OPTIONAL MATCH (c)-[:APPROVED_BY]->(app:User)
      RETURN properties(c) AS props,
             properties(req)   AS reqUser,
             properties(owner) AS ownerUser,
             properties(app)   AS appUser
      ORDER BY ${orderBy}
      SKIP toInteger($offset) LIMIT toInteger($limit)
    `, params)

    const countRows = await runQuery<{ total: unknown }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})
      ${joinWF}
      ${priorityWhere}
      RETURN count(c) AS total
    `, params)

    return {
      items: items.map((r) => ({
        ...mapChange(r.props),
        requester:   userOrNull(r.reqUser),
        changeOwner: userOrNull(r.ownerUser),
        approvalBy:  userOrNull(r.appUser),
      })),
      total: toNumber(countRows[0]?.total),
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
      WHERE coalesce(c.deleted, false) = false
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
      WHERE ci.tenant_id = $tenantId AND coalesce(c.deleted, false) = false
      OPTIONAL MATCH (c)-[:HAS_ASSESSMENT]->(ownerT:AssessmentTask)
        WHERE ownerT.ci_id = ci.id AND ownerT.responder_role = $ownerRole
      OPTIONAL MATCH (c)-[:HAS_ASSESSMENT]->(supportT:AssessmentTask)
        WHERE supportT.ci_id = ci.id AND supportT.responder_role = $supportRole
      OPTIONAL MATCH (c)-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask) WHERE dp.ci_id = ci.id
      OPTIONAL MATCH (c)-[:HAS_VALIDATION]->(vt:ValidationTest) WHERE vt.ci_id = ci.id
      OPTIONAL MATCH (c)-[:HAS_DEPLOYMENT]->(dt:DeploymentTask) WHERE dt.ci_id = ci.id
      OPTIONAL MATCH (c)-[:HAS_REVIEW]->(rv:ReviewTask) WHERE rv.ci_id = ci.id
      RETURN properties(ci) AS ciProps, head([l IN labels(ci) WHERE l <> 'ConfigurationItem']) AS ciLabel,
             coalesce(r.ci_phase, 'assessment') AS ciPhase,
             r.risk_score AS riskScore,
             properties(ownerT)  AS ownerTask,
             properties(supportT) AS supportTask,
             properties(dp) AS deployPlan,
             properties(vt) AS validation,
             properties(dt) AS deployment,
             properties(rv) AS review
      ORDER BY ci.name
    `, { changeId: args.changeId, tenantId: ctx.tenantId, ownerRole: ASSESSMENT_ROLE.OWNER, supportRole: ASSESSMENT_ROLE.SUPPORT })

    // Collect IDs of assessment tasks and deploy plan tasks for batch loading
    const assessTaskIds: string[] = []
    const planTaskIds: string[] = []
    for (const r of rows) {
      if (r.ownerTask && r.ownerTask['id']) assessTaskIds.push(r.ownerTask['id'] as string)
      if (r.supportTask && r.supportTask['id']) assessTaskIds.push(r.supportTask['id'] as string)
      if (r.deployPlan && r.deployPlan['id']) planTaskIds.push(r.deployPlan['id'] as string)
    }
    const allTaskIds = [...assessTaskIds, ...planTaskIds]
    const responsesByTask = await loadResponsesForTasks(session, assessTaskIds, ctx.tenantId)
    const completedByMap  = await loadCompletedByForTasks(session, allTaskIds, ctx.tenantId)
    const assignments     = await loadAssignmentsForTasks(session, allTaskIds)

    return rows.map((r) => {
      r.ciProps['type'] = r.ciProps['type'] as string | undefined ?? ciTypeFromLabels(ctx.tenantId, [r.ciLabel])
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
        riskScore:         r.riskScore != null ? toNumber(r.riskScore) : null,
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
      WHERE coalesce(c.deleted, false) = false
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
      // Anche i tipi CI del cliente, non solo quelli spediti (terza revisione).
      OPTIONAL MATCH (ct:CITypeDefinition)-[rel:HAS_QUESTION]->(q)
        WHERE (ct.scope = 'base' OR (ct.scope = 'tenant' AND ct.tenant_id = $tenantId))
          AND ct.active = true AND ct.name <> '__base__'
      WITH q, avg(rel.weight) AS weight, min(rel.sort_order) AS sortOrder
      RETURN properties(q) AS questionProps, weight, sortOrder
      ORDER BY sortOrder, q.created_at
    `, { tenantId: ctx.tenantId, category: args.category ?? null })
    const questionIds = rows.map(r => r.questionProps['id'] as string)
    const optsMap = await loadOptionsForQuestions(session, questionIds)
    return rows.map((r) => ({
      question:  { ...mapAssessmentQuestion(r.questionProps), options: optsMap[r.questionProps['id'] as string] ?? [] },
      weight:    r.weight == null ? 1 : toNumber(r.weight),
      sortOrder: toNumber(r.sortOrder),
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
  /** Il tipo del TICKET: i compiti delle change dicono 'change', i generici quello del loro. */
  entityType: string
  entityId:   string
  entityNumber: string
  /** Solo per i compiti delle change, che nascono per CI. */
  ciId:       string | null
  ciName:     string | null
  phase:      string
  createdAt:  string
}

const ASSESSMENT_ACTIVE = `['${TASK_STATUS.PENDING}','${TASK_STATUS.IN_PROGRESS}']`

export async function myTasks(_: unknown, __: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const params = { userId: ctx.userId, tenantId: ctx.tenantId }

    // ── Assigned to me: AssessmentTask con ASSIGNED_TO → user ──────────────────
    const assignedAssessRows = await runQuery<Omit<MyTaskRow, 'kind' | 'action'>>(session, `
      MATCH (t:AssessmentTask)-[:ASSIGNED_TO]->(u:User {id: $userId, tenant_id: $tenantId})
      WHERE t.tenant_id = $tenantId AND t.status IN ${ASSESSMENT_ACTIVE}
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_ASSESSMENT]->(t)
      WHERE coalesce(c.deleted, false) = false
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      MATCH (ci:ConfigurationItem {id: t.ci_id, tenant_id: $tenantId})
      RETURN DISTINCT
        t.id             AS id,
        coalesce(t.code, '') AS code,
        t.responder_role AS role,
        t.status         AS status,
        'change'         AS entityType,
        c.id             AS entityId,
        c.code           AS entityNumber,
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
      WHERE coalesce(c.deleted, false) = false
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      MATCH (ci:ConfigurationItem {id: t.ci_id, tenant_id: $tenantId})
      RETURN DISTINCT
        t.id             AS id,
        coalesce(t.code, '') AS code,
        t.responder_role AS role,
        t.status         AS status,
        'change'         AS entityType,
        c.id             AS entityId,
        c.code           AS entityNumber,
        ci.id            AS ciId,
        ci.name          AS ciName,
        wi.current_step  AS phase,
        t.created_at     AS createdAt
    `, params)

    // ── Unassigned: ValidationTest — OWNED_BY team, step deployment ───────────
    const valRows = await runQuery<Omit<MyTaskRow, 'kind' | 'role' | 'action'>>(session, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(team:Team)
      MATCH (ci:ConfigurationItem)-[:OWNED_BY]->(team)
      WHERE ci.tenant_id = $tenantId
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_VALIDATION]->(vt:ValidationTest)
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      WHERE vt.ci_id = ci.id AND coalesce(c.deleted, false) = false
        AND vt.status IN ${ASSESSMENT_ACTIVE}
      RETURN DISTINCT
        vt.id          AS id,
        coalesce(vt.code, '') AS code,
        vt.status      AS status,
        'change'           AS entityType,
        c.id           AS entityId,
        c.code         AS entityNumber,
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
      WHERE coalesce(c.deleted, false) = false
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      MATCH (ci:ConfigurationItem {id: dp.ci_id, tenant_id: $tenantId})
      RETURN DISTINCT
        dp.id          AS id,
        coalesce(dp.code, '') AS code,
        dp.status      AS status,
        'change'           AS entityType,
        c.id           AS entityId,
        c.code         AS entityNumber,
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
      WHERE coalesce(c.deleted, false) = false
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      MATCH (ci:ConfigurationItem {id: dp.ci_id, tenant_id: $tenantId})
      RETURN DISTINCT
        dp.id          AS id,
        coalesce(dp.code, '') AS code,
        dp.status      AS status,
        'change'           AS entityType,
        c.id           AS entityId,
        c.code         AS entityNumber,
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
      WHERE dt.ci_id = ci.id AND coalesce(c.deleted, false) = false
        AND dt.status IN ${ASSESSMENT_ACTIVE}
      RETURN DISTINCT
        dt.id          AS id,
        coalesce(dt.code, '') AS code,
        dt.status      AS status,
        'change'           AS entityType,
        c.id           AS entityId,
        c.code         AS entityNumber,
        ci.id          AS ciId,
        ci.name        AS ciName,
        wi.current_step AS phase,
        dt.created_at  AS createdAt
    `, params)

    // ── Unassigned: ReviewTask — OWNED_BY team, step review ──────────────────
    const revRows = await runQuery<Omit<MyTaskRow, 'kind' | 'role' | 'action'>>(session, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})-[:MEMBER_OF]->(team:Team)
      MATCH (ci:ConfigurationItem)-[:OWNED_BY]->(team)
      WHERE ci.tenant_id = $tenantId
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_REVIEW]->(rv:ReviewTask)
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      WHERE rv.ci_id = ci.id AND coalesce(c.deleted, false) = false
        AND rv.status IN ${ASSESSMENT_ACTIVE}
      RETURN DISTINCT
        rv.id          AS id,
        coalesce(rv.code, '') AS code,
        rv.status      AS status,
        'change'           AS entityType,
        c.id           AS entityId,
        c.code         AS entityNumber,
        ci.id          AS ciId,
        ci.name        AS ciName,
        wi.current_step AS phase,
        rv.created_at  AS createdAt
    `, params)

    // Revisione del 14 set 2026 · CH-5: l'azione era italiana per tutti. Qui
    // resta il testo inglese dell'API; il web la compone da `kind` e `role`.
    const assessmentAction = (role: string) => role === 'owner'
      ? 'Fill in the Functional assessment'
      : 'Fill in the Technical assessment'

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
        action: 'Fill in the deploy plan',
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
        action: 'Fill in the deploy plan',
      })),
      ...valRows.map((r) => ({
        ...r,
        kind:   'validation',
        role:   'owner',
        action: 'Run the validation (Pass/Fail)',
      })),
      ...depRows.map((r) => ({
        ...r,
        kind:   'deployment',
        role:   'support',
        action: 'Confirm the deploy',
      })),
      ...revRows.map((r) => ({
        ...r,
        kind:   'review',
        role:   'owner',
        action: 'Confirm the outcome (Confirmed/Rejected)',
      })),
    ]

    /**
     * I COMPITI GENERICI (20 set 2026): quelli che un passo di workflow crea
     * su qualunque ticket, non solo sulle change. Una query sola invece di
     * sei, perché il nodo è uno solo.
     *
     * Chi li vede: chi li ha presi in carico (`ASSIGNED_TO`) fra i propri,
     * e chi è nella squadra a cui sono assegnati fra quelli da prendere.
     * Quelli IN ATTESA non compaiono: il loro turno non è arrivato, e una
     * riga su cui non si può fare niente è rumore.
     */
    const compitiRows = await runQuery<Omit<MyTaskRow, 'kind'> & { miei: boolean }>(session, `
      MATCH (ticket)-[:HAS_TASK]->(k:Task {tenant_id: $tenantId, state: $apertoState})
      // Un ticket CANCELLATO non ha più compiti da fare: la riga porterebbe a
      // una pagina che non si apre. Lo filtrano tutte e sei le query dei
      // compiti di change; questa era l'unica che se n'era dimenticata.
      WHERE coalesce(ticket.deleted, false) = false
      OPTIONAL MATCH (k)-[:ASSIGNED_TO]->(mio:User {id: $userId, tenant_id: $tenantId})
      OPTIONAL MATCH (k)-[:ASSIGNED_TO_TEAM]->(:Team)<-[:MEMBER_OF]-(membro:User {id: $userId, tenant_id: $tenantId})
      WITH k, ticket, mio, membro
      WHERE mio IS NOT NULL OR (membro IS NOT NULL AND NOT EXISTS { (k)-[:ASSIGNED_TO]->(:User) })
      RETURN
        k.id          AS id,
        k.code        AS code,
        ''            AS role,
        k.title       AS action,
        k.state       AS status,
        k.entity_type AS entityType,
        ticket.id     AS entityId,
        coalesce(ticket.number, ticket.code, '') AS entityNumber,
        null          AS ciId,
        null          AS ciName,
        k.step_name   AS phase,
        k.created_at  AS createdAt,
        mio IS NOT NULL AS miei
      ORDER BY k.created_at DESC
    `, { ...params, apertoState: TASK_STATE.OPEN })

    /**
     * IL PERMESSO SEGUE IL TICKET, anche qui (rimedio, 20 set 2026).
     *
     * `myTasks` sta sotto il solo `workspace.use`, mentre `ticketTasks` è
     * sotto l'unione dei permessi di lettura e raffina sul tipo vero. Senza
     * questo filtro, chi è nella squadra leggeva TITOLO del compito e NUMERO
     * del ticket anche senza poter aprire quel tipo di ticket — esattamente
     * quello che il commento in testa a `resolvers/ticketTasks.ts` dice di
     * voler evitare.
     */
    for (const r of compitiRows) {
      const permesso = PERMESSO_LETTURA[r.entityType]
      if (!permesso || !ctx.permissions.has(permesso)) continue
      const { miei, ...riga } = r
      // Il titolo del compito È l'azione (`k.title AS action`): l'ha scritto
      // chi ha disegnato il passo, e dice esattamente cosa c'è da fare. Le
      // altre righe hanno una frase del prodotto perché quei compiti non
      // hanno un nome proprio.
      const voce = { ...riga, kind: 'task' }
      ;(miei ? assignedToMe : unassigned).push(voce)
    }

    assignedToMe.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    unassigned.sort((a, b)   => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))

    return { assignedToMe, unassigned }
  })
}

export async function changeImpactedCIs(_: unknown, args: { changeId: string; depth?: number }, ctx: GraphQLContext) {
  const depth = Math.max(1, Math.min(args.depth ?? 1, 5))
  // CM-3: le relazioni dei servizi del tenant, non una lista scritta qui.
  const relPattern = await serviceRelPatternForTenant(ctx.tenantId)
  return withSession(async (session) => {
    const rows = await runQuery<{
      impactedProps: Props; impactedLabel: string
      affectedProps: Props; affectedLabel: string
      distance: unknown; pathNames: string[]
    }>(session, `
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:AFFECTS_CI]->(affected)
      WHERE affected.tenant_id = $tenantId AND coalesce(c.deleted, false) = false
      WITH collect(DISTINCT affected) AS targets
      UNWIND targets AS affected
      // The candidates first, then one shortest path per pair — the incident's
      // way (B-34), review of 23 Sep 2026: every path up to 5 hops was
      // enumerated only to keep the first.
      MATCH (impacted)-[:${relPattern}*1..${depth}]->(affected)
      WHERE impacted.tenant_id = $tenantId AND NOT impacted IN targets
      WITH DISTINCT impacted, affected
      MATCH bestPath = shortestPath((impacted)-[:${relPattern}*1..${depth}]->(affected))
      RETURN
        properties(impacted) AS impactedProps, head([l IN labels(impacted) WHERE l <> 'ConfigurationItem']) AS impactedLabel,
        properties(affected) AS affectedProps, head([l IN labels(affected) WHERE l <> 'ConfigurationItem']) AS affectedLabel,
        length(bestPath) AS distance,
        [n IN nodes(bestPath) | n.name] AS pathNames
      ORDER BY distance ASC, impactedProps.name ASC
    `, { changeId: args.changeId, tenantId: ctx.tenantId })

    return rows.map((r) => {
      r.impactedProps['type'] = r.impactedProps['type'] as string | undefined ?? ciTypeFromLabels(ctx.tenantId, [r.impactedLabel])
      r.affectedProps['type'] = r.affectedProps['type'] as string | undefined ?? ciTypeFromLabels(ctx.tenantId, [r.affectedLabel])
      return {
        ci: mapCI(r.impactedProps),
        distance: r.distance == null ? 1 : toNumber(r.distance),
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
        ciId: string; ciName: string; ciType: string | null; ciLabels: string[]; ciEnv: string | null
      }>(session, `
        MATCH (c:Change {tenant_id: $tenantId})-[:${rel}]->(t:${label} {id: $id})
        WHERE coalesce(c.deleted, false) = false
        MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        MATCH (ci:ConfigurationItem {id: t.ci_id, tenant_id: $tenantId})
        RETURN coalesce(t.code, '') AS taskCode,
               c.id AS changeId, c.code AS changeCode, c.title AS changeTitle,
               wi.current_step AS changePhase,
               ('Why: ' + coalesce(c.why, '—') + ' · What: ' + coalesce(c.what, '—')) AS changeDesc,
               ci.id AS ciId, ci.name AS ciName,
               ci.type AS ciType, labels(ci) AS ciLabels,
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
          // Secondo giro UI · V-3: `toLower(head(labels))` dava «businessapplication».
          ciType:           row.ciType ?? ciTypeFromLabels(ctx.tenantId, row.ciLabels),
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
      // tenant-ok(condivisi): tipi base condivisi; la domanda è scopata
      // Anche i tipi CI del cliente (terza revisione).
      MATCH (ct:CITypeDefinition)-[rel:HAS_QUESTION]->(q:AssessmentQuestion {id: $questionId, tenant_id: $tenantId})
      WHERE (ct.scope = 'base' OR (ct.scope = 'tenant' AND ct.tenant_id = $tenantId))
          AND ct.active = true AND ct.name <> '__base__'
      RETURN ct.id AS ciTypeId, ct.name AS ciTypeName,
             rel.weight AS weight, rel.sort_order AS sortOrder
      ORDER BY ct.name
    `, { tenantId: ctx.tenantId, questionId: args.questionId })
    return rows.map((r) => ({
      ciTypeId:   r.ciTypeId,
      ciTypeName: r.ciTypeName,
      weight:     r.weight == null ? 1 : toNumber(r.weight),
      sortOrder:  toNumber(r.sortOrder),
    }))
  })
}

// ── Change.resolvesIncidents / resolvesProblems ──────────────────────────────
// Ticket collegati alla change via (ticket)-[:RESOLVED_BY]->(change).

export async function changeResolvesIncidents(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const rows = await runQuery<{ id: string; number: string; title: string; status: string; severity: string | null; removable: boolean }>(session, `
      MATCH (i:Incident {tenant_id: $tenantId})-[rel:RESOLVED_BY]->(c:Change {id: $id, tenant_id: $tenantId})
      RETURN i.id AS id, i.number AS number, i.title AS title, i.status AS status, i.severity AS severity, (NOT coalesce(rel.auto, false)) AS removable
      ORDER BY i.created_at DESC
    `, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => ({ ...r, priority: null }))
  })
}

export async function changeResolvesProblems(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const rows = await runQuery<{ id: string; number: string; title: string; status: string; priority: string | null; removable: boolean }>(session, `
      MATCH (p:Problem {tenant_id: $tenantId})-[rel:RESOLVED_BY]->(c:Change {id: $id, tenant_id: $tenantId})
      RETURN p.id AS id, p.number AS number, p.title AS title, p.status AS status, p.priority AS priority, (NOT coalesce(rel.auto, false)) AS removable
      ORDER BY p.created_at DESC
    `, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => ({ ...r, severity: null }))
  })
}

/**
 * IL CALENDARIO DELLE CHANGE (17 set 2026).
 *
 * Non esisteva modo di chiedere «cosa va in produzione questa settimana». Le
 * finestre stanno nei passi del piano di rilascio — un JSON su un
 * `DeployPlanTask`, che a sua volta punta al CI impattato per proprietà — e i
 * filtri di lista si costruiscono dai campi scalari del tipo `Change`: quella
 * data non era né filtrabile né ordinabile, quindi il calendario non si poteva
 * disegnare.
 *
 * ## Il filtro per intervallo sta nel DATABASE
 * Ogni piano porta l'inviluppo delle sue finestre (`window_start`,
 * `window_end`, indicizzati e scritti da `saveDeployPlan` nello stesso `SET`
 * dei passi): la `WHERE` sceglie i pochi piani che toccano l'intervallo, e il
 * JSON si apre solo per quelli. Senza l'inviluppo si leggerebbero i piani di
 * TUTTO il tenant a ogni apertura di pagina — su un tenant con migliaia di
 * change è una scansione per ogni sguardo al calendario.
 *
 * ## Il JSON si apre con l'UNICO parser che esiste
 * `parseDeploySteps` legge quei passi da quando esistono, e pretende l'offset
 * esplicito su ogni data: una finestra scritta come `2026-09-09T22:00` verrebbe
 * letta nel fuso del server API, non in quello del tenant, e il calendario
 * mostrerebbe il rilascio nell'ora sbagliata. Aprire il JSON in Cypher con
 * APOC eviterebbe questo giro, ma la regola sull'offset finirebbe scritta due
 * volte — e la seconda copia, dentro una `WHERE`, non la vedrebbe nessun test.
 *
 * ## Un piano illeggibile si CONTA, non si salta
 * Un piano scritto via API o importato prima di quella regola può portare date
 * vuote o a rovescio: non ha un inviluppo, quindi non può stare in calendario.
 * Ma tacerlo farebbe leggere il calendario come completo, quindi torna nel
 * conto `unreadablePlans` — che si chiede al database con un `count`, senza
 * leggere niente.
 */
export async function changeCalendar(
  _: unknown,
  args: { from: string; to: string },
  ctx: GraphQLContext,
) {
  const { parseDeploySteps, assertWindowDate } = await import('../../../lib/deployWindows.js')
  /*
   * L'intervallo passa dalla stessa regola delle finestre: offset esplicito.
   * Senza, «questa settimana» vorrebbe dire una cosa diversa per il server e
   * per chi guarda. Poi si normalizza in ISO `Z`, perché il confronto in Cypher
   * è fra STRINGHE: `window_start` è scritto da `planEnvelope`, che produce
   * sempre `Z`, e confrontarlo con un `+02:00` darebbe un ordine alfabetico
   * senza senso.
   */
  const daMs = Date.parse(assertWindowDate(args.from, 'from'))
  const aMs  = Date.parse(assertWindowDate(args.to, 'to'))
  if (Number.isNaN(daMs) || Number.isNaN(aMs) || aMs <= daMs) {
    throw new ValidationError(`The range is empty or reversed: from ${args.from} to ${args.to}`,
      { key: 'errors.change.calendarRange', params: { from: args.from, to: args.to } })
  }
  const daIso = new Date(daMs).toISOString()
  const aIso  = new Date(aMs).toISOString()

  return withSession(async (session) => {
    const rows = await runQuery<{
      changeId: string; code: string; title: string; changeType: string | null; priority: string | null
      currentStep: string | null; steps: string | null; taskCode: string | null; ciId: string | null; ciName: string | null
    }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask)
      WHERE coalesce(c.deleted, false) = false
        AND dp.window_start IS NOT NULL AND dp.window_end IS NOT NULL
        AND dp.window_start < $to AND dp.window_end > $from
      OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
      OPTIONAL MATCH (ci:ConfigurationItem {id: dp.ci_id, tenant_id: $tenantId})
      RETURN c.id AS changeId, c.code AS code, c.title AS title, c.change_type AS changeType,
             c.priority AS priority, wi.current_step AS currentStep,
             dp.steps AS steps, dp.code AS taskCode, dp.ci_id AS ciId, ci.name AS ciName
      ORDER BY dp.window_start
    `, { tenantId: ctx.tenantId, from: daIso, to: aIso })

    /*
     * I piani con dei passi ma senza inviluppo: date vuote, illeggibili o a
     * rovescio. Un `count`, non una lettura — e senza intervallo, perché un
     * piano senza date non cade in nessuna settimana.
     */
    const rotti = await runQueryOne<{ n: unknown }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask)
      WHERE coalesce(c.deleted, false) = false
        AND coalesce(dp.steps, '[]') <> '[]'
        AND (dp.window_start IS NULL OR dp.window_end IS NULL)
      RETURN count(dp) AS n
    `, { tenantId: ctx.tenantId })
    let unreadablePlans = toNumber(rotti?.n)

    const entries: Array<Record<string, unknown>> = []
    for (const r of rows) {
      let steps
      try {
        steps = parseDeploySteps(r.steps)
      } catch {
        // Un piano rotto non fa fallire il calendario di tutti gli altri: ha un
        // inviluppo (quindi non è nel conto di sopra) ma il JSON non si apre.
        unreadablePlans += 1
        continue
      }
      for (const s of steps) {
        for (const [kind, w] of [['validation', s.validationWindow], ['release', s.releaseWindow]] as const) {
          const da = Date.parse(w?.start ?? '')
          const a  = Date.parse(w?.end ?? '')
          if (Number.isNaN(da) || Number.isNaN(a) || a < da) continue
          // SI SOVRAPPONE all'intervallo, non «è contenuta»: un rilascio che
          // comincia domenica e finisce lunedì appartiene a entrambe le
          // settimane, e sparire da una delle due sarebbe peggio.
          if (da >= aMs || a <= daMs) continue
          entries.push({
            changeId: r.changeId, code: r.code, title: r.title,
            changeType: r.changeType, priority: r.priority, currentStep: r.currentStep,
            kind, start: w.start, end: w.end, stepTitle: s.title,
            taskCode: r.taskCode, ciId: r.ciId ?? '', ciName: r.ciName ?? r.ciId ?? '',
          })
        }
      }
    }

    // In ordine di inizio: il calendario è una cronologia, e a pari ora la
    // validazione viene prima del rilascio (è l'ordine del processo).
    entries.sort((x, y) => {
      const d = Date.parse(x['start'] as string) - Date.parse(y['start'] as string)
      if (d !== 0) return d
      const peso = (k: unknown) => (k === 'validation' ? 0 : 1)
      return peso(x['kind']) - peso(y['kind']) || String(x['code']).localeCompare(String(y['code']))
    })

    return { entries, unreadablePlans }
  })
}

/**
 * Field resolver `Change.deployConflicts`.
 *
 * A parte e non dentro `getChange`: costa una lettura dei piani sui CI
 * condivisi, e la paga solo chi apre il dettaglio — non ogni lista di change
 * che chiede quattro campi.
 */
export async function changeDeployConflicts(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  const { deployConflictsForChange } = await import('../../../lib/changeDeployConflicts.js')
  return withSession((session) => deployConflictsForChange(session, ctx.tenantId, parent.id))
}
