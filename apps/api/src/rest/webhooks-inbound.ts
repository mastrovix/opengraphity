/**
 * Inbound webhook endpoint — receives events from external systems
 * and creates entities in OpenGrafo.
 *
 * POST /api/webhooks/inbound/:hookId
 * Auth: `Authorization: Bearer <token>` ONLY (never query string — it would
 * land in access logs, proxies and browser history).
 */
import { Router, json, type Request, type Response, type Router as ExpressRouter } from 'express'
import { createHash, timingSafeEqual } from 'crypto'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'
import { ServiceUnavailableError, ValidationError } from '../lib/errors.js'
import { Semaphore } from '../lib/semaphore.js'
import { consumeWebhookRate, rateLimitOf } from '../lib/webhookRateLimit.js'
import { assertScriptingEnabled } from '../lib/scriptingPlan.js'
import { eventsRejectedTotal, webhookRateLimitedTotal } from '../middleware/metrics.js'
import { restErrorHandler } from './errorHandler.js'
import * as incidentService from '../services/incidentService.js'
import * as problemService from '../services/problemService.js'
import { sourceConfigOf, normalizeBatchWithConfig, rejectionSummary } from '../services/eventService.js'
import { enqueueEvents } from '../jobs/eventIngestWorker.js'
import { assertInboundTicketTargets } from '../lib/inboundTicketTargets.js'

const log = logger.child({ module: 'webhook-inbound' })
const router: ExpressRouter = Router()

// ── Rate limiting — per (tenant, webhook) su Redis, condiviso fra le repliche
// (lib/webhookRateLimit.ts, M7): limite `rate_limit_per_minute` della sorgente,
// 429 con header `Retry-After`. Applicato DOPO la verifica del token, così chi
// conosce solo l'id (non segreto) non può affamare il mittente legittimo (A-20).

// ── Transform script (B3): ogni esecuzione è un isolate V8 (8 MB, 5 s); senza
// tetto una raffica di richieste con script satura la replica. Oltre
// TRANSFORM_SCRIPT_MAX_CONCURRENCY si attende in coda (mai scarto silenzioso);
// oltre TRANSFORM_SCRIPT_MAX_WAIT_MS → 503 + Retry-After, il mittente ritenta.
export const TRANSFORM_SCRIPT_MAX_CONCURRENCY = 4
export const TRANSFORM_SCRIPT_MAX_WAIT_MS = 10_000
export const TRANSFORM_SCRIPT_RETRY_AFTER_SECONDS = 5
export const transformScriptSemaphore = new Semaphore({
  name: 'webhook-transform-script',
  limit: TRANSFORM_SCRIPT_MAX_CONCURRENCY,
  waitMs: TRANSFORM_SCRIPT_MAX_WAIT_MS,
  retryAfterSeconds: TRANSFORM_SCRIPT_RETRY_AFTER_SECONDS,
})

/** Constant-time comparison of the presented token's sha256 against the stored hash. */
export function tokenMatches(token: string, storedHashHex: string): boolean {
  const presented = createHash('sha256').update(token).digest()
  if (!/^[0-9a-f]{64}$/i.test(storedHashHex)) return false // corrupt/legacy secret → never matches
  const stored = Buffer.from(storedHashHex, 'hex')
  return timingSafeEqual(presented, stored)
}

// ── Endpoint ─────────────────────────────────────────────────────────────────

/**
 * Limite del corpo: un batch Alertmanager da 500 allarmi supera i 100 KB
 * predefiniti. Il parser è montato SULLA route (B4): in Express 4 un router
 * ha arità 3 e viene saltato quando l'errore nasce a monte, quindi un
 * `express.json` a livello app farebbe finire JSON malformato / corpo troppo
 * grande nel gestore predefinito (HTML), non nel `restErrorHandler` in coda a
 * questo router. Per lo stesso motivo server.ts non deve applicare il proprio
 * `express.json()` a `/api/webhooks/inbound` (vedi docs/API.md).
 */
export const WEBHOOK_BODY_LIMIT = '2mb'

