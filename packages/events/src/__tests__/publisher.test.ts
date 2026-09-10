import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DomainEvent } from '@opengraphity/types'

// ── bullmq mock: capture every Queue and its add() ───────────────────────────

const fake = vi.hoisted(() => {
  interface FakeQueue {
    name: string
    opts: unknown
    add: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
  }
  const instances: FakeQueue[] = []
  /** queue name whose add() rejects */
  const state = { failOn: null as string | null }
  class Queue implements FakeQueue {
    add: ReturnType<typeof vi.fn>
    close: ReturnType<typeof vi.fn>
    constructor(public name: string, public opts: unknown) {
      this.add = vi.fn(async () => {
        if (state.failOn === this.name) throw new Error(`redis write failed on ${this.name}`)
        return { id: 'job' }
      })
      this.close = vi.fn(async () => {})
      instances.push(this)
    }
  }
  return { instances, state, Queue }
})

vi.mock('bullmq', () => ({ Queue: fake.Queue, Worker: class {} }))

const { publish } = await import('../publisher.js')
const { closeConnection, openQueueCount } = await import('../connection.js')

function event(type = 'incident.created'): DomainEvent<{ id: string }> {
  return { id: 'evt-1', type, tenant_id: 't1', timestamp: '2026-09-08T10:00:00.000Z', correlation_id: 'c-1', actor_id: 'u-1', payload: { id: 'inc-1' } }
}

const byName = (name: string) => fake.instances.filter(q => q.name === name)

beforeEach(async () => {
  fake.state.failOn = null
  vi.restoreAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  await closeConnection()          // drop the cached queues from the previous test
  fake.instances.length = 0
  delete process.env['REDIS_URL']
  process.env['REDIS_HOST'] = 'redis.test'
  process.env['REDIS_PORT'] = '6390'
})

describe('publish — fan-out to every consumer queue', () => {
  it('opens one Queue per consumer (notification-service, sla-engine, escalation-consumer, service-impact-consumer) on the shared Redis options', async () => {
    await publish(event())
    expect(fake.instances.map(q => q.name)).toEqual(['notification-service', 'sla-engine', 'escalation-consumer', 'service-impact-consumer'])
    for (const q of fake.instances) {
      expect(q.opts).toEqual({ connection: { host: 'redis.test', port: 6390 } })
    }
    expect(openQueueCount()).toBe(4)
  })

  it('adds the SAME event to each queue, job name = event type, retry policy attached, no explicit jobId (dedup is consumer-side by event.id)', async () => {
    const e = event('change.approved')
    await publish(e)
    for (const q of fake.instances) {
      expect(q.add).toHaveBeenCalledTimes(1)
      const [name, data, opts] = q.add.mock.calls[0]! as [string, unknown, Record<string, unknown>]
      expect(name).toBe('change.approved')
      expect(data).toBe(e)
      expect(opts).toEqual({ attempts: 4, backoff: { type: 'custom' }, removeOnComplete: true, removeOnFail: 100 })
      expect(opts).not.toHaveProperty('jobId')
    }
    expect(vi.mocked(console.log).mock.calls.some(c => String(c[0]).includes('Published: change.approved (id: evt-1)'))).toBe(true)
  })

  it('reuses the queues across publishes (no reconnect per event)', async () => {
    await publish(event())
    await publish(event('incident.resolved'))
    expect(fake.instances).toHaveLength(4)
    expect(byName('sla-engine')[0]!.add).toHaveBeenCalledTimes(2)
    expect(openQueueCount()).toBe(4)
  })

  it('one queue failing → publish REJECTS with that error (no silent partial success); the other queues were still attempted (Promise.all)', async () => {
    fake.state.failOn = 'sla-engine'
    await expect(publish(event())).rejects.toThrow('redis write failed on sla-engine')
    expect(byName('notification-service')[0]!.add).toHaveBeenCalledTimes(1)
    expect(byName('escalation-consumer')[0]!.add).toHaveBeenCalledTimes(1)
    expect(byName('service-impact-consumer')[0]!.add).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.log).mock.calls.some(c => String(c[0]).includes('Published:'))).toBe(false)
  })

  it('after closeConnection() the next publish opens FRESH queues instead of reusing closed ones', async () => {
    await publish(event())
    const first = [...fake.instances]
    await closeConnection()
    for (const q of first) expect(q.close).toHaveBeenCalledTimes(1)
    expect(openQueueCount()).toBe(0)

    await publish(event())
    expect(fake.instances).toHaveLength(8)
    const second = fake.instances.slice(4)
    expect(second.every(q => !first.includes(q))).toBe(true)
    for (const q of first) expect(q.add).toHaveBeenCalledTimes(1)   // not reused
    for (const q of second) expect(q.add).toHaveBeenCalledTimes(1)
    expect(openQueueCount()).toBe(4)
  })
})
