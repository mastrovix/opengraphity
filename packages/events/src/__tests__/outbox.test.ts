/**
 * Publishing through the outbox (wave 7 · B2). What must hold:
 *  - without an outbox (a script, a test) the event is sent straight away,
 *    and a failed send is the caller's error, as before;
 *  - with one, the event is written down BEFORE it is sent, the process's
 *    extras (the webhooks) are part of the send, and it is marked after;
 *  - once written, a failed send is not the caller's failure: the change is
 *    committed and the repeater sends the event;
 *  - an event that could not even be written is still sent, and if that
 *    fails too the error is thrown — lost, loudly;
 *  - `recordEventIn` writes inside the caller's transaction, and does
 *    nothing without an outbox.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

const queues = vi.hoisted(() => ({ added: [] as Array<{ queue: string; jobId: unknown }>, failOn: null as string | null }))
vi.mock('../tenantQueues.js', () => ({
  tenantQueue: (base: string, tenantId: string) => ({
    add: vi.fn(async (_name: string, _data: unknown, opts: { jobId: unknown }) => {
      if (queues.failOn === base) throw new Error(`redis write failed on ${base}`)
      queues.added.push({ queue: `${base}@${tenantId}`, jobId: opts.jobId })
    }),
  }),
}))

const { publish, CONSUMER_QUEUES } = await import('../publisher.js')
const { registerEventOutbox, clearEventOutbox, recordEventIn, currentEventOutbox } = await import('../outbox.js')

const event: DomainEvent<{ id: string }> = {
  id: 'evt-1', type: 'incident.created', tenant_id: 't1', timestamp: '2026-09-24T10:00:00.000Z', correlation_id: 'c-1', actor_id: 'u-1', payload: { id: 'inc-1' },
}

function fakeOutbox() {
  const steps: string[] = []
  const o = {
    steps,
    record:        vi.fn(async () => { steps.push('record') }),
    recordIn:      vi.fn(async () => { steps.push('recordIn') }),
    deliverExtras: vi.fn(async () => { steps.push('extras') }),
    markSent:      vi.fn(async () => { steps.push('markSent') }),
  }
  registerEventOutbox(o)
  return o
}

beforeEach(() => {
  queues.added.length = 0
  queues.failOn = null
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { clearEventOutbox(); vi.restoreAllMocks() })

describe('publish without an outbox', () => {
  it('sends to every consumer queue of the tenant, keyed by the event id, and says it did not go through an outbox', async () => {
    expect(currentEventOutbox()).toBeNull()
    await expect(publish(event)).resolves.toEqual({ throughOutbox: false })
    expect(queues.added).toEqual(CONSUMER_QUEUES.map((q) => ({ queue: `${q}@t1`, jobId: 'evt-1' })))
  })

  it('a failed send is the caller\'s error, as before', async () => {
    queues.failOn = 'sla-engine'
    await expect(publish(event)).rejects.toThrow('redis write failed on sla-engine')
  })
})

describe('publish through the outbox', () => {
  it('writes the event down before sending it, delivers the extras with the send, and marks it after', async () => {
    const o = fakeOutbox()
    await expect(publish(event, { webhooks: true })).resolves.toEqual({ throughOutbox: true })
    expect(o.steps).toEqual(['record', 'extras', 'markSent'])
    expect(o.record).toHaveBeenCalledWith(event, { webhooks: true })
    expect(o.deliverExtras).toHaveBeenCalledWith(event, { webhooks: true })
    expect(queues.added).toHaveLength(CONSUMER_QUEUES.length)
  })

  it('once written, a failed send is not the caller\'s failure: not marked, the repeater sends it', async () => {
    const o = fakeOutbox()
    queues.failOn = 'notification-service'
    await expect(publish(event)).resolves.toEqual({ throughOutbox: true })
    expect(o.markSent).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('the outbox repeater sends it'), expect.any(Error))
  })

  it('an extra that fails (the webhooks) leaves it unmarked too: the repeater delivers both', async () => {
    const o = fakeOutbox()
    o.deliverExtras.mockRejectedValueOnce(new Error('webhook queue down'))
    await publish(event, { webhooks: true })
    expect(o.markSent).not.toHaveBeenCalled()
  })

  it('an event that could not be written is still sent; if the send fails too, the error is thrown', async () => {
    const o = fakeOutbox()
    o.record.mockRejectedValue(new Error('neo4j down'))
    await expect(publish(event)).resolves.toEqual({ throughOutbox: true })
    expect(queues.added).toHaveLength(CONSUMER_QUEUES.length)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('was NOT written to the outbox'), expect.any(Error))

    queues.failOn = 'sla-engine'
    await expect(publish(event)).rejects.toThrow('redis write failed on sla-engine')
  })

  it('sent but not marked is only a warning: the consumers skip the second send', async () => {
    const o = fakeOutbox()
    o.markSent.mockRejectedValueOnce(new Error('neo4j down'))
    await expect(publish(event)).resolves.toEqual({ throughOutbox: true })
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('was sent but not marked'), expect.any(Error))
  })
})

describe('recordEventIn', () => {
  it('writes inside the caller\'s transaction, with the options', async () => {
    const o = fakeOutbox()
    const tx = { run: vi.fn() }
    await recordEventIn(tx, event, { webhooks: true })
    expect(o.recordIn).toHaveBeenCalledWith(tx, event, { webhooks: true })
  })

  it('without an outbox there is nothing to write', async () => {
    await expect(recordEventIn({ run: vi.fn() }, event)).resolves.toBeUndefined()
  })
})