router.post('/webhooks/inbound/:hookId', json({ limit: WEBHOOK_BODY_LIMIT }), async (req: Request, res: Response) => {
  const { hookId } = req.params
  if (!hookId) { res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Missing hookId' } }); return }

  const session = getSession(undefined, 'WRITE')
  // Valorizzato solo dopo l'autenticazione: serve al catch per registrare il
  // motivo del rifiuto sul webhook (last_error / error_count) — senza tenant
  // verificato non si scrive nulla.
  let authenticatedTenantId: string | null = null
  // Per la metrica degli scarti (events_rejected_total{connector}) quando l'intera richiesta è rifiutata.
  let entityTypeOfRejected: string | null = null
  let connectorOfRejected = 'generic'
  let rejectedCounted = false
  try {
    // 1. Load webhook config (+ il fuso del tenant: serve alla normalizzazione
    //    di Zabbix, che manda l'ora locale del server senza offset — M4).
    const row = await runQueryOne<{ props: Record<string, unknown>; timezone: string | null }>(session, `
      // tenant-ok: lookup pre-auth, il tenant è quello del webhook (verificato dal token); il Tenant è il suo
      MATCH (w:InboundWebhook {id: $hookId, enabled: true})
      OPTIONAL MATCH (t:Tenant {id: w.tenant_id})
      RETURN properties(w) AS props, t.timezone AS timezone
    `, { hookId })

    if (!row) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found or disabled' } }); return }

    const wh = row.props
    const tenantTimezone = typeof row.timezone === 'string' && row.timezone.trim() ? row.timezone : null
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
    entityTypeOfRejected = entityType
    // connector_kind assente = webhook precedente all'Event Management → generic, come sourceConfigOf.
    connectorOfRejected = typeof wh['connector_kind'] === 'string' ? wh['connector_kind'] : 'generic'

    // 3. Rate limit — only authenticated traffic counts. Redis giù → l'errore
    // propaga (500, il mittente ritenta): mai "limite disattivato".
    const rate = await consumeWebhookRate(tenantId, hookId, rateLimitOf(wh))
    if (!rate.allowed) {
      webhookRateLimitedTotal.inc({ connector: String(wh['connector_kind'] ?? entityType) })
      res.setHeader('Retry-After', String(rate.retryAfterSeconds))
      res.status(429).json({ error: { code: 'RATE_LIMITED', message: `Max ${rate.limit} requests/min per webhook`, retry_after: rate.retryAfterSeconds } })
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
      // Limite di piano (D-12): lo script di trasformazione è del cliente.
      // Piano senza script → 400 con il motivo, mai il payload grezzo passato
      // avanti come se lo script non ci fosse.
      await assertScriptingEnabled(tenantId, `script di trasformazione del webhook ${hookId}`)
      const { runScript } = await import('@opengraphity/scripting')
      const rawPayload = payload
      const result = await transformScriptSemaphore.run(() => runScript(
        { id: 'webhook-transform', tenant_id: tenantId, name: 'webhook-transform', trigger: 'webhook' as never, code: transformScript, enabled: true, created_at: '', updated_at: '' },
        { entity: rawPayload, tenantId, userId: 'webhook' },
      ))
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
    //
    // Accettazione parziale (A1): ogni elemento del batch è accettato o
    // scartato da solo. I validi vengono accodati (202 con `accepted` e la
    // lista `rejected[{index, error}]`); gli scarti restano visibili sulla
    // sorgente (`last_error` con il riepilogo, `error_count` += scartati) e in
    // `events_rejected_total{connector}`. Se NESSUN elemento passa → 400 come
    // per un payload interamente malformato. Non è un fallback: nulla viene
    // inventato, ciò che manca è contato e mostrato all'amministratore.
    if (entityType === 'event') {
      const config = sourceConfigOf(wh)
      if (config.connectorKind === 'zabbix' && !tenantTimezone) {
        log.warn({ hookId, tenantId }, 'Tenant has no timezone: Zabbix event_date/event_time cannot be converted (kept raw in labels.event_time)')
      }
      const batch = normalizeBatchWithConfig(config, payload, { timezone: tenantTimezone })
      if (batch.events.length === 0) {
        if (batch.rejected.length === 0) throw new ValidationError('Payload contains no alerts')
        // Tutti scartati: la metrica conta ogni elemento (il catch non la incrementa di nuovo).
        eventsRejectedTotal.inc({ connector: config.connectorKind }, batch.rejected.length)
        rejectedCounted = true
        throw new ValidationError(rejectionSummary(batch))
      }
      const receivedAt = new Date().toISOString()
      const accepted = await enqueueEvents(tenantId, hookId, batch.events, receivedAt)

      // Solo statistiche di ricezione: il 202 dice "accodato", non "riuscito".
      // `last_error` lo azzera il worker al primo job andato a buon fine e lo
      // scrive all'ultimo tentativo fallito (jobs/eventIngestWorker.ts): così
      // la pagina Sorgenti mostra l'esito reale, non l'accettazione.
      await runQuery(session, `
        MATCH (w:InboundWebhook {id: $hookId, tenant_id: $tenantId})
        SET w.receive_count = coalesce(w.receive_count, 0) + $n,
            w.last_received_at = $now
      `, { hookId, tenantId, n: accepted, now: receivedAt })
      if (batch.rejected.length > 0) {
        eventsRejectedTotal.inc({ connector: config.connectorKind }, batch.rejected.length)
        log.warn({ hookId, connectorKind: config.connectorKind, accepted, rejected: batch.rejected.length, first: batch.rejected[0] }, 'Inbound events partially rejected')
        await recordRejection(session, hookId, tenantId, rejectionSummary(batch), batch.rejected.length)
      }

      log.info({ hookId, connectorKind: config.connectorKind, accepted, rejected: batch.rejected.length }, 'Inbound events accepted')
      res.status(202).json({ id: hookId, entity_type: 'event', accepted, rejected: batch.rejected })
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

    // D-25: i bersagli fuori elenco venivano costruiti qui e poi SCARTATI dallo
    // switch di creazione, con risposta 201 e l'id dell'entità: l'integrazione
    // «funzionava» e perdeva metà dei dati. Dall'ondata 8 il salvataggio li
    // rifiuta (`validateInboundConfig`), quindi qui possono arrivare solo da
    // una configurazione più vecchia della regola: è un errore della
    // consegna, che il `catch` scrive in `last_error` sulla sorgente.
    assertInboundTicketTargets(entityType, Object.keys(mapped), 'field_mapping/default_values')

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
      if (authenticatedTenantId) {
        await recordRejection(session, hookId, authenticatedTenantId, err.message)
        if (entityTypeOfRejected === 'event' && !rejectedCounted) eventsRejectedTotal.inc({ connector: connectorOfRejected })
      }
      res.status(400).json({ error: { code: 'BAD_REQUEST', message: err.message } })
      return
    }
    // Replica satura (semaforo del transform script): non è colpa del payload
    // (niente last_error sulla sorgente) né un guasto (niente 500) — 503 e il
    // mittente ritenta dopo Retry-After.
    if (err instanceof ServiceUnavailableError) {
      log.warn({ hookId, err: err.message, retryAfter: err.retryAfterSeconds }, 'Inbound webhook deferred: capacity exhausted')
      res.setHeader('Retry-After', String(err.retryAfterSeconds))
      res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: err.message, retry_after: err.retryAfterSeconds } })
      return
    }
    log.error({ hookId, err }, 'Inbound webhook error')
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Processing error' } })
  } finally {
    await session.close()
  }
})

