/**
 * Deduplica della consegna PER CANALE (revisione totale · E-3).
 *
 * BullMQ è at-least-once e il job delle notifiche viene ritentato 4 volte. Il
 * dispatcher consegnava in-app, poi Slack, poi e-mail: se un canale a valle
 * lanciava (Resend giù, un canale non instradabile scritto via API), il job
 * fallliva e ogni tentativo RIFACEVA le consegne già andate a buon fine —
 * quattro notifiche in-app identiche nel pannello, quattro e-mail uguali a
 * tutti gli operatori, per ogni evento.
 *
 * La deduplica dell'evento (`BaseConsumer`) non basta: marca l'evento solo
 * DOPO il successo di TUTTI i canali. Qui si marca canale per canale, subito
 * dopo la sua consegna: il ritentativo riprende dal canale che ha fallito.
 *
 * Senza Redis (test, sviluppo senza coda) la deduplica è in memoria del
 * processo: non protegge fra repliche, ma non finge nemmeno di farlo.
 */
import { Redis } from 'ioredis'
import { getRedisConnection } from '@opengraphity/events'

/** Quanto resta il marcatore: più della finestra dei 4 tentativi con backoff. */
const TTL_SECONDS = 24 * 3600

let redis: Redis | null = null
let redisUnavailable = false
const memory = new Map<string, number>()

function client(): Redis | null {
  if (redis || redisUnavailable) return redis
  try {
    redis = new Redis({ ...getRedisConnection(), lazyConnect: false, maxRetriesPerRequest: 2 })
    redis.on('error', () => { /* il chiamante degrada sulla memoria, senza rumore per ogni ping */ })
  } catch {
    redisUnavailable = true
  }
  return redis
}

function key(eventId: string, channel: string): string {
  return `notif:delivered:${eventId}:${channel}`
}

/** Solo per i test: dimentica lo stato in memoria e il client. */
export function resetDeliveryDedup(): void {
  memory.clear()
  redis = null
  redisUnavailable = false
}

/** Vero se quel canale di quell'evento è già stato consegnato. */
export async function alreadyDelivered(eventId: string | undefined, channel: string): Promise<boolean> {
  if (!eventId) return false
  const k = key(eventId, channel)
  const expires = memory.get(k)
  if (expires !== undefined && expires > Date.now()) return true
  const c = client()
  if (!c) return false
  try {
    return (await c.exists(k)) === 1
  } catch {
    return false
  }
}

/** Marca quel canale come consegnato. */
export async function markDelivered(eventId: string | undefined, channel: string): Promise<void> {
  if (!eventId) return
  const k = key(eventId, channel)
  memory.set(k, Date.now() + TTL_SECONDS * 1000)
  const c = client()
  if (!c) return
  try {
    await c.set(k, '1', 'EX', TTL_SECONDS)
  } catch {
    // La memoria del processo ha già il marcatore: il ritentativo dello stesso
    // worker non duplica. Non si finge una garanzia fra repliche.
  }
}

/**
 * Esegue la consegna di un canale una volta sola per evento. Restituisce true
 * se la consegna è stata eseguita adesso, false se era già stata fatta.
 */
export async function deliverOnce(
  eventId: string | undefined, channel: string, deliver: () => Promise<void> | void,
): Promise<boolean> {
  if (await alreadyDelivered(eventId, channel)) return false
  await deliver()
  await markDelivered(eventId, channel)
  return true
}
