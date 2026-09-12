/**
 * REST API v1 — Configuration Items (read-only).
 * Errors: routes throw lib/errors.js types; rest/errorHandler.ts maps them.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { requirePermission } from '../../middleware/apiKeyAuth.js'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { withSession } from '../../graphql/resolvers/ci-utils.js'
import { ciLabelPredicateForTenant } from '../../lib/ciLabelsForTenant.js'
import { ciLabelForTypeName, ciTypeNamesForTenant } from '../../lib/ciTypeNameToLabel.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { asyncHandler } from '../errorHandler.js'
import { apiKeyOf, optionalString, parsePagination } from '../apiContext.js'

const router: ExpressRouter = Router()

type Props = Record<string, unknown>

router.get('/', requirePermission('ci:read'), asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, offset } = parsePagination(req.query)
  const ciType = optionalString(req.query, 'type')
  const status = optionalString(req.query, 'status')

  const tenantId = apiKeyOf(req).tenantId
  const filters: string[] = []
  const params: Record<string, unknown> = { tenantId, offset, limit }
  // Filter by label, not by the `type` property (only discovery-created CIs
  // carry it); the label comes from the tenant's metamodel, so it cannot be
  // injected AND i tipi creati dal cliente sono interrogabili: prima
  // `?type=load_balancer` dava 400 «Unknown CI type» perché il tipo non era
  // nella tabella dei tipi spediti col prodotto (A-9).
  if (ciType) {
    const label = await ciLabelForTypeName(tenantId, ciType)
    if (!label) throw new ValidationError(`Unknown CI type: ${ciType} (available: ${(await ciTypeNamesForTenant(tenantId)).join(', ')})`)
    filters.push(`ci:${label}`)
  }
  if (status) { filters.push('ci.status = $status'); params['status'] = status }
  const where = filters.length > 0 ? `AND ${filters.join(' AND ')}` : ''

  const ciPredicate = await ciLabelPredicateForTenant('ci', tenantId)
  const { rows, total } = await withSession(async (session) => {
    const countRow = await runQueryOne<{ total: unknown }>(session, `
      MATCH (ci {tenant_id: $tenantId}) WHERE ${ciPredicate} ${where}
      RETURN count(ci) AS total
    `, params)
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (ci {tenant_id: $tenantId}) WHERE ${ciPredicate} ${where}
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
  const tenantId = apiKeyOf(req).tenantId
  const ciPredicate = await ciLabelPredicateForTenant('ci', tenantId)
  const row = await withSession((session) => runQueryOne<{ props: Props }>(session, `
    MATCH (ci {id: $id, tenant_id: $tenantId})
    WHERE ${ciPredicate}
    RETURN properties(ci) AS props
  `, { id, tenantId }))
  if (!row) throw new NotFoundError('CI', id)
  res.json({ data: row.props })
}))

export { router as ciRouter }
