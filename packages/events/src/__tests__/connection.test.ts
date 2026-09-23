import { describe, it, expect, vi, beforeEach } from 'vitest'

const fake = vi.hoisted(() => {
  const state = { failClose: null as string | null }
  class Queue {
    close = vi.fn(async () => { if (state.failClose === this.name) throw new Error('redis gone') })
    constructor(public name: string) {}
    on() { return this }
  }
  class Redis {
    quit = vi.fn(async () => 'OK')
    on() { return this }
    disconnect() {}
  }
  return { state, Queue, Redis }
})
vi.mock('bullmq', () => ({ Queue: fake.Queue, Worker: class {} }))
vi.mock('ioredis', () => ({ Redis: fake.Redis }))

const { closeConnection, openQueueCount } = await import('../connection.js')
const { tenantQueue, resetTenantQueuesForTests } = await import('../tenantQueues.js')

beforeEach(() => {
  resetTenantQueuesForTests()
  fake.state.failClose = null
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('closeConnection — really closes the queues the package opened (D-24)', () => {
  it('closes every producer queue once and empties the registry; idempotent', async () => {
    const q1 = tenantQueue('sla-engine', 't1') as unknown as InstanceType<typeof fake.Queue>
    const q2 = tenantQueue('sla-engine', 't2') as unknown as InstanceType<typeof fake.Queue>
    expect(openQueueCount()).toBe(2)

    await closeConnection()
    expect(q1.close).toHaveBeenCalledTimes(1)
    expect(q2.close).toHaveBeenCalledTimes(1)
    expect(openQueueCount()).toBe(0)

    await closeConnection()
    expect(q1.close).toHaveBeenCalledTimes(1)
  })

  it('propagates a queue close failure (shutdown must see it)', async () => {
    tenantQueue('sla-engine', 't1')
    fake.state.failClose = 'sla-engine@t1'
    await expect(closeConnection()).rejects.toThrow('redis gone')
    expect(openQueueCount()).toBe(0)
  })
})
