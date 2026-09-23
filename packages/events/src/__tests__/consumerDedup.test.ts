import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'
import type { DomainEvent } from '@opengraphity/types'

// consumer.test.ts covers the exhausted-event accounting. Here: the processor
// itself — idempotency via Redis (EXISTS before, SET EX after success).

type Processor = (job: Job) => Promise<void>

const fake = vi.hoisted(() => {
  const state = {
    processor: null as Processor | null,
    worker: null as { name: string; opts: unknown } | null,
    keys: new Map<string, { value: string; ttl: number }>(),
    existsCalls: [] as string[],
    setCalls: [] as Array<[string, string, string, number]>,
    reset() { this.processor = null; this.worker = null; this.keys.clear(); this.existsCalls = []; this.setCalls = [] },
  }
  class Worker {
    constructor(public name: string, processor: Processor, public opts: unknown) { state.processor = processor; state.worker = this }
    on() { return this }
    async close() {}
  }
  class Queue {
    constructor(public name: string) {}
    on() { return this }
    async resume() {}
    async pause() {}
    async close() {}
  }
  class Redis {
    constructor(public opts: unknown) {}
    on() { return this }
    async quit() { return 'OK' }
    disconnect() {}
    async exists(key: string) { state.existsCalls.push(key); return state.keys.has(key) ? 1 : 0 }
    async set(key: string, value: string, mode: string, ttl: number) { state.setCalls.push([key, value, mode, ttl]); state.keys.set(key, { value, ttl }); return 'OK' }
  }
  return { state, Worker, Queue, Redis }
})

vi.mock('bullmq', () => ({ Worker: fake.Worker, Queue: fake.Queue }))
vi.mock('ioredis', () => ({ Redis: fake.Redis }))

const { BaseConsumer } = await import('../consumer.js')
const { reconcileTenantPools, resetTenantQueuesForTests } = await import('../tenantQueues.js')

/** Starts a consumer and gives it tenant t1, as the host does at boot. */
async function started<C extends { start(): Promise<void> }>(c: C): Promise<C> {
  await c.start()
  await reconcileTenantPools([{ id: 't1', suspended: false }])
  return c
}

class TestConsumer extends BaseConsumer<unknown> {
  readonly process = vi.fn<(event: DomainEvent<unknown>) => Promise<void>>(async () => {})
  constructor() { super('notification-service') }
}

function job(data: Partial<DomainEvent<unknown>>): Job {
  return { name: data.type ?? 'x', data, attemptsMade: 1, opts: { attempts: 4 } } as unknown as Job
}
const evt = (id: string | undefined, type = 'incident.created'): Partial<DomainEvent<unknown>> =>
  ({ id: id as string, type, tenant_id: 't1', timestamp: 'now', correlation_id: 'c', actor_id: 'u', payload: {} })

beforeEach(() => {
  resetTenantQueuesForTests()
  fake.state.reset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('BaseConsumer — idempotent processing (at-least-once delivery)', () => {
  it('first delivery: process() runs, then the event id is marked processed with a 24h TTL', async () => {
    const c = await started(new TestConsumer())
    await fake.state.processor!(job(evt('evt-1')))
    expect(c.process).toHaveBeenCalledTimes(1)
    expect(fake.state.existsCalls).toEqual(['evt:processed:notification-service:evt-1'])
    expect(fake.state.setCalls).toEqual([['evt:processed:notification-service:evt-1', '1', 'EX', 24 * 60 * 60]])
    await c.stop()
  })

  it('same event id delivered twice → process() runs ONCE', async () => {
    const c = await started(new TestConsumer())
    await fake.state.processor!(job(evt('evt-1')))
    await fake.state.processor!(job(evt('evt-1')))
    expect(c.process).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.log).mock.calls.some(call => String(call[0]).includes('Already processed, skipping: evt-1'))).toBe(true)
    await c.stop()
  })

  it('the dedup key is per queue: another consumer of the same event is not blocked', async () => {
    const c = await started(new TestConsumer())
    fake.state.keys.set('evt:processed:sla-engine:evt-1', { value: '1', ttl: 1 })   // processed by ANOTHER queue
    await fake.state.processor!(job(evt('evt-1')))
    expect(c.process).toHaveBeenCalledTimes(1)
    await c.stop()
  })

  it('process() failing → NOT marked processed (a retry must re-run it) and the error propagates to BullMQ', async () => {
    const c = await started(new TestConsumer())
    c.process.mockRejectedValueOnce(new Error('neo4j down'))
    await expect(fake.state.processor!(job(evt('evt-1')))).rejects.toThrow('neo4j down')
    expect(fake.state.setCalls).toHaveLength(0)
    // the retry goes through
    await fake.state.processor!(job(evt('evt-1')))
    expect(c.process).toHaveBeenCalledTimes(2)
    expect(fake.state.setCalls).toHaveLength(1)
    await c.stop()
  })

  // BUG (packages/events/src/consumer.ts:79-83): the dedup key is built from
  // `event.id` without checking it. Two DIFFERENT events lacking an id share the
  // key `evt:processed:<queue>:undefined`: after the first succeeds, every other
  // id-less event is silently skipped for 24h. Expected: reject the malformed
  // event explicitly (fail-loud) — or at least never dedup on a missing id.
  it('an event without id is rejected explicitly (fail-loud) and never deduplicated under "…:undefined"', async () => {
    const c = await started(new TestConsumer())
    await expect(fake.state.processor!(job(evt(undefined, 'incident.created')))).rejects.toThrow(/without id/)
    expect(c.process).not.toHaveBeenCalled()
    expect(fake.state.setCalls).toHaveLength(0)
    await c.stop()
  })

  it('worker wiring: queue name, concurrency 3 (revisione 2 · D1.1), custom backoff 5s / 30s / 5min (capped)', async () => {
    const c = await started(new TestConsumer())
    const w = fake.state.worker!
    expect(w.name).toBe('notification-service@t1')
    const opts = w.opts as { concurrency: number; settings: { backoffStrategy: (attemptsMade: number) => number } }
    expect(opts.concurrency).toBe(3)
    expect([1, 2, 3, 4, 9].map(a => opts.settings.backoffStrategy(a))).toEqual([5_000, 30_000, 300_000, 300_000, 300_000])
    await c.stop()
  })
})

