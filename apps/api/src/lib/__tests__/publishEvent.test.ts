/**
 * publishEvent: the domain event, then its outbound webhooks.
 *
 * Review of 23 Sep 2026: the webhooks were keyed by a hash of the payload, so
 * the same payload again within a day (a major incident declared, cleared and
 * declared again) was taken for a duplicate and never delivered. They are
 * keyed by the event's own id now. The enqueue is not awaited by choice (the
 * caller's write is already committed): a failure is logged with the event.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const published: Array<{ id: string; type: string }> = []
vi.mock('@opengraphity/events', () => ({ publish: vi.fn(async (e: { id: string; type: string }) => { published.push(e) }) }))
const enqueue = vi.fn()
vi.mock('../../jobs/webhookDeliveryWorker.js', () => ({ enqueueOutboundWebhooks: (...a: unknown[]) => enqueue(...a) }))
const logError = vi.fn()
vi.mock('../logger.js', () => ({ logger: { error: (...a: unknown[]) => logError(...a) } }))

const { publishEvent } = await import('../publishEvent.js')

beforeEach(() => { published.length = 0; enqueue.mockReset(); logError.mockReset() })

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
