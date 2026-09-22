/**
 * The metamodel channel between processes: the failure paths.
 *
 * `metamodelBus.test.ts` covers the happy round trip between two processes.
 * These tests cover what happens when Redis misbehaves, because "the channel
 * went quiet and nobody noticed" is exactly the defect the channel exists to
 * fix (another replica rejecting a relation just defined, for five minutes).
 *
 * Why these behaviours matter:
 *  - A failed PUBLISH must never become an error for the user whose mutation
 *    already wrote to Neo4j; it must become a counted, logged error instead.
 *  - Starting the bus twice must not open a second subscriber connection
 *    (each one is a Redis connection, and each would clear caches twice).
 *  - A dropped connection flips `subscribed` to false, so the health view
 *    tells the truth while ioredis reconnects.
 *  - A message on another channel, or a JSON value that is not an object,
 *    must not clear anything.
 *  - A cache that fails to clear on a received message is counted by name:
 *    that process is serving stale metamodel for that tenant.
 *  - Retries never stack up: one pending retry at a time, cancelled when a
 *    reconnection subscribes first, and cancelled on shutdown so a stopped
 *    process does not resubscribe behind the operator's back.
 *  - Shutdown survives a failing QUIT by force-disconnecting.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const hub = vi.hoisted(() => ({
  clients: [] as Array<{ emit: (e: string, ...a: unknown[]) => void; subscribeCalls: number; disconnected: boolean }>,
  failSubscribe: false,
  failQuit: false,
  incr: vi.fn<(key: string) => Promise<number>>(),
  publish: vi.fn<(channel: string, message: string) => Promise<number>>(),
}))

vi.mock('ioredis', () => {
  class FakeRedis {
    subscribeCalls = 0
    disconnected = false
    private handlers = new Map<string, Array<(...a: unknown[]) => void>>()
    constructor() { hub.clients.push(this) }
    on(event: string, fn: (...a: unknown[]) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn])
      return this
    }
    emit(event: string, ...args: unknown[]): void { for (const fn of this.handlers.get(event) ?? []) fn(...args) }
    subscribe(): Promise<number> {
      this.subscribeCalls++
      return hub.failSubscribe ? Promise.reject(new Error('redis unreachable')) : Promise.resolve(1)
    }
    quit(): Promise<string> { return hub.failQuit ? Promise.reject(new Error('quit failed')) : Promise.resolve('OK') }
    disconnect(): void { this.disconnected = true }
  }
  return { Redis: FakeRedis }
})
vi.mock('../bullmq.js', () => ({ getSharedRedis: () => ({ incr: hub.incr, publish: hub.publish }) }))
vi.mock('@opengraphity/events', () => ({ getRedisConnection: () => ({ host: 'fake-redis', port: 6379 }) }))
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { ...log, child: () => log } }))

type Bus = typeof import('../metamodelBus.js')
type Inv = typeof import('../schemaInvalidator.js')
type Metrics = typeof import('../../middleware/metrics.js')
let bus: Bus
let inv: Inv
let metrics: Metrics

/** A fresh module graph: one "process" per test, with its own bus state. */
async function load(): Promise<void> {
  vi.resetModules()
  bus = await import('../metamodelBus.js')
  inv = await import('../schemaInvalidator.js')
  metrics = await import('../../middleware/metrics.js')
}

function counter(metric: { collect(): string }, label: string): number {
  const line = metric.collect().split('\n').find((l) => l.includes(label))
  return line ? Number(line.trim().split(/\s+/)[1]) : 0
}

const client = () => hub.clients.at(-1)!
const flush = () => new Promise<void>((r) => setImmediate(r))

beforeEach(async () => {
  vi.clearAllMocks()
  hub.clients.length = 0
  hub.failSubscribe = false
  hub.failQuit = false
  await load()
})
afterEach(async () => {
  await bus.stopMetamodelBus()
  vi.useRealTimers()
})

describe('publishing', () => {
  it('a failing INCR/PUBLISH is logged and counted, never thrown at the caller', async () => {
    hub.incr.mockRejectedValue(new Error('READONLY'))
    const before = counter(metrics.metamodelPublishedTotal, 'result="error"')
    expect(() => bus.publishMetamodelChange('t1')).not.toThrow()
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', channel: bus.METAMODEL_CHANNEL }),
      expect.stringContaining('pubblicazione fallita'),
    ))
    expect(counter(metrics.metamodelPublishedTotal, 'result="error"')).toBe(before + 1)
  })
})

describe('starting and the connection lifecycle', () => {
  it('starting twice opens one subscriber connection', async () => {
    bus.startMetamodelBus()
    bus.startMetamodelBus()
    expect(hub.clients).toHaveLength(1)
  })

  it('a connection error is logged and the bus keeps running', async () => {
    bus.startMetamodelBus()
    client().emit('error', new Error('ECONNRESET'))
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ channel: bus.METAMODEL_CHANNEL }), expect.stringContaining('errore della connessione'))
    expect(bus.metamodelBusStatus().running).toBe(true)
  })

  it('while reconnecting the process declares itself NOT subscribed', async () => {
    bus.startMetamodelBus()
    await vi.waitFor(() => expect(bus.metamodelBusStatus().subscribed).toBe(true))
    client().emit('reconnecting')
    expect(bus.metamodelBusStatus().subscribed).toBe(false)
    expect(log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('riconnessione'))
  })
})

