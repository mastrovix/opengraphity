/**
 * Inbound webhook endpoint — receives events from external systems
 * and creates entities in OpenGrafo.
 *
 * POST /api/webhooks/inbound/:hookId
 * Auth: `Authorization: Bearer <token>` ONLY (never query string — it would
 * land in access logs, proxies and browser history).
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { createHash, timingSafeEqual } from 'crypto'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'
import { ValidationError } from '../lib/errors.js'
import * as incidentService from '../services/incidentService.js'
import * as problemService from '../services/problemService.js'
import { sourceConfigOf, normalizeWithConfig } from '../services/eventService.js'
import { enqueueEvents } from '../jobs/eventIngestWorker.js'

const log = logger.child({ module: 'webhook-inbound' })
const router: ExpressRouter = Router()

// ── Rate limiting (per hookId, 100/min) — applied AFTER token verification so
// an unauthenticated caller who only knows the (non-secret) id cannot starve
// the legitimate sender (A-20). In-memory: per-replica, known limitation.

const rateBuckets = new Map<string, { count: number; resetAt: number }>()
setInterval(() => { const now = Date.now(); for (const [k, v] of rateBuckets) { if (v.resetAt <= now) rateBuckets.delete(k) } }, 60_000).unref()

function checkRate(hookId: string): boolean {
  const now = Date.now()
  let b = rateBuckets.get(hookId)
  if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + 60_000 }; rateBuckets.set(hookId, b) }
  b.count++
  return b.count <= 100
}

/** Constant-time comparison of the presented token's sha256 against the stored hash. */
export function tokenMatches(token: string, storedHashHex: string): boolean {
  const presented = createHash('sha256').update(token).digest()
  if (!/^[0-9a-f]{64}$/i.test(storedHashHex)) return false // corrupt/legacy secret → never matches
  const stored = Buffer.from(storedHashHex, 'hex')
  return timingSafeEqual(presented, stored)
}

// ── Endpoint ─────────────────────────────────────────────────────────────────

