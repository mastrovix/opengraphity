/**
 * A fake of lib/publishEvent.ts for the tests of the services that create
 * tickets (wave 7 · B2).
 *
 * They build the `.created` event with `domainEvent`, record it in the
 * creation's transaction with `recordDomainEventIn` and publish it after the
 * commit with `publishDomainEvent`. The tests keep looking where they always
 * did: a published event reaches `publishEvent(type, tenant, actor, payload,
 * timestamp?)` — the timestamp only when the service gave one, as before.
 * `recordDomainEventIn` is observable, to check the event is written inside
 * the transaction that creates the ticket.
 *
 * Use: `vi.mock('../../lib/publishEvent.js', () => import('../../lib/__tests__/publishEventFake.js'))`.
 */
import { vi } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

export const publishEvent = vi.fn(async (..._args: unknown[]) => undefined)

/** Events built with the timestamp the service passed, if any (`undefined` otherwise): what `publishEvent` saw before. */
const givenTimestamp = new WeakMap<object, string | undefined>()

export function domainEvent<T>(type: string, tenantId: string, userId: string, payload: T, timestamp?: string): DomainEvent<T> {
  const event: DomainEvent<T> = {
    id: `evt-${type}`, type, tenant_id: tenantId, timestamp: timestamp ?? new Date().toISOString(),
    correlation_id: 'corr-test', actor_id: userId, payload,
  }
  givenTimestamp.set(event, timestamp)
  return event
}

export const recordDomainEventIn = vi.fn(async (_tx: unknown, _event: DomainEvent<unknown>) => undefined)

export const publishDomainEvent = vi.fn(async (event: DomainEvent<unknown>) => {
  const ts = givenTimestamp.has(event) ? givenTimestamp.get(event) : event.timestamp
  await (ts === undefined
    ? publishEvent(event.type, event.tenant_id, event.actor_id, event.payload)
    : publishEvent(event.type, event.tenant_id, event.actor_id, event.payload, ts))
})
