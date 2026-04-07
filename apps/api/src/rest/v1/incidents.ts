import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { requirePermission } from '../../middleware/apiKeyAuth.js'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import * as incidentService from '../../services/incidentService.js'
import { mapIncident } from '../../lib/mappers.js'

const router: ExpressRouter = Router()

// GET /api/v1/incidents
router.get('/', requirePermission('incidents:read'), async (req: Request, res: Response) => {
  const page   = Math.max(1, parseInt(req.query['page']  as string || '1', 10))
  const limit  = Math.min(100, Math.max(1, parseInt(req.query['limit'] as string || '20', 10)))
  const offset = (page - 1) * limit
  const status   = req.query['status']   as string | undefined
  const severity = req.query['severity'] as string | undefined

  const session = getSession()
  try {
    const filters: string[] = []
    const params: Record<string, unknown> = { tenantId: req.apiKey!.tenantId, limit, offset }
    if (status)   { filters.push('i.status = $status');     params['status'] = status }
    if (severity) { filters.push('i.severity = $severity'); params['severity'] = severity }
    const where = filters.length > 0 ? `AND ${filters.join(' AND ')}` : ''

    const countRow = await runQueryOne<{ total: number }>(session, `MATCH (i:Incident {tenant_id: $tenantId}) WHERE true ${where} RETURN count(i) AS total`, params)
    const total = countRow?.total ?? 0

    const rows = await runQuery<{ props: Record<string, unknown> }>(session, `
      MATCH (i:Incident {tenant_id: $tenantId}) WHERE true ${where}
      RETURN properties(i) AS props
      ORDER BY i.created_at DESC SKIP toInteger($offset) LIMIT toInteger($limit)
    `, params)

    res.json({ data: rows.map(r => mapIncident(r.props)), meta: { page, limit, total } })
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Error' } })
  } finally { await session.close() }
})

// GET /api/v1/incidents/:id
router.get('/:id', requirePermission('incidents:read'), async (req: Request, res: Response) => {
  const session = getSession()
  try {
    const row = await runQueryOne<{ props: Record<string, unknown> }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      RETURN properties(i) AS props
    `, { id: req.params['id'], tenantId: req.apiKey!.tenantId })
    if (!row) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Incident not found' } }); return }
    res.json({ data: mapIncident(row.props) })
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Error" } }) } finally { await session.close() }
})

// POST /api/v1/incidents
router.post('/', requirePermission('incidents:write'), async (req: Request, res: Response) => {
  try {
    const { title, description, severity, category } = req.body as Record<string, string>
    if (!title) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'title is required' } }); return }
    const result = await incidentService.createIncident(
      { title, description, severity: severity ?? 'medium', category },
      { tenantId: req.apiKey!.tenantId, userId: req.apiKey!.keyId },
    )
    res.status(201).json({ data: result })
  } catch (err) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err instanceof Error ? err.message : 'Error' } })
  }
})

// PATCH /api/v1/incidents/:id
router.patch('/:id', requirePermission('incidents:write'), async (req: Request, res: Response) => {
  const session = getSession(undefined, 'WRITE')
  try {
    const body = req.body as Record<string, unknown>
    const sets: string[] = ['i.updated_at = $now']
    const params: Record<string, unknown> = { id: req.params['id'], tenantId: req.apiKey!.tenantId, now: new Date().toISOString() }
    for (const field of ['title', 'description', 'severity', 'status', 'category'] as const) {
      if (body[field] !== undefined) { sets.push(`i.${field} = $${field}`); params[field] = body[field] }
    }
    const rows = await runQuery<{ props: Record<string, unknown> }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      SET ${sets.join(', ')}
      RETURN properties(i) AS props
    `, params)
    if (!rows[0]) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Incident not found' } }); return }
    res.json({ data: mapIncident(rows[0].props) })
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Error" } }) } finally { await session.close() }
})

// POST /api/v1/incidents/:id/comments
router.post('/:id/comments', requirePermission('incidents:write'), async (req: Request, res: Response) => {
  const { text } = req.body as { text?: string }
  if (!text?.trim()) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'text is required' } }); return }
  const session = getSession(undefined, 'WRITE')
  try {
    const rows = await runQuery<{ id: string }>(session, `
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
      CREATE (c:Comment {id: randomUUID(), tenant_id: $tenantId, text: $text, author_id: $authorId, created_at: $now, updated_at: $now})
      CREATE (i)-[:HAS_COMMENT]->(c)
      RETURN c.id AS id
    `, { incidentId: req.params['id'], tenantId: req.apiKey!.tenantId, text: text.trim(), authorId: req.apiKey!.keyId, now: new Date().toISOString() })
    if (!rows[0]) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Incident not found' } }); return }
    res.status(201).json({ data: { id: rows[0].id, text: text.trim() } })
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Error" } }) } finally { await session.close() }
})

export { router as incidentsRouter }
