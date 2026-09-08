/**
 * BullMQ worker for outbound webhook delivery.
 * Processes jobs from the "webhook-delivery" queue.
 *
 * Job data carries ONLY the rendered body plus identifiers: url, method,
 * headers (may hold Authorization) and the HMAC secret are re-read from the
 * OutboundWebhook node (tenant-scoped) at delivery time, so no secret sits in
 * Redis and a rotated secret/URL takes effect on queued jobs too.
 */
import { Worker, type Job } from 'bullmq'
import { createHash, createHmac } from 'crypto'
import { getRedisOptions } from '@opengraphity/events'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'
import { assertSafeOutboundUrl, loggableUrl } from '../lib/safeUrl.js'

const log = logger.child({ module: 'webhook-delivery' })

export interface DeliveryJobData {
  webhookId: string
  tenantId:  string
  eventType: string
  eventId:   string
  body:      string
}

// ── Processor ────────────────────────────────────────────────────────────────

async function processDelivery(job: Job<DeliveryJobData>): Promise<void> {
  const { webhookId, tenantId, body } = job.data
  const t0 = Date.now()

  // Re-read the webhook config: the job is a pointer, the node is the truth.
  const session0 = getSession()
  let w: Record<string, unknown> | undefined
  try {
    const rows = await runQuery<{ props: Record<string, unknown> }>(session0, `
      MATCH (w:OutboundWebhook {id: $id, tenant_id: $tenantId})
      RETURN properties(w) AS props
    `, { id: webhookId, tenantId })
    w = rows[0]?.props
  } finally { await session0.close() }

  if (!w) {
    // Deleted between enqueue and delivery: nothing to deliver to. Throwing
    // keeps the job visible as failed instead of a silent "completed".
    throw new Error(`Outbound webhook ${webhookId} not found in tenant ${tenantId} — job dropped`)
  }
  if (w['enabled'] === false) {
    throw new Error(`Outbound webhook ${webhookId} is disabled — job dropped`)
  }

  const url     = w['url'] as string
  const method  = (w['method'] as string) ?? 'POST'
  const headers = parseJSON<Record<string, string>>(w['headers'] as string, 'headers')
  const secret  = (w['secret'] as string | null) ?? null
  const host    = loggableUrl(url)

  // Returning here would mark the BullMQ job COMPLETED: the webhook would
  // look healthy while never delivering. ValidationError → job fails visibly.
  await assertSafeOutboundUrl(url)

  const finalHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...headers }
  if (secret) {
    finalHeaders['X-Webhook-Signature'] = createHmac('sha256', secret).update(body).digest('hex')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(url, {
      method,
      headers: finalHeaders,
      body: method !== 'GET' ? body : undefined,
      signal: controller.signal,
    })

    const duration = Date.now() - t0
    const session = getSession(undefined, 'WRITE')
    try {
      await runQuery(session, `
        MATCH (w:OutboundWebhook {id: $id, tenant_id: $tenantId})
        SET w.send_count = coalesce(w.send_count, 0) + 1,
            w.last_sent_at = $now,
            w.last_status_code = $statusCode,
            w.last_error = null
      `, { id: webhookId, tenantId, now: new Date().toISOString(), statusCode: res.status })
    } finally { await session.close() }

    if (!res.ok) {
      log.warn({ webhookId, host, status: res.status, duration }, 'Outbound webhook non-2xx response')
      throw new Error(`HTTP ${res.status}`)
    }

    log.info({ webhookId, host, status: res.status, duration }, 'Outbound webhook delivered')
  } catch (err) {
    const duration = Date.now() - t0
    const errorMsg = err instanceof Error ? err.message : String(err)

    const session = getSession(undefined, 'WRITE')
    try {
      await runQuery(session, `
        MATCH (w:OutboundWebhook {id: $id, tenant_id: $tenantId})
        SET w.error_count = coalesce(w.error_count, 0) + 1,
            w.last_error = $error,
            w.last_status_code = null
      `, { id: webhookId, tenantId, error: errorMsg })
    } finally { await session.close() }

    log.error({ webhookId, host, duration, attempt: job.attemptsMade + 1, err }, 'Outbound webhook delivery failed')
    throw err // Re-throw so BullMQ retries (attempts/backoff set at enqueue)
  } finally {
    clearTimeout(timer)
  }
}

// ── Worker ───────────────────────────────────────────────────────────────────

export function startWebhookDeliveryWorker(): Worker {
  const worker = new Worker<DeliveryJobData>('webhook-delivery', processDelivery, {
    connection:  getRedisOptions(),
    concurrency: 10,
  })

  worker.on('failed', (job, err) => {
    log.error({ jobId: job?.id, webhookId: (job?.data as DeliveryJobData | undefined)?.webhookId, attemptsMade: job?.attemptsMade, err: err.message }, 'Webhook delivery job failed')
  })

  log.info('[webhook-delivery] worker started')
  return worker
}

