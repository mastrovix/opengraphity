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
    on() { return this }
    constructor(public name: string, public opts: unknown) {
      this.add = vi.fn(async () => {
        if (state.failOn === this.name) throw new Error(`redis write failed on ${this.name}`)
        return { id: 'job' }
      })
      this.close = vi.fn(async () => {})
      instances.push(this)
    }
  }
  const connections: unknown[] = []
  class Redis {
    constructor(public opts: unknown) { connections.push(this) }
    on() { return this }
    async quit() { return 'OK' }
    disconnect() {}
  }
  return { instances, state, Queue, Redis, connections }
})

vi.mock('bullmq', () => ({ Queue: fake.Queue, Worker: class {} }))
vi.mock('ioredis', () => ({ Redis: fake.Redis }))

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
  fake.connections.length = 0
  delete process.env['REDIS_URL']
  process.env['REDIS_HOST'] = 'redis.test'
  process.env['REDIS_PORT'] = '6390'
})

describe('publish — fan-out to every consumer queue of the event\'s tenant', () => {
  it('opens one Queue per consumer for the tenant (<consumer>@<tenant>), all on ONE shared Redis connection', async () => {
    await publish(event())
    expect(fake.instances.map(q => q.name)).toEqual(['notification-service@t1', 'sla-engine@t1', 'escalation-consumer@t1', 'service-impact-consumer@t1', 'automation-consumer@t1'])
    expect(fake.connections).toHaveLength(1)
    expect((fake.connections[0] as { opts: unknown }).opts).toEqual({ host: 'redis.test', port: 6390 })
    for (const q of fake.instances) {
      expect(q.opts).toEqual({ connection: fake.connections[0] })
    }
    expect(openQueueCount()).toBe(5)
  })

  it('another tenant\'s event goes to that tenant\'s queues', async () => {
    await publish({ ...event(), tenant_id: 't2' })
    expect(fake.instances.map(q => q.name)).toEqual(['notification-service@t2', 'sla-engine@t2', 'escalation-consumer@t2', 'service-impact-consumer@t2', 'automation-consumer@t2'])
  })

  it('an event without a tenant is refused: no queue would ever work it (23 Sep 2026)', async () => {
    await expect(publish({ ...event(), tenant_id: '' })).rejects.toThrow('is not a tenant id')
    expect(fake.instances).toHaveLength(0)
  })

  /**
   * CONTRATTO RINEGOZIATO (revisione totale · E-7). Il fan-out sulle cinque
   * code non è atomico: se una `add` falliva, le altre erano già accodate e
   * chi ritentava ripubblicava l'evento — due notifiche, due volte lo stesso
   * lavoro. Il `jobId` è l'id dell'evento: BullMQ rifiuta un secondo job con
   * lo stesso id sulla stessa coda, quindi il ritentativo completa le code
   * mancanti senza duplicare quelle già servite.
   */
  it('adds the SAME event to each queue, job name = event type, retry policy attached, jobId = event.id (E-7)', async () => {
    const e = event('change.approved')
    await publish(e)
    for (const q of fake.instances) {
      expect(q.add).toHaveBeenCalledTimes(1)
      const [name, data, opts] = q.add.mock.calls[0]! as [string, unknown, Record<string, unknown>]
      expect(name).toBe('change.approved')
      expect(data).toBe(e)
      expect(opts).toEqual({ attempts: 4, backoff: { type: 'custom' }, removeOnComplete: true, removeOnFail: 100, jobId: 'evt-1' })
    }
    expect(vi.mocked(console.log).mock.calls.some(c => String(c[0]).includes('Published: change.approved (id: evt-1, tenant: t1)'))).toBe(true)
  })

  it('reuses the queues across publishes (no reconnect per event)', async () => {
    await publish(event())
    await publish(event('incident.resolved'))
    expect(fake.instances).toHaveLength(5)
    expect(byName('sla-engine@t1')[0]!.add).toHaveBeenCalledTimes(2)
    expect(openQueueCount()).toBe(5)
  })

  it('one queue failing → publish REJECTS with that error (no silent partial success); the other queues were still attempted (Promise.all)', async () => {
    fake.state.failOn = 'sla-engine@t1'
    await expect(publish(event())).rejects.toThrow('redis write failed on sla-engine@t1')
    expect(byName('notification-service@t1')[0]!.add).toHaveBeenCalledTimes(1)
    expect(byName('escalation-consumer@t1')[0]!.add).toHaveBeenCalledTimes(1)
    expect(byName('service-impact-consumer@t1')[0]!.add).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.log).mock.calls.some(c => String(c[0]).includes('Published:'))).toBe(false)
  })

  it('after closeConnection() the next publish opens FRESH queues instead of reusing closed ones', async () => {
    await publish(event())
    const first = [...fake.instances]
    await closeConnection()
    for (const q of first) expect(q.close).toHaveBeenCalledTimes(1)
    expect(openQueueCount()).toBe(0)

    await publish(event())
    expect(fake.instances).toHaveLength(10)
    const second = fake.instances.slice(5)
    expect(second.every(q => !first.includes(q))).toBe(true)
    for (const q of first) expect(q.add).toHaveBeenCalledTimes(1)   // not reused
    for (const q of second) expect(q.add).toHaveBeenCalledTimes(1)
    expect(openQueueCount()).toBe(5)
  })
})
