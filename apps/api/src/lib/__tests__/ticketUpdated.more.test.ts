/**
 * `ticket.updated` publication (ticketUpdated.ts).
 *
 * "On update" and "field changed" automations and webhooks only fire if this
 * event is published with the right changed fields. Publishing on a no-op save
 * would re-trigger automations for nothing; publishing on the wrong tenant
 * would leak a ticket change to another customer's webhooks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TICKET_UPDATED_EVENT } from '@opengraphity/types'

const publishEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../publishEvent.js', () => ({ publishEvent: (...a: unknown[]) => publishEvent(...a) }))

const { publishTicketUpdated, ticketDiff } = await import('../ticketUpdated.js')

const ctx = { tenantId: 'acme', userId: 'u1' }

beforeEach(() => publishEvent.mockClear())

describe('publishTicketUpdated', () => {
  it('publishes the changed fields and their previous values, on the caller\'s tenant', async () => {
    await publishTicketUpdated(ctx, 'incident', 'INC1',
      { title: 'A', severity: 'low', updated_at: '1' },
      { title: 'A', severity: 'high', updated_at: '2' })
    expect(publishEvent).toHaveBeenCalledWith(TICKET_UPDATED_EVENT, 'acme', 'u1', {
      entity_type: 'incident', entity_id: 'INC1', changed_fields: ['severity'], previous: { severity: 'low' },
    })
  })

  it('a save that only touches updated_at publishes nothing', async () => {
    await publishTicketUpdated(ctx, 'incident', 'INC1', { title: 'A', updated_at: '1' }, { title: 'A', updated_at: '2' })
    expect(publishEvent).not.toHaveBeenCalled()
  })

  it('a publish failure reaches the caller instead of being swallowed', async () => {
    publishEvent.mockRejectedValueOnce(new Error('redis down'))
    await expect(publishTicketUpdated(ctx, 'change', 'CHG1', { a: 1 }, { a: 2 })).rejects.toThrow('redis down')
  })
})

describe('ticketDiff edge cases', () => {
  it('null and undefined are the same "no value"; objects compare by content', () => {
    expect(ticketDiff({ a: null, o: { x: 1 } }, { a: undefined, o: { x: 1 } }).changed).toEqual([])
    expect(ticketDiff({ o: { x: 1 } }, { o: { x: 2 } })).toEqual({ changed: ['o'], previous: { o: { x: 1 } } })
  })

  it('a value cleared to null is a change, and one from object to string too', () => {
    expect(ticketDiff({ a: 'x', o: { x: 1 } }, { a: null, o: 'x' }).changed).toEqual(['a', 'o'])
  })
})
