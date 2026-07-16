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
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { GraphQLError } from 'graphql'
import { requirePermission } from '../../middleware/apiKeyAuth.js'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { logger } from '../../lib/logger.js'
import { audit } from '../../lib/audit.js'
import { ASSESSMENT_ROLE, ROLE_TO_CATEGORY } from '../../lib/taskStatus.js'
import { getWorkflowSteps } from '../../lib/workflowHelpers.js'
import { createChangeRFC } from '../../services/changeCreationService.js'
import { executeChangeTransition } from '../../graphql/resolvers/change/changeMutations.js'
import type { GraphQLContext } from '../../context.js'

const router: ExpressRouter = Router()

type Props = Record<string, unknown>

// ── helpers ───────────────────────────────────────────────────────────────────

/** GraphQL-style context built from the API key, for resolvers/audit reuse. */
function apiCtx(req: Request): GraphQLContext {
  return {
    tenantId:  req.apiKey!.tenantId,
    userId:    req.apiKey!.keyId,
    userEmail: `api-key:${req.apiKey!.keyId}`,
    role:      'operator',
  }
}

function mapUserLite(p: Props | null | undefined) {
  if (!p || !p['id']) return null
  return { id: p['id'], name: p['name'] ?? null, email: p['email'] ?? null }
}

function mapChange(props: Props, phase: string | null, requester: Props | null, changeOwner: Props | null) {
  return {
    id:                 props['id'],
    code:               props['code'] ?? null,
    title:              props['title'],
    description:        props['description'] ?? null,
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
    WHERE ci.tenant_id = $tenantId
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

/** Translate lib/errors.js (GraphQLError-based) failures to HTTP responses. */
function graphQLErrorStatus(err: unknown): { status: number; code: string } | null {
  if (!(err instanceof GraphQLError)) return null
  const code = err.extensions['code'] as string | undefined
  if (code === 'BAD_USER_INPUT') return { status: 400, code: 'VALIDATION_ERROR' }
  if (code === 'CONFLICT')       return { status: 400, code: 'TRANSITION_NOT_AVAILABLE' }
  if (code === 'NOT_FOUND')      return { status: 404, code: 'NOT_FOUND' }
  if (code === 'FORBIDDEN')      return { status: 403, code: 'FORBIDDEN' }
  return null
}

// ── GET /api/v1/changes ───────────────────────────────────────────────────────

router.get('/', requirePermission('changes:read'), async (req: Request, res: Response) => {
  const page   = Math.max(1, parseInt(req.query['page']  as string || '1', 10))
  const limit  = Math.min(100, Math.max(1, parseInt(req.query['limit'] as string || '20', 10)))
  const offset = (page - 1) * limit
  const phase  = req.query['phase'] as string | undefined

  const session = getSession()
  try {
    // phase = current_step of the linked WorkflowInstance (legacy changes may have none)
    const phaseFilter = phase ? 'WITH c, wi WHERE wi.current_step = $phase' : ''
    const params: Record<string, unknown> = { tenantId: req.apiKey!.tenantId, phase: phase ?? null, offset, limit }

    const countRow = await runQueryOne<{ total: unknown }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})
      OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      ${phaseFilter}
      RETURN count(c) AS total
    `, params)

    const rows = await runQuery<ChangeRow>(session, `
      MATCH (c:Change {tenant_id: $tenantId})
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
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, '[api-v1/changes] list failed')
    if (!res.headersSent) res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Error' } })
  } finally { await session.close() }
})

// ── GET /api/v1/changes/:id ───────────────────────────────────────────────────

router.get('/:id', requirePermission('changes:read'), async (req: Request, res: Response) => {
  const session = getSession()
  try {
    const row = await loadChangeRow(session, req.params['id']!, req.apiKey!.tenantId)
    if (!row) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Change not found' } }); return }
    const affectedCIs = await loadAffectedCIs(session, req.params['id']!, req.apiKey!.tenantId)
    res.json({ data: { ...mapChange(row.props, row.phase, row.requester, row.changeOwner), affectedCIs } })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, changeId: req.params['id'] }, '[api-v1/changes] get failed')
    if (!res.headersSent) res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Error' } })
  } finally { await session.close() }
})