// ── Payload template ─────────────────────────────────────────────────────────

/**
 * Renders a JSON `payload_template` by substituting `{{path.to.field}}`.
 *
 * Values are JSON-escaped for a STRING context: `"` → `\"`, newlines → `\n`,
 * etc. (`JSON.stringify(v).slice(1, -1)`), so a title containing quotes can
 * neither break the JSON nor inject extra fields. Non-string values are
 * stringified first, so templates must wrap placeholders in quotes:
 *   { "title": "{{title}}", "sev": "{{severity}}" }
 * Unresolvable paths render as an empty string (the template author opted in
 * to that field; a missing optional field is not an error).
 */
export function renderPayloadTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path: string) => {
    let val: unknown = context
    for (const p of path.split('.')) {
      if (val == null || typeof val !== 'object') return ''
      val = (val as Record<string, unknown>)[p]
    }
    if (val == null) return ''
    const str = typeof val === 'string' ? val : (typeof val === 'object' ? JSON.stringify(val) : String(val))
    return JSON.stringify(str).slice(1, -1)
  })
}

/**
 * Deterministic job id: one delivery per (webhook, event). A retry of the
 * event consumer re-enqueues with the same id and BullMQ de-duplicates it.
 * Without an event id the payload is hashed instead (same event twice ⇒ same
 * payload ⇒ same id).
 */
export function deliveryJobId(webhookId: string, eventType: string, payload: Record<string, unknown>, eventId?: string): string {
  const key = eventId ?? createHash('sha256').update(`${eventType}:${JSON.stringify(payload)}`).digest('hex').slice(0, 32)
  return `wh-${webhookId}-${key}`
}

/**
 * Enqueue outbound webhook delivery for a domain event.
 * Called from event dispatcher after SSE broadcast.
 *
 * `eventId` should be the DomainEvent id; callers without one fall back to a
 * payload hash for idempotency (see deliveryJobId).
 */
export async function enqueueOutboundWebhooks(
  tenantId:  string,
  eventType: string,
  payload:   Record<string, unknown>,
  eventId?:  string,
): Promise<void> {
  const session = getSession()
  try {
    const rows = await runQuery<{ props: Record<string, unknown> }>(session, `
      MATCH (w:OutboundWebhook {tenant_id: $tenantId, enabled: true})
      WHERE $eventType IN w.events
      RETURN properties(w) AS props
    `, { tenantId, eventType })

    if (rows.length === 0) return

    const { Queue } = await import('bullmq')
    const queue = new Queue('webhook-delivery', { connection: getRedisOptions() })
    const timestamp = new Date().toISOString()

    try {
      for (const row of rows) {
        const w = row.props
        const template = w['payload_template'] as string | null
        const body = template
          ? renderPayloadTemplate(template, { event_type: eventType, timestamp, tenant_id: tenantId, entity: payload, ...payload })
          : JSON.stringify({ event_type: eventType, entity: payload, timestamp, tenant_id: tenantId })

        const retryOnFail = (w['retry_on_failure'] as boolean) ?? true
        const jobId = deliveryJobId(w['id'] as string, eventType, payload, eventId)

        const data: DeliveryJobData = {
          webhookId: w['id'] as string,
          tenantId,
          eventType,
          eventId:   eventId ?? jobId,
          body,
        }
        await queue.add('deliver', data, {
          jobId,
          attempts: retryOnFail ? 5 : 1,
          backoff:  { type: 'exponential', delay: 10_000 },
          removeOnComplete: { age: 24 * 3600, count: 5000 },
          removeOnFail:     { age: 7 * 24 * 3600 },
        })
      }
    } finally {
      await queue.close()
    }
    log.info({ tenantId, eventType, count: rows.length }, 'Outbound webhook jobs enqueued')
  } finally {
    await session.close()
  }
  // No catch-all: a failure to enqueue means events are LOST for every
  // subscriber — it must propagate to the caller (event consumer job), which
  // fails visibly and retries, instead of dissolving into a log line.
}

/** Parses stored webhook headers. Missing → {}; corrupt → throws (fail-loud). */
function parseJSON<T>(raw: string | null | undefined, what: string): T {
  if (!raw) return {} as T
  try { return JSON.parse(raw) as T }
  catch (e) {
    throw new Error(`Corrupt ${what} JSON in outbound webhook config: ${e instanceof Error ? e.message : String(e)}`)
  }
}
