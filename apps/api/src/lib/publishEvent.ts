/**
 * Shared helper: publishes a domain event AND enqueues outbound webhooks.
 * Use this instead of calling publish() directly to ensure webhooks fire.
 */
import { v4 as uuidv4 } from 'uuid'
import { publish } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import { enqueueOutboundWebhooks } from '../jobs/webhookDeliveryWorker.js'
import { logger } from './logger.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function publishEvent<T extends Record<string, any>>(
  type:     string,
  tenantId: string,
  userId:   string,
  payload:  T,
  timestamp?: string,
): Promise<void> {
  const now = timestamp ?? new Date().toISOString()
  const event: DomainEvent<T> = {
    id:             uuidv4(),
    type,
    tenant_id:      tenantId,
    timestamp:      now,
    correlation_id: uuidv4(),
    actor_id:       userId,
    payload,
  }

  await publish(event)

  /*
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
  enqueueOutboundWebhooks(tenantId, type, payload as Record<string, unknown>, event.id)
    .catch((err: unknown) => logger.error({ err, eventType: type, eventId: event.id, tenantId }, '[publishEvent] Failed to enqueue outbound webhooks: this event reaches no webhook'))
}
