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
 *
 * ## PERCHÉ QUI NON SERVE IL RIMEDIO DI `metamodelBus.ts` (21 set 2026)
 * Il fascicolo di `PRB00000003` citava questo canale accanto a quello del
 * metamodello: stesse 27 occorrenze, stessi tre processi, stesso giorno. E lo
 * schema è identico — `on('ready')` che si ri-sottoscrive, e il pub/sub di
 * Redis che non ha arretrato, quindi i messaggi pubblicati mentre il
 * sottoscrittore è staccato sono persi per sempre.
 *
 * Ma la CONSEGUENZA è diversa, e cambia il rimedio. Là si perdeva l'unico
 * portatore dell'informazione «questa cache non vale più», e il processo
 * tornava a servire dati vecchi credendoli buoni: per quello alla ripresa
 * bisogna svuotare tutto. Qui ogni consegna passa da `persist` PRIMA di
 * essere pubblicata, quindi sta nell'archivio: quello che si perde è la
 * spinta in tempo reale ai client delle ALTRE repliche, non la notifica. Chi
 * sta guardando la pagina la vede al prossimo caricamento del pannello,
 * chiunque altro la trova dov'è sempre stata.
 *
 * Non c'è niente da svuotare, e inventarsi uno svuotamento qui vorrebbe dire
 * buttare via lo stato dei client per un guasto che non li ha sporcati.
 *
 * Quello che invece si applicava — ed è applicato — è l'altra metà di quel
 * rimedio: il log per TENTATIVO, che è il difetto per cui `PRB00000002` è
 * stato aperto. Vedi il gestore `error` qui sotto.
 */
import { Redis } from 'ioredis'
import { getRedisConnection } from '@opengraphity/events'
import { persistInApp, sseManager, type InAppDelivery } from '@opengraphity/notifications'
import { getSharedRedis } from './bullmq.js'
import { logger } from './logger.js'
import { guastoDi, ripresaDi } from './dipendenzaGiu.js'

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
  /*
   * UNA CADUTA, NON UN ERRORE PER TENTATIVO (21 set 2026).
   *
   * Era un `log.error` a ogni tentativo, e ioredis riprova senza sosta: lo
   * stesso difetto che ha fatto scrivere 952 righe a `bullmq.ts` in un giorno
   * e per cui l'Autoanalisi ha aperto `PRB00000002`. Corretto là e in
   * `metamodelBus.ts`, questo canale era rimasto indietro — proprio quello
   * che il fascicolo del Problem successivo citava accanto agli altri.
   */
  subscriber.on('error', (err: Error) => {
    guastoDi(log, `inapp:${INAPP_CHANNEL}`, err, { channel: INAPP_CHANNEL })
  })
  subscriber.on('ready', () => {
    ripresaDi(log, `inapp:${INAPP_CHANNEL}`, { channel: INAPP_CHANNEL })
    void subscribeNow()
  })
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
