import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

// ── bullmq/ioredis mocks: capture the 'failed' handler, never touch Redis ────

type FailedHandler = (job: Job | undefined, err: Error) => void
let failedHandler: FailedHandler | null = null

vi.mock('bullmq', () => ({
  Worker: class {
    constructor(public name: string, public processor: unknown, public opts: unknown) {}
    on(event: string, cb: FailedHandler) { if (event === 'failed') failedHandler = cb }
    async close() {}
  },
}))
vi.mock('ioredis', () => ({
  Redis: class { disconnect() {} async exists() { return 0 } async set() { return 'OK' } },
}))

const { BaseConsumer, getFailedEventCount, onEventFailed, CONSUMER_CONCURRENCY } = await import('../consumer.js')

class TestConsumer extends BaseConsumer<unknown> {
  constructor() { super('test-queue') }
  async process(): Promise<void> {}
  /** The Worker instance (fake) for the concurrency assertion. */
  get workerOpts(): { concurrency: number } { return (this as unknown as { worker: { opts: { concurrency: number } } }).worker.opts }
}

describe('BaseConsumer — concurrency (revisione 2 · D1.1)', () => {
  it('runs 3 jobs in parallel per consumer (was 10: four consumers took 40 of the ~70 slots on one Neo4j pool)', async () => {
    expect(CONSUMER_CONCURRENCY).toBe(3)
    const c = new TestConsumer()
    await c.start()
    expect(c.workerOpts.concurrency).toBe(3)
    await c.stop()
  })
})

function job(attemptsMade: number, attempts: number): Job {
  return {
    name: 'incident.created',
    attemptsMade,
    opts: { attempts },
    data: { id: 'evt-42', type: 'incident.created', tenant_id: 't1', payload: {} },
  } as unknown as Job
}

beforeEach(() => {
  failedHandler = null
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('BaseConsumer — exhausted events are counted and observable (D-33)', () => {
  it('counts only the LAST failed attempt, and notifies listeners', async () => {
    const c = new TestConsumer()
    await c.start()
    expect(failedHandler).not.toBeNull()

    const seen: Array<{ queue: string; eventType: string; eventId: string | undefined; attempts: number }> = []
    const off = onEventFailed((info) => seen.push({ queue: info.queue, eventType: info.eventType, eventId: info.eventId, attempts: info.attempts }))

    const before = getFailedEventCount()
    failedHandler!(job(1, 4), new Error('boom'))   // retry pending
    failedHandler!(job(3, 4), new Error('boom'))   // retry pending
    expect(getFailedEventCount()).toBe(before)
    expect(seen).toHaveLength(0)

    failedHandler!(job(4, 4), new Error('boom'))   // exhausted
    expect(getFailedEventCount()).toBe(before + 1)
    expect(seen).toEqual([{ queue: 'test-queue', eventType: 'incident.created', eventId: 'evt-42', attempts: 4 }])

    off()
    failedHandler!(job(4, 4), new Error('again'))
    expect(getFailedEventCount()).toBe(before + 2)
    expect(seen).toHaveLength(1)   // unsubscribed
    await c.stop()
  })

  it('a job without attempts option is exhausted at the first failure; a throwing listener does not break the worker', async () => {
    const c = new TestConsumer()
    await c.start()
    const before = getFailedEventCount()
    const off = onEventFailed(() => { throw new Error('listener bug') })
    expect(() => failedHandler!(job(1, 1), new Error('x'))).not.toThrow()
    expect(getFailedEventCount()).toBe(before + 1)
    off()
    await c.stop()
  })

  it('logs EXHAUSTED on the final attempt', async () => {
    const c = new TestConsumer()
    await c.start()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    failedHandler!(job(4, 4), new Error('boom'))
    expect(err.mock.calls.some(call => String(call[0]).includes('EXHAUSTED'))).toBe(true)
    await c.stop()
  })
})

/**
 * BullMQ hands the 'failed' handler `undefined` for a job it could not even
 * load (a corrupt payload, a job removed mid-flight). There is nothing left
 * to retry, so it counts as exhausted — and every field of the log line and
 * of the counted record has to survive a job that is not there, or the
 * handler throws inside the worker's own error path and the failure is never
 * recorded at all.
 */
describe('BaseConsumer — a failure with no job at all', () => {
  it('counts it as exhausted and names what it can', async () => {
    const c = new TestConsumer()
    await c.start()
    const seen: Array<{ eventType: string; eventId: string | undefined; attempts: number }> = []
    const off = onEventFailed((i) => seen.push({ eventType: i.eventType, eventId: i.eventId, attempts: i.attempts }))

    failedHandler!(undefined, new Error('job payload unreadable'))

    expect(seen).toEqual([{ eventType: 'unknown', eventId: undefined, attempts: 0 }])
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Job failed: ? (attempt 0/1, EXHAUSTED — event lost)'))
    off()
    await c.stop()
  })

  it('a job whose data carries no event type falls back to the job name', async () => {
    const c = new TestConsumer()
    await c.start()
    const seen: string[] = []
    const off = onEventFailed((i) => seen.push(i.eventType))

    failedHandler!({ name: 'incident.created', attemptsMade: 4, opts: { attempts: 4 }, data: undefined } as unknown as Job,
      new Error('handler threw'))

    expect(seen).toEqual(['incident.created'])
    off()
    await c.stop()
  })
})
