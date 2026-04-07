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

  // Fire-and-forget: enqueue outbound webhooks for this event
  enqueueOutboundWebhooks(tenantId, type, payload as Record<string, unknown>)
    .catch((err: unknown) => logger.error({ err, eventType: type }, '[publishEvent] Failed to enqueue outbound webhooks'))
}
