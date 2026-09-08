/**
 * REST API v1 — Problems. Creation reuses problemService (same path as GraphQL).
 * Errors: routes throw lib/errors.js types; rest/errorHandler.ts maps them.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { requirePermission } from '../../middleware/apiKeyAuth.js'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { withSession } from '../../graphql/resolvers/ci-utils.js'
import * as problemService from '../../services/problemService.js'
import { NotFoundError } from '../../lib/errors.js'
import { asyncHandler } from '../errorHandler.js'
import { apiCtx, apiKeyOf, optionalBodyString, parsePagination, requiredString } from '../apiContext.js'

const router: ExpressRouter = Router()

type Props = Record<string, unknown>

function mapProblem(p: Props) {
  return {
    id: p['id'], tenantId: p['tenant_id'], title: p['title'], description: p['description'] ?? null,
    priority: p['priority'], status: p['status'], rootCause: p['root_cause'] ?? null,
    workaround: p['workaround'] ?? null,
    createdAt: p['created_at'], updatedAt: p['updated_at'],
  }
}

router.get('/', requirePermission('problems:read'), asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, offset } = parsePagination(req.query)
  const tenantId = apiKeyOf(req).tenantId
  const { rows, total } = await withSession(async (session) => {
    const countRow = await runQueryOne<{ total: unknown }>(session,
      `MATCH (p:Problem {tenant_id: $tenantId}) RETURN count(p) AS total`, { tenantId })
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (p:Problem {tenant_id: $tenantId}) RETURN properties(p) AS props ORDER BY p.created_at DESC SKIP toInteger($offset) LIMIT toInteger($limit)
    `, { tenantId, offset, limit })
    return { rows, total: Number(countRow?.total ?? 0) }
  })
  res.json({ data: rows.map(r => mapProblem(r.props)), meta: { page, limit, total } })
}))

router.get('/:id', requirePermission('problems:read'), asyncHandler(async (req: Request, res: Response) => {
  const id = req.params['id']!
  const row = await withSession((session) => runQueryOne<{ props: Props }>(session, `
    MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) AS props
  `, { id, tenantId: apiKeyOf(req).tenantId }))
  if (!row) throw new NotFoundError('Problem', id)
  res.json({ data: mapProblem(row.props) })
}))

router.post('/', requirePermission('problems:write'), asyncHandler(async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const title       = requiredString(body, 'title')
  const priority    = requiredString(body, 'priority')
  const description = optionalBodyString(body, 'description')
  const category    = optionalBodyString(body, 'category')
  const workaround  = optionalBodyString(body, 'workaround')
  const ctx = apiCtx(req)
  const result = await problemService.createProblem(
    { title, description, priority, category, workaround },
    { tenantId: ctx.tenantId, userId: ctx.userId },
  )
  res.status(201).json({ data: result })
}))

export { router as problemsRouter }
