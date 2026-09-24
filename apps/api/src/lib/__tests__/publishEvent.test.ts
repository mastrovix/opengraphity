/**
 * publishEvent: the domain event, then its outbound webhooks.
 *
 * Review of 23 Sep 2026: the webhooks were keyed by a hash of the payload, so
 * the same payload again within a day (a major incident declared, cleared and
 * declared again) was taken for a duplicate and never delivered. They are
 * keyed by the event's own id now. The enqueue is not awaited by choice (the
 * caller's write is already committed): a failure is logged with the event.
 *
 * Wave 7 · B2: in a process with the outbox, the webhooks are part of the
 * send (lib/outbox.ts) and `publishDomainEvent` leaves them to it; a process
 * without one (a script, a test) enqueues them here, as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const published: Array<{ id: string; type: string }> = []
const throughOutbox = vi.hoisted(() => ({ value: false }))
const recordEventIn = vi.fn(async () => undefined)
vi.mock('@opengraphity/events', () => ({
  publish: vi.fn(async (e: { id: string; type: string }) => { published.push(e); return { throughOutbox: throughOutbox.value } }),
  recordEventIn: (...a: unknown[]) => recordEventIn(...a),
}))
const enqueue = vi.fn()
vi.mock('../../jobs/webhookDeliveryWorker.js', () => ({ enqueueOutboundWebhooks: (...a: unknown[]) => enqueue(...a) }))
const logError = vi.fn()
vi.mock('../logger.js', () => ({ logger: { error: (...a: unknown[]) => logError(...a) } }))

const { publishEvent, publishDomainEvent, domainEvent, recordDomainEventIn } = await import('../publishEvent.js')
const { publish } = await import('@opengraphity/events')

beforeEach(() => { published.length = 0; enqueue.mockReset(); logError.mockReset(); throughOutbox.value = false })

describe('publishEvent', () => {
  it('two events with the same payload reach the webhooks as two events, each by its own id', async () => {
    enqueue.mockResolvedValue(undefined)
    const payload = { id: 'inc-1', title: 'Checkout down', major: true }
    await publishEvent('incident.major_declared', 't1', 'u1', payload)
    await publishEvent('incident.major_declared', 't1', 'u1', payload)
    expect(enqueue).toHaveBeenNthCalledWith(1, 't1', 'incident.major_declared', payload, published[0]!.id)
    expect(enqueue).toHaveBeenNthCalledWith(2, 't1', 'incident.major_declared', payload, published[1]!.id)
    expect(published[0]!.id).not.toBe(published[1]!.id)
  })

  it('a failed enqueue does not fail the caller, and is logged with the event', async () => {
    enqueue.mockRejectedValue(new Error('redis down'))
    await expect(publishEvent('ticket.updated', 't1', 'u1', { id: 'x' })).resolves.toBeUndefined()
    await vi.waitFor(() => expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ticket.updated', eventId: published[0]!.id, tenantId: 't1' }),
      expect.stringContaining('reaches no webhook'),
    ))
  })
})

describe('the outbox (wave 7 · B2)', () => {
  it('an event goes to publish with its webhooks; with the outbox the webhooks are its send, not enqueued here', async () => {
    throughOutbox.value = true
    await publishEvent('incident.created', 't1', 'u1', { id: 'inc-1' }, '2026-09-24T10:00:00.000Z')
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'incident.created', tenant_id: 't1', actor_id: 'u1', timestamp: '2026-09-24T10:00:00.000Z' }), { webhooks: true })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('domainEvent gives every event its own id and correlation, and the time now when none is given', () => {
    const a = domainEvent('ticket.updated', 't1', 'u1', { id: 'x' })
    const b = domainEvent('ticket.updated', 't1', 'u1', { id: 'x' })
    expect(a.id).not.toBe(b.id)
    expect(a.correlation_id).not.toBe(a.id)
    expect(Date.parse(a.timestamp)).not.toBeNaN()
  })

  it('an event recorded in a transaction is published as the SAME event, with the webhooks', async () => {
    enqueue.mockResolvedValue(undefined)
    const event = domainEvent('request.created', 't1', 'u1', { id: 'sr-1' })
    const tx = { run: vi.fn() }
    await recordDomainEventIn(tx, event)
    expect(recordEventIn).toHaveBeenCalledWith(tx, event, { webhooks: true })
    await publishDomainEvent(event)
    expect(published[0]).toBe(event)
  })
})
