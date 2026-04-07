import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { requirePermission } from '../../middleware/apiKeyAuth.js'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'

const router: ExpressRouter = Router()

router.get('/', requirePermission('kb:read'), async (req: Request, res: Response) => {
  const page  = Math.max(1, parseInt(req.query['page'] as string || '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(req.query['limit'] as string || '20', 10)))
  const offset = (page - 1) * limit
  const session = getSession()
  try {
    const countRow = await runQueryOne<{ total: number }>(session, `
      MATCH (a:KBArticle {tenant_id: $tenantId, status: 'published'}) RETURN count(a) AS total
    `, { tenantId: req.apiKey!.tenantId })
    const rows = await runQuery<{ props: Record<string, unknown> }>(session, `
      MATCH (a:KBArticle {tenant_id: $tenantId, status: 'published'})
      RETURN properties(a) AS props ORDER BY a.published_at DESC SKIP toInteger($offset) LIMIT toInteger($limit)
    `, { tenantId: req.apiKey!.tenantId, offset, limit })
    res.json({
      data: rows.map(r => ({ id: r.props['id'], title: r.props['title'], slug: r.props['slug'], category: r.props['category'] ?? null, publishedAt: r.props['published_at'] ?? null })),
      meta: { page, limit, total: countRow?.total ?? 0 },
    })
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Error" } }) } finally { await session.close() }
})

router.get('/:slug', requirePermission('kb:read'), async (req: Request, res: Response) => {
  const session = getSession()
  try {
    const row = await runQueryOne<{ props: Record<string, unknown> }>(session, `
      MATCH (a:KBArticle {slug: $slug, tenant_id: $tenantId, status: 'published'})
      RETURN properties(a) AS props
    `, { slug: req.params['slug'], tenantId: req.apiKey!.tenantId })
    if (!row) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Article not found' } }); return }
    res.json({ data: row.props })
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Error" } }) } finally { await session.close() }
})

export { router as kbRouter }