// Errori del body-parser (JSON malformato → 400, corpo oltre il limite di
// server.ts → 413) arrivano qui come JSON `{ error: { code, message } }` (B4):
// prima li intercettava "per caso" il restErrorHandler di altri router montati
// dopo su /api, e un riordino degli app.use li avrebbe fatti diventare HTML.
router.use(restErrorHandler)

/**
 * Un payload rifiutato (400) — o gli elementi scartati di un batch accettato
 * in parte (202, A1) — lascia traccia sul webhook: `last_error`,
 * `last_error_at`, `error_count` (+ `count`, il numero di elementi scartati).
 * Così l'amministratore vede il motivo in interfaccia senza leggere i log. Se
 * la scrittura fallisce si logga a livello error e la risposta primaria resta.
 */
async function recordRejection(session: ReturnType<typeof getSession>, hookId: string, tenantId: string, message: string, count = 1): Promise<void> {
  try {
    await runQuery(session, `
      MATCH (w:InboundWebhook {id: $hookId, tenant_id: $tenantId})
      SET w.last_error = $message,
          w.last_error_at = $now,
          w.error_count = coalesce(w.error_count, 0) + toInteger($count)
    `, { hookId, tenantId, message: message.slice(0, 2000), now: new Date().toISOString(), count })
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