/**
 * `handles()` — the filter that stops the fan-out from costing (E-33).
 *
 * Every event goes to all five queues, so the SLA engine was also receiving
 * `event.received`, `ci.health_changed`, `ticket.updated`… and doing an
 * EXISTS plus a SET on Redis for each one. During an alarm storm that was
 * thousands of Redis operations a minute, and a log line per event burying
 * everything else.
 *
 * The point of the filter is WHERE it sits: before the dedup, not after. A
 * consumer that declares what it handles must cost nothing for the rest.
 */
describe('BaseConsumer — handles(): what does not concern me costs nothing', () => {
  class PickyConsumer extends BaseConsumer<unknown> {
    readonly process = vi.fn<(event: DomainEvent<unknown>) => Promise<void>>(async () => {})
    constructor() { super('sla-service') }
    protected override handles(type: string): boolean { return type.startsWith('incident.') }
  }

  it('an event outside the declared types is dropped BEFORE Redis: no EXISTS, no SET, no process()', async () => {
    const c = await started(new PickyConsumer())
    await fake.state.processor!(job(evt('evt-1', 'ci.health_changed')))
    expect(c.process).not.toHaveBeenCalled()
    expect(fake.state.existsCalls).toEqual([])
    expect(fake.state.setCalls).toEqual([])
    await c.stop()
  })

  it('a declared event goes through the whole path as before', async () => {
    const c = await started(new PickyConsumer())
    await fake.state.processor!(job(evt('evt-2', 'incident.created')))
    expect(c.process).toHaveBeenCalledOnce()
    expect(fake.state.existsCalls).toEqual(['evt:processed:sla-service:evt-2'])
    await c.stop()
  })

  it('by default a consumer handles everything: the fan-out stays the rule', async () => {
    // Only those who opt in filter. Making the filter the default would
    // silently starve any consumer that forgot to declare its types.
    const c = await started(new TestConsumer())
    await fake.state.processor!(job(evt('evt-3', 'anything.at.all')))
    expect(c.process).toHaveBeenCalledOnce()
    await c.stop()
  })
})

/**
 * The dedup marker is written AFTER success, and its failure is not the
 * transition's failure: the side effects already happened. A missed marker
 * risks a duplicate on the next redelivery — which is worse to cause by
 * re-running process() than to accept and say out loud.
 */
describe('BaseConsumer — when Redis is only half there', () => {
  it('a marker that cannot be written is logged, and the event still counts as processed', async () => {
    const c = await started(new TestConsumer())
    const setError = new Error('READONLY replica')
    vi.spyOn(fake.Redis.prototype, 'set').mockRejectedValueOnce(setError)
    await expect(fake.state.processor!(job(evt('evt-9')))).resolves.toBeUndefined()
    expect(c.process).toHaveBeenCalledOnce()
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('processed evt-9 but the dedup marker was NOT written:'), setError)
    await c.stop()
  })

  it('stop() is safe on a consumer that was never started', async () => {
    // The API calls stop() on every consumer while shutting down, including
    // ones whose start() threw: a TypeError here would mask the real reason.
    await expect(new TestConsumer().stop()).resolves.toBeUndefined()
  })
})
