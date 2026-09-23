/**
 * lib/tenantQueueLifecycle.ts — the tenant queues follow the tenants
 * (owner's decision, 23 Sep 2026).
 *
 * Why these behaviours matter:
 *  - a tenant that exists must have its workers in every process, or its
 *    timers, webhooks and notifications silently never run;
 *  - a suspended tenant's queues are paused: the graph says so with
 *    `suspended_at`, and nothing else is read as suspension;
 *  - at boot a queue that cannot be set up stops the process, as a failed
 *    scheduler registration always did: a process that runs without a
 *    tenant's workers looks healthy while that tenant's work piles up;
 *  - a change is announced on a Redis channel so every process reconciles at
 *    once, and a lost announcement costs at most the periodic pass (a minute);
 *    a failed publish is said, never thrown at the platform console;
 *  - every reconciliation leaves the process's heartbeat under its hostname:
 *    the liveness probe of the worker containers reads it, and a process that
 *    stops takes it away.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'

const h = vi.hoisted(() => ({
  rows: [] as Array<{ id: string; suspended: boolean }>,
  queries: [] as string[],
  outcome: { added: [], removed: [], paused: [], resumed: [], failures: [] } as Record<string, unknown>,
  published: [] as Array<[string, string]>,
  publishError: null as Error | null,
  heartbeats: [] as unknown[][],
  deleted: [] as string[],
  subscribers: [] as unknown[],
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: vi.fn().mockResolvedValue(undefined) }),
  runQuery: vi.fn(async (_s: unknown, q: string) => { h.queries.push(q); return h.rows }),
}))
const reconcileTenantPools = vi.fn(async (_tenants: unknown) => h.outcome)
vi.mock('@opengraphity/events', () => ({
  getRedisConnection: () => ({ host: 'redis', port: 6379 }),
  reconcileTenantPools: (tenants: unknown) => reconcileTenantPools(tenants),
}))
vi.mock('../bullmq.js', () => ({
  getSharedRedis: () => ({
    publish: vi.fn(async (channel: string, message: string) => {
      if (h.publishError) throw h.publishError
      h.published.push([channel, message])
      return 1
    }),
    set: vi.fn(async (...args: unknown[]) => { h.heartbeats.push(args); return 'OK' }),
    del: vi.fn(async (key: string) => { h.deleted.push(key); return 1 }),
  }),
}))
vi.mock('node:os', () => ({ hostname: () => 'worker-7f3a' }))
class FakeSubscriber extends EventEmitter {
  subscribe = vi.fn().mockResolvedValue(1)
  quit = vi.fn().mockResolvedValue('OK')
  disconnect = vi.fn()
  constructor(public opts: Record<string, unknown>) { super(); h.subscribers.push(this) }
}
vi.mock('ioredis', () => ({ Redis: vi.fn(function (opts: Record<string, unknown>) { return new FakeSubscriber(opts) }) }))

const logInfo = vi.fn()
const logError = vi.fn()
vi.mock('../logger.js', () => ({
  logger: { child: () => ({ info: logInfo, error: logError, warn: vi.fn(), debug: vi.fn() }) },
}))

const {
  loadTenantStates, reconcileTenantQueues, startTenantQueueLifecycle, stopTenantQueueLifecycle,
  announceTenantChange, tenantsWithQueues, TENANT_QUEUES_CHANNEL, TENANT_QUEUES_RECONCILE_MS,
} = await import('../tenantQueueLifecycle.js')

const OK = { added: [], removed: [], paused: [], resumed: [], failures: [] }

beforeEach(() => {
  vi.clearAllMocks()
  h.rows = [{ id: 'acme', suspended: false }, { id: 'globex', suspended: true }]
  h.queries = []
  h.outcome = { ...OK }
  h.published = []
  h.publishError = null
  h.heartbeats = []
  h.deleted = []
  h.subscribers = []
})
afterEach(async () => {
  await stopTenantQueueLifecycle()
  vi.useRealTimers()
})

describe('loadTenantStates', () => {
  it('reads every tenant of the graph, suspension from suspended_at', async () => {
    expect(await loadTenantStates()).toEqual([{ id: 'acme', suspended: false }, { id: 'globex', suspended: true }])
    expect(h.queries[0]).toContain('MATCH (t:Tenant)')
    expect(h.queries[0]).toContain('t.suspended_at IS NOT NULL AS suspended')
  })

  it('a suspended flag that is not literally true is not a suspension', async () => {
    h.rows = [{ id: 'acme', suspended: null as unknown as boolean }]
    expect(await loadTenantStates()).toEqual([{ id: 'acme', suspended: false }])
  })
})

describe('reconcileTenantQueues', () => {
  it('hands the tenants to the pools and remembers them for the metrics', async () => {
    await reconcileTenantQueues('test')
    expect(reconcileTenantPools).toHaveBeenCalledWith(h.rows)
    expect(tenantsWithQueues()).toEqual(h.rows)
  })

  it('says what changed, and nothing when nothing did', async () => {
    await reconcileTenantQueues('quiet')
    expect(logInfo).not.toHaveBeenCalled()
    h.outcome = { ...OK, added: ['sla-jobs@acme'], paused: ['sla-jobs@globex'] }
    await reconcileTenantQueues('boot')
    expect(logInfo).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'boot', tenants: 2, added: 1, paused: ['sla-jobs@globex'] }), 'tenant queues reconciled')
  })

  it('leaves the heartbeat of this process under its hostname, with the number of tenants, for three minutes', async () => {
    await reconcileTenantQueues('periodic')
    expect(h.heartbeats).toHaveLength(1)
    const [key, value, ex, ttl] = h.heartbeats[0] as [string, string, string, number]
    expect(key).toBe('og:tenant-queues:alive:worker-7f3a')
    expect(JSON.parse(value)).toEqual({ tenants: 2, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) })
    expect([ex, ttl]).toEqual(['EX', 180])
  })

  it('a queue that could not be reconciled is logged with its reason, and the pass still returns', async () => {
    h.outcome = { ...OK, failures: [{ queue: 'sla-jobs@acme', error: 'redis down' }] }
    const out = await reconcileTenantQueues('periodic')
    expect(out.failures).toHaveLength(1)
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'periodic', failures: [{ queue: 'sla-jobs@acme', error: 'redis down' }] }), expect.stringContaining('next pass retries'))
  })
})

describe('startTenantQueueLifecycle', () => {
  it('gives the pools their tenants at boot, then listens on the channel', async () => {
    await startTenantQueueLifecycle()
    expect(reconcileTenantPools).toHaveBeenCalledTimes(1)
    const sub = h.subscribers[0] as FakeSubscriber
    // A subscriber waits for messages for ever: no per-request retry limit.
    expect(sub.opts).toMatchObject({ host: 'redis', maxRetriesPerRequest: null })
    expect(sub.subscribe).toHaveBeenCalledWith(TENANT_QUEUES_CHANNEL)
  })

  it('a queue that cannot be set up at boot stops the boot, naming it', async () => {
    h.outcome = { ...OK, failures: [{ queue: 'webhook-delivery@acme', error: 'NOAUTH' }] }
    await expect(startTenantQueueLifecycle()).rejects.toThrow('tenant queues could not be set up at boot: webhook-delivery@acme: NOAUTH')
    expect(h.subscribers).toHaveLength(0)
  })

  it('an announcement heard on the channel reconciles this process at once', async () => {
    await startTenantQueueLifecycle()
    const sub = h.subscribers[0] as FakeSubscriber
    sub.emit('message', TENANT_QUEUES_CHANNEL, JSON.stringify({ tenantId: 'initech', change: 'created' }))
    await vi.waitFor(() => expect(reconcileTenantPools).toHaveBeenCalledTimes(2))
  })

  it('reconciles every minute anyway: an announcement lost while disconnected costs at most a minute', async () => {
    vi.useFakeTimers()
    await startTenantQueueLifecycle()
    expect(TENANT_QUEUES_RECONCILE_MS).toBe(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reconcileTenantPools).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reconcileTenantPools).toHaveBeenCalledTimes(3)
  })

  it('a periodic pass that fails is logged and the next one runs', async () => {
    vi.useFakeTimers()
    await startTenantQueueLifecycle()
    reconcileTenantPools.mockRejectedValueOnce(new Error('neo4j down'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ reason: 'periodic' }), expect.stringContaining('reconciliation failed'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reconcileTenantPools).toHaveBeenCalledTimes(3)
  })

  it('starting twice does not subscribe twice', async () => {
    await startTenantQueueLifecycle()
    await startTenantQueueLifecycle()
    expect(h.subscribers).toHaveLength(1)
  })
})

describe('announceTenantChange', () => {
  it('reconciles here first, then tells every other process', async () => {
    await announceTenantChange('initech', 'suspended')
    expect(reconcileTenantPools).toHaveBeenCalledTimes(1)
    expect(h.published).toEqual([[TENANT_QUEUES_CHANNEL, JSON.stringify({ tenantId: 'initech', change: 'suspended' })]])
  })

  it('a failed publish is said, not thrown: the others catch up at their next pass', async () => {
    h.publishError = new Error('READONLY')
    await expect(announceTenantChange('initech', 'deleted')).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'initech', change: 'deleted' }), expect.stringContaining('could not be announced'))
  })
})

describe('stopTenantQueueLifecycle', () => {
  it('stops the periodic pass, closes the subscriber and takes the heartbeat away; stopping twice is harmless', async () => {
    vi.useFakeTimers()
    await startTenantQueueLifecycle()
    await stopTenantQueueLifecycle()
    expect((h.subscribers[0] as FakeSubscriber).quit).toHaveBeenCalled()
    expect(h.deleted).toEqual(['og:tenant-queues:alive:worker-7f3a'])
    await vi.advanceTimersByTimeAsync(120_000)
    expect(reconcileTenantPools).toHaveBeenCalledTimes(1)
    await expect(stopTenantQueueLifecycle()).resolves.toBeUndefined()
    expect(h.deleted).toHaveLength(1)
  })
})
