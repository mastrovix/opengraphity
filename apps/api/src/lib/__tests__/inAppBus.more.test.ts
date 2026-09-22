/**
 * In-app notification bus: the failure paths and the lifecycle.
 *
 * Why these behaviours matter:
 *  - A Redis outage must be logged ONCE (not once per retry: that flood is what
 *    opened PRB00000002), and the recovery must re-subscribe, otherwise the
 *    other replicas' notifications stop reaching this process's clients.
 *  - Messages on other channels, non-JSON, or deliveries without a tenant must
 *    be dropped: writing a delivery with no tenant to local clients would risk
 *    showing a notification to the wrong people.
 *  - A failed subscription must be said loudly, and stopping the bus must
 *    detach the transport and close the subscriber even when QUIT fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hub = vi.hoisted(() => ({
  handlers: new Map<string, (...a: unknown[]) => void>(),
  subscribeFails: false,
  quitFails: false,
  instances: 0,
  disconnects: 0,
  quits: 0,
}))
vi.mock('ioredis', () => ({
  Redis: class {
    constructor() { hub.instances += 1 }
    on(event: string, fn: (...a: unknown[]) => void) { hub.handlers.set(event, fn); return this }
    async subscribe() { if (hub.subscribeFails) throw new Error('NOAUTH') }
    disconnect() { hub.disconnects += 1 }
    async quit() { hub.quits += 1; if (hub.quitFails) throw new Error('closed'); return 'OK' }
  },
}))
vi.mock('@opengraphity/events', () => ({ getRedisConnection: vi.fn(() => ({ host: 'r' })) }))
vi.mock('../bullmq.js', () => ({ getSharedRedis: vi.fn(() => ({ publish: vi.fn() })) }))
const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../logger.js', () => ({ logger: { child: () => logger } }))
const useTransport = vi.fn()
const writeLocal = vi.fn()
vi.mock('@opengraphity/notifications', () => ({ sseManager: { useTransport, writeLocal }, persistInApp: vi.fn() }))

const { startInAppBus, stopInAppBus, INAPP_CHANNEL } = await import('../inAppBus.js')
const { scordaGliStati } = await import('../dipendenzaGiu.js')

const flush = () => new Promise((r) => setTimeout(r, 0))
const notification = { id: 'n-1', type: 'mention' }

beforeEach(async () => {
  await stopInAppBus()
  vi.clearAllMocks()
  scordaGliStati()
  hub.handlers.clear()
  hub.subscribeFails = false
  hub.quitFails = false
  hub.instances = 0
  hub.disconnects = 0
  hub.quits = 0
})

describe('lifecycle', () => {
  it('a second start re-registers the transport but does not open a second subscriber', () => {
    startInAppBus()
    startInAppBus()
    expect(useTransport).toHaveBeenCalledTimes(2)
    expect(hub.instances).toBe(1)
  })

  it('stop detaches the transport and quits the subscriber; a failing QUIT falls back to disconnect', async () => {
    startInAppBus()
    hub.quitFails = true
    await stopInAppBus()
    expect(useTransport).toHaveBeenLastCalledWith(null)
    expect(hub.quits).toBe(1)
    expect(hub.disconnects).toBe(1)
    // Stopping twice is harmless: there is no subscriber left to close.
    await stopInAppBus()
    expect(hub.quits).toBe(1)
  })

  it('a late "ready" after stop does not subscribe a closed connection', async () => {
    startInAppBus()
    await flush()
    const onReady = hub.handlers.get('ready')!
    await stopInAppBus()
    vi.clearAllMocks()
    onReady()
    await flush()
    // No "listening" line: the bus is stopped and must stay silent.
    expect(logger.info).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('a failed subscription is logged as an error (this process would miss remote deliveries)', async () => {
    hub.subscribeFails = true
    startInAppBus()
    await flush()
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ channel: INAPP_CHANNEL }), expect.stringContaining('subscription FAILED'))
    expect(logger.info).not.toHaveBeenCalled()
  })
})

describe('outage and recovery', () => {
  it('repeated errors are logged once; ready after the outage logs the recovery and subscribes again', async () => {
    startInAppBus()
    await flush()
    vi.clearAllMocks()
    const onError = hub.handlers.get('error')!
    onError(new Error('ECONNREFUSED'))
    onError(new Error('ECONNREFUSED'))
    onError(new Error('ECONNREFUSED'))
    expect(logger.error).toHaveBeenCalledTimes(1)

    hub.handlers.get('ready')!()
    await flush()
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ channel: INAPP_CHANNEL, taciute: 2 }), expect.stringContaining('back up'))
    // Re-subscribed: the "listening" line is written again.
    expect(logger.info).toHaveBeenCalledWith({ channel: INAPP_CHANNEL }, expect.stringContaining('listening'))
  })
})

describe('incoming messages', () => {
  it('ignores other channels, drops non-JSON and malformed deliveries, writes valid ones', () => {
    startInAppBus()
    const onMessage = hub.handlers.get('message')!
    onMessage('og:other', JSON.stringify({ tenantId: 't1', userId: 'u1', notification }))
    expect(writeLocal).not.toHaveBeenCalled()
    expect(logger.error).not.toHaveBeenCalled()

    onMessage(INAPP_CHANNEL, 'not json {')
    expect(logger.error).toHaveBeenLastCalledWith(expect.objectContaining({ channel: INAPP_CHANNEL }), expect.stringContaining('not JSON'))

    const malformed = [
      'null',
      '"text"',
      JSON.stringify({ tenantId: '', userId: 'u1', notification }),
      JSON.stringify({ tenantId: 't1', userId: 7, notification }),
      JSON.stringify({ tenantId: 't1', userId: 'u1', notification: null }),
      JSON.stringify({ tenantId: 't1', userId: 'u1', notification: { id: 'n-1' } }),
    ]
    for (const m of malformed) onMessage(INAPP_CHANNEL, m)
    expect(writeLocal).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledTimes(1 + malformed.length)

    // A broadcast (userId null) is a valid delivery.
    const broadcast = { tenantId: 't1', userId: null, notification }
    onMessage(INAPP_CHANNEL, JSON.stringify(broadcast))
    expect(writeLocal).toHaveBeenCalledWith(broadcast)
  })
})