// ── POST /api/v1/changes ──────────────────────────────────────────────────────

router.post('/', requirePermission('changes:write'), async (req: Request, res: Response) => {
  const { title, description, changeOwner, affectedCIIds } = req.body as {
    title?: string; description?: string; changeOwner?: string; affectedCIIds?: unknown
  }
  if (!title?.trim()) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'title is required' } }); return
  }
  if (!changeOwner?.trim()) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'changeOwner is required' } }); return
  }
  if (!Array.isArray(affectedCIIds) || affectedCIIds.length === 0 || affectedCIIds.some((v) => typeof v !== 'string')) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'affectedCIIds must be a non-empty array of CI ids' } }); return
  }

  const ctx = apiCtx(req)
  try {
    const { id, code } = await createChangeRFC(
      { title, description: description ?? null, changeOwner, affectedCIIds: affectedCIIds as string[] },
      { tenantId: ctx.tenantId, userId: ctx.userId },
    )
    await audit(ctx, 'change_created', 'change', id, { code, title, affectedCIIds })

    const session = getSession()
    try {
      const row = await loadChangeRow(session, id, ctx.tenantId)
      const affectedCIs = await loadAffectedCIs(session, id, ctx.tenantId)
      res.status(201).json({ data: { ...mapChange(row!.props, row!.phase, row!.requester, row!.changeOwner), affectedCIs } })
    } finally { await session.close() }
  } catch (err) {
    const mapped = graphQLErrorStatus(err)
    if (mapped) {
      res.status(mapped.status).json({ error: { code: mapped.code, message: err instanceof Error ? err.message : 'Error' } })
      return
    }
    logger.error({ err: err instanceof Error ? err.message : err }, '[api-v1/changes] create failed')
    if (!res.headersSent) res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Error' } })
  }
})

// ── GET /api/v1/changes/:id/tasks ─────────────────────────────────────────────

// Task sources: label + linking relationship + who/when completion fields.
const TASK_SOURCES = [
  { rel: 'HAS_ASSESSMENT',  label: 'AssessmentTask', type: null,         byRel: 'COMPLETED_BY', atField: 'completed_at' },
  { rel: 'HAS_DEPLOY_PLAN', label: 'DeployPlanTask', type: 'planning',   byRel: 'COMPLETED_BY', atField: 'completed_at' },
  { rel: 'HAS_VALIDATION',  label: 'ValidationTest', type: 'validation', byRel: 'TESTED_BY',    atField: 'tested_at' },
  { rel: 'HAS_DEPLOYMENT',  label: 'DeploymentTask', type: 'deployment', byRel: 'DEPLOYED_BY',  atField: 'deployed_at' },
  { rel: 'HAS_REVIEW',      label: 'ReviewTask',     type: 'review',     byRel: 'REVIEWED_BY',  atField: 'reviewed_at' },
] as const