describe('receiving', () => {
  it('a message on another channel clears nothing', async () => {
    bus.startMetamodelBus()
    const seen: string[] = []
    inv.registerMetamodelCacheClearer('spy', (t) => seen.push(t))
    client().emit('message', 'some.other.channel', JSON.stringify({ tenantId: 't1', version: 1, origin: 'elsewhere' }))
    expect(seen).toEqual([])
  })

  it.each(['42', 'null', '"text"'])('a JSON value that is not an object (%s) is malformed, and clears nothing', async (raw) => {
    bus.startMetamodelBus()
    const seen: string[] = []
    inv.registerMetamodelCacheClearer('spy', (t) => seen.push(t))
    const before = counter(metrics.metamodelReceivedTotal, 'result="malformed"')
    client().emit('message', bus.METAMODEL_CHANNEL, raw)
    expect(seen).toEqual([])
    expect(counter(metrics.metamodelReceivedTotal, 'result="malformed"')).toBe(before + 1)
  })

  it('a cache that fails to clear on a received message is counted by its name', async () => {
    bus.startMetamodelBus()
    inv.registerMetamodelCacheClearer('broken-cache', () => { throw new Error('boom') })
    const before = counter(metrics.metamodelCacheClearFailuresTotal, 'cache="broken-cache"')
    client().emit('message', bus.METAMODEL_CHANNEL, JSON.stringify({ tenantId: 't1', version: 1, origin: 'elsewhere' }))
    expect(counter(metrics.metamodelCacheClearFailuresTotal, 'cache="broken-cache"')).toBe(before + 1)
  })
})

describe('retries', () => {
  it('only one retry is pending at a time, however many attempts fail', async () => {
    vi.useFakeTimers()
    hub.failSubscribe = true
    bus.startMetamodelBus()
    await vi.advanceTimersByTimeAsync(0)
    // A reconnection fails too while the first retry is still pending.
    client().emit('ready')
    await vi.advanceTimersByTimeAsync(0)
    expect(client().subscribeCalls).toBe(2)

    hub.failSubscribe = false
    await vi.advanceTimersByTimeAsync(bus.RESUBSCRIBE_DELAY_MS + 1)
    // One timer fired, not two.
    expect(client().subscribeCalls).toBe(3)
    expect(bus.metamodelBusStatus().subscribed).toBe(true)
  })

  it('a reconnection that subscribes first cancels the pending retry', async () => {
    vi.useFakeTimers()
    hub.failSubscribe = true
    bus.startMetamodelBus()
    await vi.advanceTimersByTimeAsync(0)
    hub.failSubscribe = false
    client().emit('ready')
    await vi.advanceTimersByTimeAsync(0)
    expect(bus.metamodelBusStatus().subscribed).toBe(true)
    const calls = client().subscribeCalls
    await vi.advanceTimersByTimeAsync(bus.RESUBSCRIBE_DELAY_MS * 2)
    expect(client().subscribeCalls).toBe(calls)
  })

  it('shutdown cancels a pending retry: a stopped process does not resubscribe', async () => {
    vi.useFakeTimers()
    hub.failSubscribe = true
    bus.startMetamodelBus()
    await vi.advanceTimersByTimeAsync(0)
    await bus.stopMetamodelBus()
    hub.failSubscribe = false
    await vi.advanceTimersByTimeAsync(bus.RESUBSCRIBE_DELAY_MS * 2)
    expect(client().subscribeCalls).toBe(1)
    expect(bus.metamodelBusStatus()).toMatchObject({ running: false, subscribed: false })
  })

  it('a late "ready" from a stopped connection does nothing', async () => {
    bus.startMetamodelBus()
    await vi.waitFor(() => expect(bus.metamodelBusStatus().subscribed).toBe(true))
    const old = client()
    await bus.stopMetamodelBus()
    const calls = old.subscribeCalls
    old.emit('ready')
    await flush()
    expect(old.subscribeCalls).toBe(calls)
    expect(bus.metamodelBusStatus().subscribed).toBe(false)
  })
})

describe('shutdown', () => {
  it('stopping a bus that never started is harmless', async () => {
    await expect(bus.stopMetamodelBus()).resolves.toBeUndefined()
    expect(inv.hasMetamodelPublisher()).toBe(false)
  })

  it('a failing QUIT is logged and the connection is force-disconnected', async () => {
    bus.startMetamodelBus()
    hub.failQuit = true
    await bus.stopMetamodelBus()
    expect(client().disconnected).toBe(true)
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining('chiusura'))
  })
})
