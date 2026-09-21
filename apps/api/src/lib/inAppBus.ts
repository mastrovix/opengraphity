/**
 * IL CANALE DELLE NOTIFICHE IN-APP (revisione del 14 set 2026 · F10).
 *
 * `sseManager` teneva i client in RAM e il dispatcher consumava ogni evento su
 * una replica sola: con due o più API i client collegati alle altre non
 * ricevevano niente. Qui ogni processo registra il trasporto delle consegne —
 * salvare nell'archivio (`persistInApp`) e pubblicare su Redis — e ascolta il
 * canale, scrivendo ai propri client ciò che arriva, compreso ciò che ha
 * pubblicato lui (un percorso solo, niente doppioni).
 *
 * Se Redis non risponde, la notifica resta salvata: `sseManager` la scrive ai
 * client di questo processo e lo dice, gli altri la vedono alla prossima
 * apertura del pannello.
 */
import { Redis } from 'ioredis'
import { getRedisConnection } from '@opengraphity/events'
import { persistInApp, sseManager, type InAppDelivery } from '@opengraphity/notifications'
import { getSharedRedis } from './bullmq.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'inapp-bus' })

export const INAPP_CHANNEL = 'og:inapp.delivered'

let subscriber: Redis | null = null

function isDelivery(v: unknown): v is InAppDelivery {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  const n = o['notification'] as Record<string, unknown> | undefined
  return typeof o['tenantId'] === 'string' && o['tenantId'] !== ''
    && (o['userId'] === null || typeof o['userId'] === 'string')
    && typeof n === 'object' && n !== null && typeof n['id'] === 'string' && typeof n['type'] === 'string'
}

export function startInAppBus(): void {
  sseManager.useTransport({
    persist: (delivery) => persistInApp(delivery),
    publish: async (delivery) => { await getSharedRedis().publish(INAPP_CHANNEL, JSON.stringify(delivery)) },
  })
  if (subscriber) return
  subscriber = new Redis({ ...getRedisConnection(), maxRetriesPerRequest: null })
  subscriber.on('error', (err: Error) => {
    log.error({ err, channel: INAPP_CHANNEL }, '[inapp] listening connection error — ioredis reconnects; until then this process does not receive notifications delivered elsewhere')
  })
  subscriber.on('ready', () => { void subscribeNow() })
  subscriber.on('message', (channel: string, raw: string) => {
    if (channel !== INAPP_CHANNEL) return
    let parsed: unknown
    try { parsed = JSON.parse(raw) } catch (err) {
      log.error({ err, channel }, '[inapp] message is not JSON: dropped')
      return
    }
    if (!isDelivery(parsed)) {
      log.error({ channel }, '[inapp] malformed delivery (tenantId, userId, notification expected): dropped')
      return
    }
    sseManager.writeLocal(parsed)
  })
  void subscribeNow()
}

async function subscribeNow(): Promise<void> {
  if (!subscriber) return
  try {
    await subscriber.subscribe(INAPP_CHANNEL)
    log.info({ channel: INAPP_CHANNEL }, '[inapp] listening: in-app notifications delivered by any process reach the clients of this one')
  } catch (err) {
    log.error({ err, channel: INAPP_CHANNEL }, '[inapp] subscription FAILED: this process will not receive notifications delivered elsewhere')
  }
}

export async function stopInAppBus(): Promise<void> {
  sseManager.useTransport(null)
  const s = subscriber
  subscriber = null
  if (s) await s.quit().catch(() => { s.disconnect() })
}