router.get('/:id/tasks', requirePermission('changes:read'), async (req: Request, res: Response) => {
  const session = getSession()
  try {
    const exists = await runQueryOne<{ id: string }>(session,
      `MATCH (c:Change {id: $id, tenant_id: $tenantId}) RETURN c.id AS id`,
      { id: req.params['id'], tenantId: req.apiKey!.tenantId })
    if (!exists) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Change not found' } }); return }

    const tasks: unknown[] = []
    for (const src of TASK_SOURCES) {
      const rows = await runQuery<{
        props: Props; ciId: string | null; ciName: string | null
        team: Props | null; completedBy: Props | null
      }>(session, `
        MATCH (c:Change {id: $id, tenant_id: $tenantId})-[:${src.rel}]->(t:${src.label})
        OPTIONAL MATCH (ci {id: t.ci_id, tenant_id: $tenantId})
        OPTIONAL MATCH (t)-[:ASSIGNED_TO_TEAM]->(team:Team)
        OPTIONAL MATCH (t)-[:${src.byRel}]->(u:User)
        RETURN properties(t) AS props, ci.id AS ciId, coalesce(ci.name, ci.id) AS ciName,
               properties(team) AS team, properties(u) AS completedBy
        ORDER BY t.code
      `, { id: req.params['id'], tenantId: req.apiKey!.tenantId })

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
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, changeId: req.params['id'] }, '[api-v1/changes] tasks failed')
    if (!res.headersSent) res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Error' } })
  } finally { await session.close() }
})

// ── POST /api/v1/changes/:id/transition ───────────────────────────────────────

router.post('/:id/transition', requirePermission('changes:write'), async (req: Request, res: Response) => {
  const { toStep, notes } = req.body as { toStep?: string; notes?: string }
  if (!toStep?.trim()) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'toStep is required' } }); return
  }
  const ctx = apiCtx(req)
  const changeId = req.params['id']!
  try {
    // Reuse the GraphQL resolver: workflow guards, step side-effects
    // (task creation on step entry), audit trail and auto-transitions
    // all behave exactly like the UI flow.
    await executeChangeTransition(null, { changeId, toStep, notes }, ctx)
    await audit(ctx, 'change_transition', 'change', changeId, { toStep, notes: notes ?? null })

    const session = getSession()
    try {
      const row = await loadChangeRow(session, changeId, ctx.tenantId)
      if (!row) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Change not found' } }); return }
      res.json({ data: mapChange(row.props, row.phase, row.requester, row.changeOwner) })
    } finally { await session.close() }
  } catch (err) {
    const mapped = graphQLErrorStatus(err)
    if (mapped) {
      // Guard rejections / unavailable transitions surface as 400 with the guard's message
      res.status(mapped.status).json({ error: { code: mapped.code, message: err instanceof Error ? err.message : 'Error' } })
      return
    }
    logger.error({ err: err instanceof Error ? err.message : err, changeId, toStep }, '[api-v1/changes] transition failed')
    if (!res.headersSent) res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Error' } })
  }
})

// ── GET /api/v1/changes/:id/status ────────────────────────────────────────────

router.get('/:id/status', requirePermission('changes:read'), async (req: Request, res: Response) => {
  const session = getSession()
  try {
    const row = await runQueryOne<{ code: string | null; approvalStatus: string | null; phase: string | null }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
      RETURN c.code AS code, c.approval_status AS approvalStatus, wi.current_step AS phase
    `, { id: req.params['id'], tenantId: req.apiKey!.tenantId })
    if (!row) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Change not found' } }); return }

    // deployApproved: the workflow has reached (or passed) the deployment
    // step. Computed by comparing step_order metadata on the WorkflowStep
    // nodes — the deployment step is located via its category/name key,
    // never by hardcoding the step sequence.
    let deployApproved = false
    if (row.phase) {
      const steps = await getWorkflowSteps(session, req.apiKey!.tenantId, 'change')
      const currentStep = steps.find((s) => s.name === row.phase)
      const deployStep  = steps.find((s) => s.category === 'deployment') ?? steps.find((s) => s.name === 'deployment')
      if (currentStep?.stepOrder != null && deployStep?.stepOrder != null) {
        deployApproved = Number(currentStep.stepOrder) >= Number(deployStep.stepOrder)
      }
    }

    res.json({ data: { code: row.code, phase: row.phase, approvalStatus: row.approvalStatus, deployApproved } })
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err, changeId: req.params['id'] }, '[api-v1/changes] status failed')
    if (!res.headersSent) res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Error' } })
  } finally { await session.close() }
})

export { router as changesRouter }
