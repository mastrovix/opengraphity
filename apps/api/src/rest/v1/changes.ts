/**
 * REST API v1 — Changes (RFC-based process).
 *
 * Exposes the same RFC workflow used by the GraphQL API:
 *   - creation goes through the shared changeCreationService (CI validation,
 *     CHG code, per-CI assessment/deploy-plan tasks, workflow instance, audit)
 *   - transitions reuse the GraphQL executeChangeTransition resolver, so
 *     workflow guards and step side-effects behave identically.
 *
 * Step names are never hardcoded: phases come from the WorkflowInstance and
 * step ordering/categories from lib/workflowHelpers (WorkflowStep nodes).
 *
 * Errors: routes throw lib/errors.js types; rest/errorHandler.ts maps them
 * (NotFound → 404, Validation → 400, Forbidden → 403, workflow CONFLICT → 400).
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { requirePermission } from '../../middleware/apiKeyAuth.js'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { withSession } from '../../graphql/resolvers/ci-utils.js'
import { audit } from '../../lib/audit.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { ASSESSMENT_ROLE, ROLE_TO_CATEGORY } from '../../lib/taskStatus.js'
import { getWorkflowSteps } from '../../lib/workflowHelpers.js'
import { createChangeRFC } from '../../services/changeCreationService.js'
import { executeChangeTransition } from '../../graphql/resolvers/change/changeMutations.js'
import { asyncHandler } from '../errorHandler.js'
import { apiCtx, apiKeyOf, optionalString, parsePagination, requiredString } from '../apiContext.js'

const router: ExpressRouter = Router()

type Props = Record<string, unknown>

// ── helpers ───────────────────────────────────────────────────────────────────

function mapUserLite(p: Props | null | undefined) {
  if (!p || !p['id']) return null
  return { id: p['id'], name: p['name'] ?? null, email: p['email'] ?? null }
}

function mapChange(props: Props, phase: string | null, requester: Props | null, changeOwner: Props | null) {
  return {
    id:                 props['id'],
    code:               props['code'] ?? null,
    title:              props['title'],
    why:                props['why'] ?? null,
    what:               props['what'] ?? null,
    requester:          mapUserLite(requester),
    changeOwner:        mapUserLite(changeOwner),
    phase:              phase ?? null,
    aggregateRiskScore: props['aggregate_risk_score'] != null ? Number(props['aggregate_risk_score']) : null,
    approvalRoute:      props['approval_route'] ?? null,
    approvalStatus:     props['approval_status'] ?? null,
    createdAt:          props['created_at'],
    updatedAt:          props['updated_at'],
  }
}

function taskShort(p: Props | null | undefined) {
  if (!p || !p['id']) return null
  return { code: (p['code'] ?? '') as string, status: p['status'] as string }
}

function taskShortWithResult(p: Props | null | undefined) {
  const t = taskShort(p)
  if (!t) return null
  return { ...t, result: (p!['result'] ?? null) as string | null }
}

type Session = ReturnType<typeof getSession>

interface ChangeRow {
  props: Props
  phase: string | null
  requester: Props | null
  changeOwner: Props | null
}

async function loadChangeRow(session: Session, id: string, tenantId: string): Promise<ChangeRow | null> {
  return runQueryOne<ChangeRow>(session, `
    MATCH (c:Change {id: $id, tenant_id: $tenantId})
    WHERE coalesce(c.deleted, false) = false
    OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
    OPTIONAL MATCH (c)-[:REQUESTED_BY]->(req:User)
    OPTIONAL MATCH (c)-[:OWNED_BY]->(owner:User)
    RETURN properties(c) AS props, wi.current_step AS phase,
           properties(req) AS requester, properties(owner) AS changeOwner
  `, { id, tenantId })
}

async function loadAffectedCIs(session: Session, changeId: string, tenantId: string) {
  const rows = await runQuery<{
    ciId: string; ciName: string; riskScore: unknown
    ownerTask: Props | null; supportTask: Props | null; deployPlan: Props | null
    validation: Props | null; deployment: Props | null; review: Props | null
  }>(session, `
    MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[r:AFFECTS_CI]->(ci)
    WHERE ci.tenant_id = $tenantId AND coalesce(c.deleted, false) = false
    OPTIONAL MATCH (c)-[:HAS_ASSESSMENT]->(ownerT:AssessmentTask)
      WHERE ownerT.ci_id = ci.id AND ownerT.responder_role = $ownerRole
    OPTIONAL MATCH (c)-[:HAS_ASSESSMENT]->(supportT:AssessmentTask)
      WHERE supportT.ci_id = ci.id AND supportT.responder_role = $supportRole
    OPTIONAL MATCH (c)-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask) WHERE dp.ci_id = ci.id
    OPTIONAL MATCH (c)-[:HAS_VALIDATION]->(vt:ValidationTest)  WHERE vt.ci_id = ci.id
    OPTIONAL MATCH (c)-[:HAS_DEPLOYMENT]->(dt:DeploymentTask)  WHERE dt.ci_id = ci.id
    OPTIONAL MATCH (c)-[:HAS_REVIEW]->(rv:ReviewTask)          WHERE rv.ci_id = ci.id
    RETURN ci.id AS ciId, coalesce(ci.name, ci.id) AS ciName, r.risk_score AS riskScore,
           properties(ownerT)   AS ownerTask,
           properties(supportT) AS supportTask,
           properties(dp)       AS deployPlan,
           properties(vt)       AS validation,
           properties(dt)       AS deployment,
           properties(rv)       AS review
    ORDER BY ciName
  `, { changeId, tenantId, ownerRole: ASSESSMENT_ROLE.OWNER, supportRole: ASSESSMENT_ROLE.SUPPORT })

  return rows.map((r) => ({
    ciId:      r.ciId,
    ciName:    r.ciName,
    riskScore: r.riskScore != null ? Number(r.riskScore) : null,
    tasks: {
      functional: taskShort(r.ownerTask),
      technical:  taskShort(r.supportTask),
      planning:   taskShort(r.deployPlan),
      validation: taskShortWithResult(r.validation),
      deployment: taskShort(r.deployment),
      review:     taskShortWithResult(r.review),
    },
  }))
}

// ── GET /api/v1/changes ───────────────────────────────────────────────────────

router.get('/', requirePermission('changes:read'), asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, offset } = parsePagination(req.query)
  const phase = optionalString(req.query, 'phase')

  await withSession(async (session) => {
    // phase = current_step of the linked WorkflowInstance (legacy changes may have none)
    const phaseFilter = phase ? 'WITH c, wi WHERE wi.current_step = $phase' : ''
    const params: Record<string, unknown> = { tenantId: apiKeyOf(req).tenantId, phase: phase ?? null, offset, limit }

    const countRow = await runQueryOne<{ total: unknown }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})
      WHERE coalesce(c.deleted, false) = false
      OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      ${phaseFilter}
      RETURN count(c) AS total
    `, params)

    const rows = await runQuery<ChangeRow>(session, `
      MATCH (c:Change {tenant_id: $tenantId})
      WHERE coalesce(c.deleted, false) = false
      OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      ${phaseFilter}
      OPTIONAL MATCH (c)-[:REQUESTED_BY]->(req:User)
      OPTIONAL MATCH (c)-[:OWNED_BY]->(owner:User)
      RETURN properties(c) AS props, wi.current_step AS phase,
             properties(req) AS requester, properties(owner) AS changeOwner
      ORDER BY c.created_at DESC SKIP toInteger($offset) LIMIT toInteger($limit)
    `, params)

    res.json({
      data: rows.map((r) => mapChange(r.props, r.phase, r.requester, r.changeOwner)),
      meta: { page, limit, total: Number(countRow?.total ?? 0) },
    })
  })
}))

// ── GET /api/v1/changes/:id ───────────────────────────────────────────────────

router.get('/:id', requirePermission('changes:read'), asyncHandler(async (req: Request, res: Response) => {
  const id = req.params['id']!
  const tenantId = apiKeyOf(req).tenantId
  await withSession(async (session) => {
    const row = await loadChangeRow(session, id, tenantId)
    if (!row) throw new NotFoundError('Change', id)
    const affectedCIs = await loadAffectedCIs(session, id, tenantId)
    res.json({ data: { ...mapChange(row.props, row.phase, row.requester, row.changeOwner), affectedCIs } })
  })
}))

// ── POST /api/v1/changes ──────────────────────────────────────────────────────

router.post('/', requirePermission('changes:write'), asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const title       = requiredString(body, 'title')
  const why         = requiredString(body, 'why')
  const what        = requiredString(body, 'what')
  const changeOwner = requiredString(body, 'changeOwner')
  const affectedCIIds = body['affectedCIIds']
  if (!Array.isArray(affectedCIIds) || affectedCIIds.length === 0 || affectedCIIds.some((v) => typeof v !== 'string')) {
    throw new ValidationError('affectedCIIds must be a non-empty array of CI ids')
  }

  const ctx = apiCtx(req)
  const { id, code } = await createChangeRFC(
    { title, why, what, changeOwner, affectedCIIds: affectedCIIds as string[] },
    { tenantId: ctx.tenantId, userId: ctx.userId },
  )
  await audit(ctx, 'change_created', 'change', id, { code, title, affectedCIIds })

  await withSession(async (session) => {
    const row = await loadChangeRow(session, id, ctx.tenantId)
    if (!row) throw new Error(`Change ${id} not readable right after creation`)
    const affectedCIs = await loadAffectedCIs(session, id, ctx.tenantId)
    res.status(201).json({ data: { ...mapChange(row.props, row.phase, row.requester, row.changeOwner), affectedCIs } })
  })
}))

// ── GET /api/v1/changes/:id/tasks ─────────────────────────────────────────────

// Task sources: label + linking relationship + who/when completion fields.
const TASK_SOURCES = [
  { rel: 'HAS_ASSESSMENT',  label: 'AssessmentTask', type: null,         byRel: 'COMPLETED_BY', atField: 'completed_at' },
  { rel: 'HAS_DEPLOY_PLAN', label: 'DeployPlanTask', type: 'planning',   byRel: 'COMPLETED_BY', atField: 'completed_at' },
  { rel: 'HAS_VALIDATION',  label: 'ValidationTest', type: 'validation', byRel: 'TESTED_BY',    atField: 'tested_at' },
  { rel: 'HAS_DEPLOYMENT',  label: 'DeploymentTask', type: 'deployment', byRel: 'DEPLOYED_BY',  atField: 'deployed_at' },
  { rel: 'HAS_REVIEW',      label: 'ReviewTask',     type: 'review',     byRel: 'REVIEWED_BY',  atField: 'reviewed_at' },
] as const

router.get('/:id/tasks', requirePermission('changes:read'), asyncHandler(async (req: Request, res: Response) => {
  const id = req.params['id']!
  const tenantId = apiKeyOf(req).tenantId
  await withSession(async (session) => {
    const exists = await runQueryOne<{ id: string }>(session,
      `MATCH (c:Change {id: $id, tenant_id: $tenantId}) WHERE coalesce(c.deleted, false) = false RETURN c.id AS id`,
      { id, tenantId })
    if (!exists) throw new NotFoundError('Change', id)

    const tasks: unknown[] = []
    for (const src of TASK_SOURCES) {
      const rows = await runQuery<{
        props: Props; ciId: string | null; ciName: string | null
        team: Props | null; completedBy: Props | null
      }>(session, `
        MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:${src.rel}]->(t:${src.label})
        WHERE coalesce(c.deleted, false) = false
        OPTIONAL MATCH (ci {id: t.ci_id, tenant_id: $tenantId})
        OPTIONAL MATCH (t)-[:ASSIGNED_TO_TEAM]->(team:Team)
        OPTIONAL MATCH (t)-[:${src.byRel}]->(u:User)
        RETURN properties(t) AS props, ci.id AS ciId, coalesce(ci.name, ci.id) AS ciName,
               properties(team) AS team, properties(u) AS completedBy
        ORDER BY t.code
      `, { id, tenantId })

      for (const r of rows) {
        // Assessment tasks split into functional (CI owner) / technical (CI support)
        const type = src.type ?? ROLE_TO_CATEGORY[r.props['responder_role'] as string] ?? 'assessment'
        tasks.push({
          id:           r.props['id'],
          code:         (r.props['code'] ?? '') as string,
          type,
          status:       r.props['status'],
          ci:           r.ciId ? { id: r.ciId, name: r.ciName } : null,
          assignedTeam: r.team && r.team['id'] ? { id: r.team['id'], name: r.team['name'] ?? null } : null,
          completedBy:  mapUserLite(r.completedBy),
          completedAt:  (r.props[src.atField] ?? null) as string | null,
        })
      }
    }
    res.json({ data: tasks })
  })
}))

// ── POST /api/v1/changes/:id/transition ───────────────────────────────────────

router.post('/:id/transition', requirePermission('changes:write'), asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const toStep = requiredString(body, 'toStep').trim()
  const notes  = typeof body['notes'] === 'string' ? body['notes'] : undefined
  const ctx = apiCtx(req)
  const changeId = req.params['id']!

  // Reuse the GraphQL resolver: workflow guards, step side-effects
  // (task creation on step entry), audit trail and auto-transitions
  // all behave exactly like the UI flow. Guard rejections surface as
  // CONFLICT → 400 TRANSITION_NOT_AVAILABLE via the error middleware.
  await executeChangeTransition(null, { changeId, toStep, notes }, ctx)
  await audit(ctx, 'change_transition', 'change', changeId, { toStep, notes: notes ?? null })

  await withSession(async (session) => {
    const row = await loadChangeRow(session, changeId, ctx.tenantId)
    if (!row) throw new NotFoundError('Change', changeId)
    res.json({ data: mapChange(row.props, row.phase, row.requester, row.changeOwner) })
  })
}))

// ── GET /api/v1/changes/:id/status ────────────────────────────────────────────

router.get('/:id/status', requirePermission('changes:read'), asyncHandler(async (req: Request, res: Response) => {
  const id = req.params['id']!
  const tenantId = apiKeyOf(req).tenantId
  await withSession(async (session) => {
    const row = await runQueryOne<{ code: string | null; approvalStatus: string | null; phase: string | null }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      WHERE coalesce(c.deleted, false) = false
      OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN c.code AS code, c.approval_status AS approvalStatus, wi.current_step AS phase
    `, { id, tenantId })
    if (!row) throw new NotFoundError('Change', id)

    // deployApproved: the workflow has reached (or passed) the deployment
    // step. Computed by comparing step_order metadata on the WorkflowStep
    // nodes — the deployment step is located via its category/name key,
    // never by hardcoding the step sequence.
    let deployApproved = false
    if (row.phase) {
      const steps = await getWorkflowSteps(session, tenantId, 'change')
      const currentStep = steps.find((s) => s.name === row.phase)
      const deployStep  = steps.find((s) => s.category === 'deployment') ?? steps.find((s) => s.name === 'deployment')
      if (currentStep?.stepOrder != null && deployStep?.stepOrder != null) {
        deployApproved = Number(currentStep.stepOrder) >= Number(deployStep.stepOrder)
      }
    }

    res.json({ data: { code: row.code, phase: row.phase, approvalStatus: row.approvalStatus, deployApproved } })
  })
}))

export { router as changesRouter }
