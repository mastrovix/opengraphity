/**
 * Revisione del 14 set 2026 · F10: una notifica consegnata da un processo
 * arriva ai client collegati a TUTTI i processi API, attraverso un canale Redis.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hub = vi.hoisted(() => ({ handlers: new Map<string, (...a: unknown[]) => void>(), subscribed: [] as string[], published: [] as [string, string][] }))
vi.mock('ioredis', () => ({
  Redis: class {
    on(event: string, fn: (...a: unknown[]) => void) { hub.handlers.set(event, fn); return this }
    async subscribe(ch: string) { hub.subscribed.push(ch) }
    disconnect() {}
    async quit() { return 'OK' }
  },
}))
vi.mock('@opengraphity/events', () => ({ getRedisConnection: vi.fn(() => ({ host: 'r' })) }))
vi.mock('../bullmq.js', () => ({ getSharedRedis: vi.fn(() => ({ publish: async (ch: string, msg: string) => { hub.published.push([ch, msg]); return 1 } })) }))
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
vi.mock('../logger.js', () => ({ logger: { child: () => logger } }))
const useTransport = vi.fn()
const writeLocal = vi.fn()
const persistInApp = vi.fn(async () => {})
vi.mock('@opengraphity/notifications', () => ({ sseManager: { useTransport, writeLocal }, persistInApp }))

const { startInAppBus, INAPP_CHANNEL } = await import('../inAppBus.js')

const delivery = { tenantId: 't1', userId: 'u1', notification: { id: 'n-1', type: 'mention', title: 't', message: 'm', timestamp: '2026-09-14T10:00:00.000Z', read: false } }

describe('canale delle notifiche in-app', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('registra il trasporto: salva con l\'archivio e pubblica sul canale', async () => {
    startInAppBus()
    expect(hub.subscribed).toContain(INAPP_CHANNEL)
    const transport = useTransport.mock.calls[0]![0] as { persist: (d: unknown) => Promise<void>; publish: (d: unknown) => Promise<void> }
    await transport.persist(delivery)
    expect(persistInApp).toHaveBeenCalledWith(delivery)
    await transport.publish(delivery)
    expect(hub.published).toContainEqual([INAPP_CHANNEL, JSON.stringify(delivery)])
  })

  it('un messaggio ricevuto si scrive ai client locali; uno malformato si scarta e si dice', () => {
    startInAppBus()
    const onMessage = hub.handlers.get('message')!
    onMessage(INAPP_CHANNEL, JSON.stringify(delivery))
    expect(writeLocal).toHaveBeenCalledWith(delivery)
    onMessage(INAPP_CHANNEL, '{"tenantId": 3}')
    expect(writeLocal).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalled()
  })
})
