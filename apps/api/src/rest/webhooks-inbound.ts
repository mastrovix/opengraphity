/**
 * Inbound webhook endpoint — receives events from external systems
 * and creates entities in OpenGrafo.
 *
 * POST /api/webhooks/inbound/:hookId
 * Auth: Bearer token (not Keycloak)
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { createHash } from 'crypto'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'
import * as incidentService from '../services/incidentService.js'
import * as problemService from '../services/problemService.js'

const log = logger.child({ module: 'webhook-inbound' })
const router: ExpressRouter = Router()

// ── Rate limiting (per hookId, 100/min) ──────────────────────────────────────

const rateBuckets = new Map<string, { count: number; resetAt: number }>()
setInterval(() => { const now = Date.now(); for (const [k, v] of rateBuckets) { if (v.resetAt <= now) rateBuckets.delete(k) } }, 60_000)

function checkRate(hookId: string): boolean {
  const now = Date.now()
  let b = rateBuckets.get(hookId)
  if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + 60_000 }; rateBuckets.set(hookId, b) }
  b.count++
  return b.count <= 100
}

// ── Endpoint ─────────────────────────────────────────────────────────────────

router.post('/webhooks/inbound/:hookId', async (req: Request, res: Response) => {
  const { hookId } = req.params
  if (!hookId) { res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing hookId' } }); return }

  if (!checkRate(hookId)) {
    res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Max 100 requests/min per webhook', retry_after: 60 } })
    return
  }

  const session = getSession(undefined, 'WRITE')
  try {
    // 1. Load webhook config
    const row = await runQueryOne<{ props: Record<string, unknown> }>(session, `
      MATCH (w:InboundWebhook {id: $hookId, enabled: true})
      RETURN properties(w) AS props
    `, { hookId })

    if (!row) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found or disabled' } }); return }

    const wh = row.props
    const tenantId  = wh['tenant_id']  as string
    const secret    = wh['secret']     as string
    const entityType = wh['entity_type'] as string

    // 2. Verify token
    const authHeader = req.headers['authorization'] as string | undefined
    const queryToken = req.query['token'] as string | undefined
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : queryToken
    if (!token) { res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing token' } }); return }

    const tokenHash = createHash('sha256').update(token).digest('hex')
    if (tokenHash !== secret) { res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }); return }

    // 3. Optional transform script
    let payload = req.body as Record<string, unknown>
    const transformScript = wh['transform_script'] as string | null
    if (transformScript) {
      try {
        const { runScript } = await import('@opengraphity/scripting')
        const result = await runScript(
          { id: 'webhook-transform', tenant_id: tenantId, name: 'webhook-transform', trigger: 'webhook' as never, code: transformScript, enabled: true, created_at: '', updated_at: '' },
          { entity: payload, tenantId, userId: 'webhook' },
        )
        if (result.success && result.output && typeof result.output === 'object') {
          payload = result.output as Record<string, unknown>
        }
      } catch (err) {
        log.error({ hookId, err }, 'Transform script failed')
      }
    }

    // 4. Apply field mapping
    const fieldMapping = parseJSON<Record<string, string>>(wh['field_mapping'] as string, {})
    const mapped: Record<string, unknown> = {}
    for (const [sourceField, targetField] of Object.entries(fieldMapping)) {
      if (payload[sourceField] !== undefined) mapped[targetField] = payload[sourceField]
    }

    // 5. Apply default values
    const defaults = parseJSON<Record<string, unknown>>(wh['default_values'] as string, {})
    for (const [field, value] of Object.entries(defaults)) {
      if (mapped[field] === undefined || mapped[field] === null) mapped[field] = value
    }

    // 6. Create entity
    const ctx = { tenantId, userId: 'webhook' }
    let entityId: string

    switch (entityType) {
      case 'incident': {
        const result = await incidentService.createIncident({
          title:       String(mapped['title'] ?? 'Webhook incident'),
          description: mapped['description'] ? String(mapped['description']) : undefined,
          severity:    String(mapped['severity'] ?? 'medium'),
          category:    mapped['category'] ? String(mapped['category']) : undefined,
        }, ctx)
        entityId = result.id as string
        break
      }
      case 'problem': {
        const result = await problemService.createProblem({
          title:       String(mapped['title'] ?? 'Webhook problem'),
          description: mapped['description'] ? String(mapped['description']) : undefined,
          priority:    String(mapped['priority'] ?? 'medium'),
          category:    mapped['category'] ? String(mapped['category']) : undefined,
        }, ctx)
        entityId = (result as Record<string, unknown>)['id'] as string
        break
      }
      default: {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: `Unsupported entity_type: ${entityType}` } })
        return
      }
    }

    // 7. Update stats
    await runQuery(session, `
      MATCH (w:InboundWebhook {id: $hookId})
      SET w.receive_count = coalesce(w.receive_count, 0) + 1,
          w.last_received_at = $now
    `, { hookId, now: new Date().toISOString() })

    log.info({ hookId, entityType, entityId }, 'Inbound webhook processed')
    res.status(201).json({ id: hookId, entity_type: entityType, entity_id: entityId })

  } catch (err) {
    log.error({ hookId, err }, 'Inbound webhook error')
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: err instanceof Error ? err.message : 'Processing error' } })
  } finally {
    await session.close()
  }
})

function parseJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) } catch { return fallback }
}

export { router as webhookInboundRouter }
