/**
 * THE OUTBOX OF THE DOMAIN EVENTS, IN THE GRAPH (wave 7 · B2).
 *
 * Every event is written down as an `:OutboxEvent` before it is sent, and
 * marked when it has been (packages/events/src/outbox.ts says why). This
 * module is the store the processes register at start (`installEventOutbox`,
 * from index.ts and worker.ts), the repeater that sends what stayed unmarked
 * (`resendPendingEvents`, a pass of every tenant every 30 seconds), and the
 * purge of what was sent more than a week ago (`purgeSentEvents`, maintenance).
 *
 * The node: `id` (the event's), `tenant_id`, `type`, `event` (the whole
 * event, as JSON), `webhooks`, `created_at`, `pending: true` until sent, then
 * `sent_at`; `attempts` and `last_error` when the repeater could not send it.
 * `pending` and not `sent_at IS NULL`: a range index does not hold nulls, and
 * the repeater reads the pending events of one tenant through
 * (tenant_id, pending) (migration 20261010_1010).
 */
import type { ManagedTransaction } from 'neo4j-driver'
import { getSession, MAINTENANCE_SCOPE, runInQueryScope, runQuery, toNumber } from '@opengraphity/neo4j'
import { registerEventOutbox, sendToConsumers, type EventOutbox, type PublishOptions } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import { enqueueOutboundWebhooks } from '../jobs/webhookDeliveryWorker.js'
import { outboxPendingEvents, outboxResentTotal } from '../middleware/metrics.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'outbox' })

/** An event not marked sent after this long is the repeater's: the send in flight has had its chance. */
export const OUTBOX_RESEND_AFTER_MS = 30_000
/** At most this many events per tenant and pass: a backlog drains over a few passes, in order. */
export const OUTBOX_RESEND_BATCH = 200
/** Sent events are kept this long, for who wants to see what left and when. */
export const OUTBOX_KEEP_SENT_DAYS = 7

const RECORD = `
  MERGE (o:OutboxEvent {id: $id, tenant_id: $tenantId})
    ON CREATE SET o.type = $type, o.event = $event, o.webhooks = $webhooks,
                  o.created_at = $now, o.pending = true, o.attempts = 0
`

function recordParams(event: DomainEvent<unknown>, options: PublishOptions): Record<string, unknown> {
  return {
    id: event.id, tenantId: event.tenant_id, type: event.type, event: JSON.stringify(event),
    webhooks: options.webhooks === true, now: new Date().toISOString(),
  }
}

async function inWriteSession<T>(fn: (session: ReturnType<typeof getSession>) => Promise<T>): Promise<T> {
  const session = getSession(undefined, 'WRITE')
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

async function markSent(event: Pick<DomainEvent<unknown>, 'id' | 'tenant_id'>): Promise<void> {
  await inWriteSession((session) => runQuery(session, `
    MATCH (o:OutboxEvent {id: $id, tenant_id: $tenantId})
    REMOVE o.pending
    SET o.sent_at = $now
  `, { id: event.id, tenantId: event.tenant_id, now: new Date().toISOString() }))
}

/** The outbound webhooks of an event published with `webhooks`: keyed by its id (jobs/webhookDeliveryWorker.ts). */
async function deliverExtras(event: DomainEvent<unknown>, options: PublishOptions): Promise<void> {
  if (!options.webhooks) return
  await enqueueOutboundWebhooks(event.tenant_id, event.type, event.payload as Record<string, unknown>, event.id)
}

export const neo4jEventOutbox: EventOutbox = {
  record: (event, options) => inWriteSession((session) => runQuery(session, RECORD, recordParams(event, options))).then(() => undefined),
  recordIn: async (tx, event, options) => {
    await (tx as ManagedTransaction).run(RECORD, recordParams(event, options))
  },
  deliverExtras,
  markSent,
}

/** Registers the graph's outbox for this process. To call once, at start, before anything publishes. */
export function installEventOutbox(): void {
  registerEventOutbox(neo4jEventOutbox)
}

export interface ResendSummary {
  /** Sent again by this pass. */
  sent:    number
  /** Still not sent: the next pass tries again. */
  failed:  number
  /** Waiting beyond the grace period after the pass (the metric). */
  pending: number
}

/**
 * Sends again the events of a tenant that were written down and never marked
 * sent (the process stopped, Redis did not answer). Oldest first; each one on
 * its own: one that fails does not hold the others. A consumer that already
 * processed one skips it (packages/events/src/consumer.ts).
 */
export async function resendPendingEvents(tenantId: string, nowMs: number = Date.now()): Promise<ResendSummary> {
  const before = new Date(nowMs - OUTBOX_RESEND_AFTER_MS).toISOString()
  const due = await inWriteSession((session) => runQuery<{ id: string; event: string; webhooks: boolean | null }>(session, `
    MATCH (o:OutboxEvent {tenant_id: $tenantId, pending: true})
    WHERE o.created_at < $before
    RETURN o.id AS id, o.event AS event, o.webhooks AS webhooks
    ORDER BY o.created_at
    LIMIT toInteger($limit)
  `, { tenantId, before, limit: OUTBOX_RESEND_BATCH }))

  let sent = 0
  let failed = 0
  for (const row of due) {
    try {
      const event = JSON.parse(row.event) as DomainEvent<unknown>
      await sendToConsumers(event)
      await deliverExtras(event, { webhooks: row.webhooks === true })
      await markSent(event)
      sent += 1
    } catch (err) {
      failed += 1
      const message = err instanceof Error ? err.message : String(err)
      log.error({ err, tenantId, eventId: row.id }, 'An event of the outbox could not be sent again: the next pass tries again')
      await inWriteSession((session) => runQuery(session, `
        MATCH (o:OutboxEvent {id: $id, tenant_id: $tenantId})
        SET o.attempts = coalesce(o.attempts, 0) + 1, o.last_error = $message
      `, { id: row.id, tenantId, message })).catch((e: unknown) => log.error({ err: e, tenantId, eventId: row.id }, 'The failed resend could not be noted on the outbox event'))
    }
  }
  if (sent > 0) outboxResentTotal.inc({ tenant: tenantId }, sent)

  const left = await inWriteSession((session) => runQuery<{ n: unknown }>(session, `
    MATCH (o:OutboxEvent {tenant_id: $tenantId, pending: true})
    WHERE o.created_at < $before
    RETURN count(o) AS n
  `, { tenantId, before }))
  const pending = toNumber(left[0]?.n)
  outboxPendingEvents.set({ tenant: tenantId }, pending)
  return { sent, failed, pending }
}

/**
 * Deletes the events sent more than `OUTBOX_KEEP_SENT_DAYS` days ago, for
 * every tenant, in transactions of a thousand (maintenance). An event never
 * sent is kept whatever its age: it is the repeater's, and its metric says so.
 */
export async function purgeSentEvents(nowMs: number = Date.now()): Promise<number> {
  const before = new Date(nowMs - OUTBOX_KEEP_SENT_DAYS * 86_400_000).toISOString()
  // The outer transaction of `IN TRANSACTIONS` lasts the whole purge: past the server's 120 s.
  const rows = await runInQueryScope(MAINTENANCE_SCOPE, () => inWriteSession((session) => runQuery<{ n: unknown }>(session, `
    MATCH (o:OutboxEvent)  // tenant-ok(piattaforma): the retention of the outbox is the same for every tenant
    WHERE o.sent_at < $before
    CALL (o) { DETACH DELETE o } IN TRANSACTIONS OF 1000 ROWS
    RETURN count(*) AS n
  `, { before })))
  return toNumber(rows[0]?.n)
}
