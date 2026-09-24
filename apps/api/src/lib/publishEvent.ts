/**
 * Shared helper: publishes a domain event AND enqueues outbound webhooks.
 * Use this instead of calling publish() directly to ensure webhooks fire.
 *
 * Since wave 7 · B2 the event goes through the outbox (lib/outbox.ts): it is
 * written down before it is sent, and the webhooks are part of what makes it
 * sent. For the events that describe a change being born or moving, the
 * record is written in the change's own transaction (`recordDomainEventIn`)
 * and the same event is published after the commit (`publishDomainEvent`).
 */
import { v4 as uuidv4 } from 'uuid'
import { publish, recordEventIn } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import { enqueueOutboundWebhooks } from '../jobs/webhookDeliveryWorker.js'
import { logger } from './logger.js'

/** A domain event of the tenant, with a new id: the id the outbox, the consumers and the webhooks know it by. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function domainEvent<T extends Record<string, any>>(
  type:     string,
  tenantId: string,
  userId:   string,
  payload:  T,
  timestamp?: string,
): DomainEvent<T> {
  return {
    id:             uuidv4(),
    type,
    tenant_id:      tenantId,
    timestamp:      timestamp ?? new Date().toISOString(),
    correlation_id: uuidv4(),
    actor_id:       userId,
    payload,
  }
}

/**
 * Writes the event to the outbox inside the caller's write transaction: it
 * exists if and only if the change commits. Publish it after the commit with
 * `publishDomainEvent`, which finds it already written. A process without an
 * outbox (a script, a test) has nothing to write.
 */
export async function recordDomainEventIn(tx: unknown, event: DomainEvent<unknown>): Promise<void> {
  await recordEventIn(tx, event, { webhooks: true })
}

/** Publishes an event already built (and perhaps already recorded), with its outbound webhooks. */
export async function publishDomainEvent(event: DomainEvent<unknown>): Promise<void> {
  const sent = await publish(event, { webhooks: true })
  if (sent?.throughOutbox) return

  /*
   * A process without the outbox (a script, a test): the webhooks are
   * enqueued here, as before the outbox.
   *
   * The outbound webhooks of this event, keyed by ITS id (review of 23 Sep
   * 2026): without it the delivery was keyed by a hash of the payload, and the
   * same payload again within 24 hours — a major incident declared, cleared
   * and declared again, a ticket handed back to the same team — was taken for
   * a duplicate and never delivered.
   *
   * Not awaited, by choice: this runs after the caller's write is committed,
   * and a failure thrown from here would tell the person that an action which
   * happened had failed. The failure is logged with the event, which says
   * which deliveries are missing.
   */
  enqueueOutboundWebhooks(event.tenant_id, event.type, event.payload as Record<string, unknown>, event.id)
    .catch((err: unknown) => logger.error({ err, eventType: event.type, eventId: event.id, tenantId: event.tenant_id }, '[publishEvent] Failed to enqueue outbound webhooks: this event reaches no webhook'))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function publishEvent<T extends Record<string, any>>(
  type:     string,
  tenantId: string,
  userId:   string,
  payload:  T,
  timestamp?: string,
): Promise<void> {
  await publishDomainEvent(domainEvent(type, tenantId, userId, payload, timestamp))
}
