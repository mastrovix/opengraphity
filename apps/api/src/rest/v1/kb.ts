/**
 * REST API v1 — Knowledge Base (published articles, read-only).
 * Errors: routes throw lib/errors.js types; rest/errorHandler.ts maps them.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { requirePermission } from '../../middleware/apiKeyAuth.js'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { withSession } from '../../graphql/resolvers/ci-utils.js'
import { NotFoundError } from '../../lib/errors.js'
import { asyncHandler } from '../errorHandler.js'
import { apiKeyOf, parsePagination } from '../apiContext.js'

const router: ExpressRouter = Router()

type Props = Record<string, unknown>

router.get('/', requirePermission('kb:read'), asyncHandler(async (req: Request, res: Response) => {
  const { page, limit, offset } = parsePagination(req.query)
  const tenantId = apiKeyOf(req).tenantId
  const { rows, total } = await withSession(async (session) => {
    // "Public" articles = workflow is in a step with category='published'.
    const countRow = await runQueryOne<{ total: unknown }>(session, `
      MATCH (a:KBArticle {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(:WorkflowInstance)-[:CURRENT_STEP]->(s:WorkflowStep)
      WHERE s.category = 'published'
      RETURN count(a) AS total
    `, { tenantId })
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (a:KBArticle {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(:WorkflowInstance)-[:CURRENT_STEP]->(s:WorkflowStep)
      WHERE s.category = 'published'
      RETURN properties(a) AS props ORDER BY a.published_at DESC SKIP toInteger($offset) LIMIT toInteger($limit)
    `, { tenantId, offset, limit })
    return { rows, total: Number(countRow?.total ?? 0) }
  })
  res.json({
    data: rows.map(r => ({ id: r.props['id'], title: r.props['title'], slug: r.props['slug'], category: r.props['category'] ?? null, publishedAt: r.props['published_at'] ?? null })),
    meta: { page, limit, total },
  })
}))

router.get('/:slug', requirePermission('kb:read'), asyncHandler(async (req: Request, res: Response) => {
  const slug = req.params['slug']!
  const row = await withSession((session) => runQueryOne<{ props: Props }>(session, `
    MATCH (a:KBArticle {slug: $slug, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(:WorkflowInstance)-[:CURRENT_STEP]->(s:WorkflowStep)
    WHERE s.category = 'published'
    RETURN properties(a) AS props
  `, { slug, tenantId: apiKeyOf(req).tenantId }))
  if (!row) throw new NotFoundError('Article', slug)
  res.json({ data: row.props })
}))

export { router as kbRouter }
