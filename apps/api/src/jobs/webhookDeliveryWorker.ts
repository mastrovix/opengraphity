/**
 * BullMQ worker for outbound webhook delivery.
 * Processes jobs from the "webhook-delivery" queue.
 */
import { Worker, type Job } from 'bullmq'
import { createHmac } from 'crypto'
import { getRedisOptions } from '@opengraphity/events'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'

const log = logger.child({ module: 'webhook-delivery' })

interface DeliveryJobData {
  webhookId:   string
  tenantId:    string
  url:         string
  method:      string
  headers:     Record<string, string>
  body:        string
  secret:      string | null
  retryOnFail: boolean
}

// ── SSRF protection ──────────────────────────────────────────────────────────

const PRIVATE_IP_RE = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2[0-9]|3[0-1])\./, /^169\.254\./, /^::1$/, /^fc00:/]

function isSafeUrl(raw: string): boolean {
  let parsed: URL
  try { parsed = new URL(raw) } catch { return false }
  if (process.env['NODE_ENV'] !== 'development' && parsed.protocol !== 'https:') return false
  const h = parsed.hostname
  if (h === 'localhost') return false
  return !PRIVATE_IP_RE.some(re => re.test(h))
}

// ── Processor ────────────────────────────────────────────────────────────────

async function processDelivery(job: Job<DeliveryJobData>): Promise<void> {
  const { webhookId, tenantId, url, method, headers, body, secret } = job.data
  const t0 = Date.now()

  if (!isSafeUrl(url)) {
    log.warn({ webhookId, url }, 'Outbound webhook URL blocked (SSRF)')
    return
  }

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
      log.warn({ webhookId, url, status: res.status, duration }, 'Outbound webhook non-2xx response')
      throw new Error(`HTTP ${res.status}`)
    }

    log.info({ webhookId, url, status: res.status, duration }, 'Outbound webhook delivered')
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

    log.error({ webhookId, url, duration, err }, 'Outbound webhook delivery failed')
    throw err // Re-throw so BullMQ can retry
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
    log.error({ jobId: job?.id, webhookId: (job?.data as DeliveryJobData | undefined)?.webhookId, err: err.message }, 'Webhook delivery job failed')
  })

  log.info('[webhook-delivery] worker started')
  return worker
}

/**
 * Enqueue outbound webhook delivery for a domain event.
 * Called from event dispatcher after SSE broadcast.
 */
export async function enqueueOutboundWebhooks(
  tenantId:  string,
  eventType: string,
  payload:   Record<string, unknown>,
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

    for (const row of rows) {
      const w = row.props
      const template = w['payload_template'] as string | null
      let body: string

      if (template) {
        body = template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, path: string) => {
          const parts = path.split('.')
          let val: unknown = { event_type: eventType, timestamp: new Date().toISOString(), tenant_id: tenantId, entity: payload, ...payload }
          for (const p of parts) {
            if (val == null || typeof val !== 'object') return ''
            val = (val as Record<string, unknown>)[p]
          }
          return val != null ? String(val) : ''
        })
      } else {
        body = JSON.stringify({ event_type: eventType, entity: payload, timestamp: new Date().toISOString(), tenant_id: tenantId })
      }

      await queue.add('deliver', {
        webhookId:   w['id']     as string,
        tenantId,
        url:         w['url']    as string,
        method:      (w['method'] as string) ?? 'POST',
        headers:     parseJSON<Record<string, string>>(w['headers'] as string, {}),
        body,
        secret:      (w['secret'] as string) ?? null,
        retryOnFail: (w['retry_on_failure'] as boolean) ?? true,
      }, {
        jobId: `wh-${w['id']}-${Date.now()}`,
      })
    }

    await queue.close()
    log.info({ tenantId, eventType, count: rows.length }, 'Outbound webhook jobs enqueued')
  } catch (err) {
    log.error({ tenantId, eventType, err }, 'Failed to enqueue outbound webhooks')
  } finally {
    await session.close()
  }
}

function parseJSON<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try { return JSON.parse(raw) } catch { return fallback }
}
