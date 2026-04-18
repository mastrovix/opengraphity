import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { requirePermission } from '../../middleware/apiKeyAuth.js'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'

const router: ExpressRouter = Router()

function mapChange(p: Record<string, unknown>) {
  return {
    id: p['id'], tenantId: p['tenant_id'], title: p['title'], description: p['description'] ?? null,
    type: p['type'], priority: p['priority'], status: p['status'],
    scheduledStart: p['scheduled_start'] ?? null, scheduledEnd: p['scheduled_end'] ?? null,
    createdAt: p['created_at'], updatedAt: p['updated_at'],
  }
}

router.get('/', requirePermission('changes:read'), async (req: Request, res: Response) => {
  const page  = Math.max(1, parseInt(req.query['page'] as string || '1', 10))
  const limit = Math.min(100, Math.max(1, parseInt(req.query['limit'] as string || '20', 10)))
  const offset = (page - 1) * limit

  const session = getSession()
  try {
    const countRow = await runQueryOne<{ total: number }>(session, `MATCH (c:Change {tenant_id: $tenantId}) RETURN count(c) AS total`, { tenantId: req.apiKey!.tenantId })
    const rows = await runQuery<{ props: Record<string, unknown> }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})
      RETURN properties(c) AS props ORDER BY c.created_at DESC SKIP toInteger($offset) LIMIT toInteger($limit)
    `, { tenantId: req.apiKey!.tenantId, offset, limit })
    res.json({ data: rows.map(r => mapChange(r.props)), meta: { page, limit, total: countRow?.total ?? 0 } })
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Error" } }) } finally { await session.close() }
})

router.get('/:id', requirePermission('changes:read'), async (req: Request, res: Response) => {
  const session = getSession()
  try {
    const row = await runQueryOne<{ props: Record<string, unknown> }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId}) RETURN properties(c) AS props
    `, { id: req.params['id'], tenantId: req.apiKey!.tenantId })
    if (!row) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Change not found' } }); return }
    res.json({ data: mapChange(row.props) })
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Error" } }) } finally { await session.close() }
})

router.post('/', requirePermission('changes:write'), async (req: Request, res: Response) => {
  const { title, description, type, priority } = req.body as Record<string, string>
  if (!title) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'title is required' } }); return }
  // Delegate to createChange resolver logic
  const { v4: uuidv4 } = await import('uuid')
  const id = uuidv4()
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    const { getInitialStepName } = await import('../../lib/workflowHelpers.js')
    const initialStatus = await getInitialStepName(session, req.apiKey!.tenantId, 'change')
    const rows = await runQuery<{ props: Record<string, unknown> }>(session, `
      CREATE (c:Change {id: $id, tenant_id: $tenantId, title: $title, description: $description,
        type: $type, priority: $priority, status: $status, created_at: $now, updated_at: $now})
      RETURN properties(c) AS props
    `, { id, tenantId: req.apiKey!.tenantId, title, description: description ?? null, type: type ?? 'normal', priority: priority ?? 'medium', now, status: initialStatus })
    res.status(201).json({ data: mapChange(rows[0]!.props) })
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Error" } }) } finally { await session.close() }
})

router.patch('/:id', requirePermission('changes:write'), async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>
  const sets: string[] = ['c.updated_at = $now']
  const params: Record<string, unknown> = { id: req.params['id'], tenantId: req.apiKey!.tenantId, now: new Date().toISOString() }
  for (const f of ['title', 'description', 'priority', 'status']) {
    if (body[f] !== undefined) { sets.push(`c.${f} = $${f}`); params[f] = body[f] }
  }
  const session = getSession(undefined, 'WRITE')
  try {
    const rows = await runQuery<{ props: Record<string, unknown> }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId}) SET ${sets.join(', ')} RETURN properties(c) AS props
    `, params)
    if (!rows[0]) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Change not found' } }); return }
    res.json({ data: mapChange(rows[0].props) })
  } catch (err) { if (!res.headersSent) res.status(500).json({ error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : "Error" } }) } finally { await session.close() }
})

export { router as changesRouter }