router.post('/webhooks/inbound/:hookId', async (req: Request, res: Response) => {
  const { hookId } = req.params
  if (!hookId) { res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing hookId' } }); return }

  const session = getSession(undefined, 'WRITE')
  // Valorizzato solo dopo l'autenticazione: serve al catch per registrare il
  // motivo del rifiuto sul webhook (last_error / error_count) — senza tenant
  // verificato non si scrive nulla.
  let authenticatedTenantId: string | null = null
  try {
    // 1. Load webhook config
    const row = await runQueryOne<{ props: Record<string, unknown> }>(session, `
      // tenant-ok: lookup pre-auth, il tenant è quello del webhook (verificato dal token)
      MATCH (w:InboundWebhook {id: $hookId, enabled: true})
      RETURN properties(w) AS props
    `, { hookId })

    if (!row) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found or disabled' } }); return }

    const wh = row.props
    const tenantId  = wh['tenant_id']  as string
    const secret    = wh['secret']     as string
    const entityType = wh['entity_type'] as string

    // 2. Verify token (header only, constant-time)
    const authHeader = req.headers['authorization']
    const token = typeof authHeader === 'string' && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) { res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing Bearer token' } }); return }
    if (typeof secret !== 'string' || !tokenMatches(token, secret)) {
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid token' } }); return
    }

    authenticatedTenantId = tenantId

    // 3. Rate limit — only authenticated traffic counts
    if (!checkRate(hookId)) {
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Max 100 requests/min per webhook', retry_after: 60 } })
      return
    }

    // 4. Optional transform script. A configured transform that fails means we
    // do NOT understand this payload — creating an entity from the raw payload
    // (or from defaults) would fabricate data and answer 201. Fail instead.
    let payload = req.body as Record<string, unknown>
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ValidationError('Request body must be a JSON object')
    }
    const transformScript = wh['transform_script'] as string | null
    if (transformScript) {
      const { runScript } = await import('@opengraphity/scripting')
      const result = await runScript(
        { id: 'webhook-transform', tenant_id: tenantId, name: 'webhook-transform', trigger: 'webhook' as never, code: transformScript, enabled: true, created_at: '', updated_at: '' },
        { entity: payload, tenantId, userId: 'webhook' },
      )
      if (!result.success) {
        throw new ValidationError(`Transform script failed: ${result.error ?? 'unknown error'}`)
      }
      if (!result.output || typeof result.output !== 'object') {
        throw new ValidationError(`Transform script returned ${result.output === null ? 'null' : typeof result.output}, expected an object`)
      }
      payload = result.output as Record<string, unknown>
    }

    // 5a. Event Management: il payload (già trasformato) viene normalizzato per
    // connettore (field_mapping / default_values / value_mapping del webhook,
    // stessa pipeline di previewInboundEvents e sendSampleEvent) e accodato;
    // la mappatura piatta qui sotto vale solo per incident/problem.
    if (entityType === 'event') {
      const config = sourceConfigOf(wh)
      const events = normalizeWithConfig(config, payload)
      if (events.length === 0) {
        throw new ValidationError('Payload contains no alerts')
      }
      const receivedAt = new Date().toISOString()
      const accepted = await enqueueEvents(tenantId, hookId, events, receivedAt)

      // Un batch accettato azzera l'ultimo errore: l'amministratore vede lo
      // stato corrente della sorgente, non un rifiuto già superato.
      await runQuery(session, `
        MATCH (w:InboundWebhook {id: $hookId, tenant_id: $tenantId})
        SET w.receive_count = coalesce(w.receive_count, 0) + $n,
            w.last_received_at = $now,
            w.last_error = null
      `, { hookId, tenantId, n: accepted, now: receivedAt })

      log.info({ hookId, connectorKind: config.connectorKind, accepted }, 'Inbound events accepted')
      res.status(202).json({ id: hookId, entity_type: 'event', accepted })
      return
    }

    // 5. Apply field mapping (corrupt mapping JSON must fail, not become {})
    const fieldMapping = parseJSON<Record<string, string>>(wh['field_mapping'] as string, 'field_mapping')

    const mapped: Record<string, unknown> = {}
    for (const [sourceField, targetField] of Object.entries(fieldMapping)) {
      if (payload[sourceField] !== undefined) mapped[targetField] = payload[sourceField]
    }

    // 6. Apply default values (explicit webhook config — legitimate defaults)
    const defaults = parseJSON<Record<string, unknown>>(wh['default_values'] as string, 'default_values')
    for (const [field, value] of Object.entries(defaults)) {
      if (mapped[field] === undefined || mapped[field] === null) mapped[field] = value
    }

    // A webhook that produces no title is misconfigured — refuse rather than
    // fabricate a placeholder entity.
    if (!mapped['title'] || !String(mapped['title']).trim()) {
      throw new ValidationError('Mapped payload has no title — check field_mapping/default_values configuration')
    }

    // 7. Create entity
    const ctx = { tenantId, userId: 'webhook' }
    let entityId: string

    switch (entityType) {
      case 'incident': {
        if (!mapped['severity']) {
          throw new ValidationError('Mapped payload has no severity — set it via field_mapping or default_values')
        }
        const result = await incidentService.createIncident({
          title:       String(mapped['title']),
          description: mapped['description'] ? String(mapped['description']) : undefined,
          severity:    String(mapped['severity']),
          category:    mapped['category'] ? String(mapped['category']) : undefined,
        }, ctx)
        entityId = result.id as string
        break
      }
      case 'problem': {
        if (!mapped['priority']) {
          throw new ValidationError('Mapped payload has no priority — set it via field_mapping or default_values')
        }
        const result = await problemService.createProblem({
          title:       String(mapped['title']),
          description: mapped['description'] ? String(mapped['description']) : undefined,
          priority:    String(mapped['priority']),
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

    // 8. Update stats
    await runQuery(session, `
      MATCH (w:InboundWebhook {id: $hookId, tenant_id: $tenantId})
      SET w.receive_count = coalesce(w.receive_count, 0) + 1,
          w.last_received_at = $now
    `, { hookId, tenantId, now: new Date().toISOString() })

    log.info({ hookId, entityType, entityId }, 'Inbound webhook processed')
    res.status(201).json({ id: hookId, entity_type: entityType, entity_id: entityId })

  } catch (err) {
    // Typed input/config errors → 400 with the message (the sender can fix
    // them). Anything else (DB down, script host error) → 500 and a generic
    // body; the full error stays in the server log.
    if (err instanceof ValidationError) {
      log.warn({ hookId, err: err.message }, 'Inbound webhook rejected')
      if (authenticatedTenantId) await recordRejection(session, hookId, authenticatedTenantId, err.message)
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } })
      return
    }
    log.error({ hookId, err }, 'Inbound webhook error')
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Processing error' } })
  } finally {
    await session.close()
  }
})

/**
 * Un payload rifiutato (400) lascia traccia sul webhook: `last_error`,
 * `last_error_at`, `error_count`. Così l'amministratore vede il motivo in
 * interfaccia senza leggere i log. Se la scrittura fallisce si logga a livello
 * error e il 400 (la risposta primaria) resta.
 */
async function recordRejection(session: ReturnType<typeof getSession>, hookId: string, tenantId: string, message: string): Promise<void> {
  try {
    await runQuery(session, `
      MATCH (w:InboundWebhook {id: $hookId, tenant_id: $tenantId})
      SET w.last_error = $message,
          w.last_error_at = $now,
          w.error_count = coalesce(w.error_count, 0) + 1
    `, { hookId, tenantId, message: message.slice(0, 2000), now: new Date().toISOString() })
  } catch (e) {
    log.error({ hookId, tenantId, err: e }, 'Could not record inbound webhook rejection')
  }
}

/** Parses stored webhook config JSON. Missing → {}; corrupt → throws (fail-loud, config error → 400). */
function parseJSON<T>(raw: string | null | undefined, what: string): T {
  if (!raw) return {} as T
  try { return JSON.parse(raw) as T }
  catch (e) {
    throw new ValidationError(`Corrupt ${what} JSON in webhook config: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export { router as webhookInboundRouter }
