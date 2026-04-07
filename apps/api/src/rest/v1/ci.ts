import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { requirePermission } from '../../middleware/apiKeyAuth.js'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'

const router: ExpressRouter = Router()

router.get('/', requirePermission('ci:read'), async (req: Request, res: Response) => {
  const page   = Math.max(1, parseInt(req.query['page']  as string || '1', 10))
  const limit  = Math.min(100, Math.max(1, parseInt(req.query['limit'] as string || '20', 10)))
  const offset = (page - 1) * limit
  const ciType = req.query['type']   as string | undefined
  const status = req.query['status'] as string | undefined

  const session = getSession()
  try {
    const filters: string[] = []
    const params: Record<string, unknown> = { tenantId: req.apiKey!.tenantId, offset, limit }
    if (ciType) { filters.push('ci.type = $ciType'); params['ciType'] = ciType }
    if (status) { filters.push('ci.status = $status'); params['status'] = status }
    const where = filters.length > 0 ? `AND ${filters.join(' AND ')}` : ''

    const countRow = await runQueryOne<{ total: number }>(session, `
      MATCH (ci {tenant_id: $tenantId}) WHERE (ci:Application OR ci:Server OR ci:Database OR ci:DatabaseInstance OR ci:Certificate) ${where}
      RETURN count(ci) AS total
    `, params)

    const rows = await runQuery<{ props: Record<string, unknown> }>(session, `
      MATCH (ci {tenant_id: $tenantId}) WHERE (ci:Application OR ci:Server OR ci:Database OR ci:DatabaseInstance OR ci:Certificate) ${where}
      RETURN properties(ci) AS props ORDER BY ci.name SKIP toInteger($offset) LIMIT toInteger($limit)
    `, params)

    res.json({
      data: rows.map(r => ({ id: r.props['id'], name: r.props['name'], type: r.props['type'], status: r.props['status'], environment: r.props['environment'] ?? null, description: r.props['description'] ?? null })),
      meta: { page, limit, total: countRow?.total ?? 0 },
    })
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Error" } }) } finally { await session.close() }
})

router.get('/:id', requirePermission('ci:read'), async (req: Request, res: Response) => {
  const session = getSession()
  try {
    const row = await runQueryOne<{ props: Record<string, unknown> }>(session, `
      MATCH (ci {id: $id, tenant_id: $tenantId})
      WHERE (ci:Application OR ci:Server OR ci:Database OR ci:DatabaseInstance OR ci:Certificate)
      RETURN properties(ci) AS props
    `, { id: req.params['id'], tenantId: req.apiKey!.tenantId })
    if (!row) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'CI not found' } }); return }
    res.json({ data: row.props })
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Error" } }) } finally { await session.close() }
})

export { router as ciRouter }
