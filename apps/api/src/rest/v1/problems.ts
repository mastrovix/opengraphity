import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { requirePermission } from '../../middleware/apiKeyAuth.js'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import * as problemService from '../../services/problemService.js'

const router: ExpressRouter = Router()

function mapProblem(p: Record<string, unknown>) {
  return {
    id: p['id'], tenantId: p['tenant_id'], title: p['title'], description: p['description'] ?? null,
    priority: p['priority'], status: p['status'], rootCause: p['root_cause'] ?? null,
    workaround: p['workaround'] ?? null,
    createdAt: p['created_at'], updatedAt: p['updated_at'],
  }
}

router.get('/', requirePermission('problems:read'), async (req: Request, res: Response) => {
  const page  = Math.max(1, parseInt(req.query['page'] as string || '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(req.query['limit'] as string || '20', 10)))
  const offset = (page - 1) * limit
  const session = getSession()
  try {
    const countRow = await runQueryOne<{ total: number }>(session, `MATCH (p:Problem {tenant_id: $tenantId}) RETURN count(p) AS total`, { tenantId: req.apiKey!.tenantId })
    const rows = await runQuery<{ props: Record<string, unknown> }>(session, `
      MATCH (p:Problem {tenant_id: $tenantId}) RETURN properties(p) AS props ORDER BY p.created_at DESC SKIP toInteger($offset) LIMIT toInteger($limit)
    `, { tenantId: req.apiKey!.tenantId, offset, limit })
    res.json({ data: rows.map(r => mapProblem(r.props)), meta: { page, limit, total: countRow?.total ?? 0 } })
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Error" } }) } finally { await session.close() }
})

router.get('/:id', requirePermission('problems:read'), async (req: Request, res: Response) => {
  const session = getSession()
  try {
    const row = await runQueryOne<{ props: Record<string, unknown> }>(session, `
      MATCH (p:Problem {id: $id, tenant_id: $tenantId}) RETURN properties(p) AS props
    `, { id: req.params['id'], tenantId: req.apiKey!.tenantId })
    if (!row) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Problem not found' } }); return }
    res.json({ data: mapProblem(row.props) })
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Error" } }) } finally { await session.close() }
})

router.post('/', requirePermission('problems:write'), async (req: Request, res: Response) => {
  try {
    const { title, description, priority, category, workaround } = req.body as Record<string, string>
    if (!title) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'title is required' } }); return }
    const result = await problemService.createProblem(
      { title, description, priority: priority ?? 'medium', category, workaround },
      { tenantId: req.apiKey!.tenantId, userId: req.apiKey!.keyId },
    )
    res.status(201).json({ data: result })
  } catch (err) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : 'Error' } })
  }
})

export { router as problemsRouter }
