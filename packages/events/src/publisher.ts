import { Queue } from 'bullmq'
import type { DomainEvent } from '@opengraphity/types'
import { registerQueue } from './connection.js'
import { getRedisConnection } from './redis.js'

/**
 * One queue per consumer — fan-out by publishing to all.
 * `service-impact-consumer`: apps/api consumers/serviceImpactConsumer.ts
 * (Servizi monitorati: `ci.health_changed` → valutazione delle mappe).
 */
export const CONSUMER_QUEUES = ['notification-service', 'sla-engine', 'escalation-consumer', 'service-impact-consumer', 'automation-consumer'] as const

const JOB_OPTIONS = {
  attempts:         4,   // 1 initial + 3 retries (5s / 30s / 5min via backoffStrategy)
  backoff:          { type: 'custom' },
  removeOnComplete: true,
  removeOnFail:     100,
} as const

let _queues: Queue[] | null = null

function getQueues(): Queue[] {
  if (_queues) return _queues
  const conn = getRedisConnection()
  const queues = CONSUMER_QUEUES.map(name => new Queue(name, { connection: conn }))
  _queues = queues
  for (const q of queues) {
    // After closeConnection() a later publish must open fresh queues, not
    // reuse closed ones.
    registerQueue(q, () => { if (_queues === queues) _queues = null })
  }
  return queues
}

/**
 * Pubblica l'evento su tutte le code dei consumatori.
 *
 * Il fan-out NON è atomico: se una `add` fallisce, le altre sono già
 * accodate, e chi ritenta ripubblica l'evento (revisione totale · E-7). Il
 * `jobId` è l'id dell'evento: BullMQ rifiuta un secondo job con lo stesso id
 * sulla stessa coda, quindi la ripubblicazione dello STESSO evento completa
 * le code mancanti senza duplicare quelle già servite. Perché funzioni l'id
 * dell'evento deve essere deterministico per il fatto che descrive: dove il
 * chiamante ne genera uno nuovo a ogni tentativo la protezione non c'è, e i
 * consumatori vedono due eventi (vedi `packages/sla/src/scheduler.ts`).
 */
export async function publish<T>(event: DomainEvent<T>): Promise<void> {
  const queues = getQueues()
  await Promise.all(
    queues.map(q => q.add(event.type, event, { ...JOB_OPTIONS, jobId: event.id }))
  )
  console.log(`[publisher] Published: ${event.type} (id: ${event.id})`)
}
