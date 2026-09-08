/**
 * REST API v1 — Configuration Items (read-only).
 * Errors: routes throw lib/errors.js types; rest/errorHandler.ts maps them.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { requirePermission } from '../../middleware/apiKeyAuth.js'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { withSession } from '../../graphql/resolvers/ci-utils.js'
import { ciLabelPredicate, TYPE_TO_LABEL } from '../../lib/ciLabels.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { asyncHandler } from '../errorHandler.js'
import { apiKeyOf, optionalString, parsePagination } from '../apiContext.js'

const router: ExpressRouter = Router()

type Props = Record<string, unknown>

router.get('/', requirePermission('ci:read'), asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, offset } = parsePagination(req.query)
  const ciType = optionalString(req.query, 'type')
  const status = optionalString(req.query, 'status')

  const filters: string[] = []
  const params: Record<string, unknown> = { tenantId: apiKeyOf(req).tenantId, offset, limit }
  // Filter by label, not by the `type` property (only discovery-created CIs
  // carry it); the whitelist also prevents label injection.
  if (ciType) {
    const label = TYPE_TO_LABEL[ciType.toLowerCase()]
    if (!label) throw new ValidationError(`Unknown CI type: ${ciType}`)
    filters.push(`ci:${label}`)
  }
  if (status) { filters.push('ci.status = $status'); params['status'] = status }
  const where = filters.length > 0 ? `AND ${filters.join(' AND ')}` : ''

  const { rows, total } = await withSession(async (session) => {
    const countRow = await runQueryOne<{ total: unknown }>(session, `
      MATCH (ci {tenant_id: $tenantId}) WHERE ${ciLabelPredicate('ci')} ${where}
      RETURN count(ci) AS total
    `, params)
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (ci {tenant_id: $tenantId}) WHERE ${ciLabelPredicate('ci')} ${where}
      RETURN properties(ci) AS props ORDER BY ci.name SKIP toInteger($offset) LIMIT toInteger($limit)
    `, params)
    return { rows, total: Number(countRow?.total ?? 0) }
  })

  res.json({
    data: rows.map(r => ({ id: r.props['id'], name: r.props['name'], type: r.props['type'], status: r.props['status'], environment: r.props['environment'] ?? null, description: r.props['description'] ?? null })),
    meta: { page, limit, total },
  })
}))

router.get('/:id', requirePermission('ci:read'), asyncHandler(async (req: Request, res: Response) => {
  const id = req.params['id']!
  const row = await withSession((session) => runQueryOne<{ props: Props }>(session, `
    MATCH (ci {id: $id, tenant_id: $tenantId})
    WHERE ${ciLabelPredicate('ci')}
    RETURN properties(ci) AS props
  `, { id, tenantId: apiKeyOf(req).tenantId }))
  if (!row) throw new NotFoundError('CI', id)
  res.json({ data: row.props })
}))

export { router as ciRouter }
