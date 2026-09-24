import type { DomainEvent } from '@opengraphity/types'
import { tenantQueue } from './tenantQueues.js'
import { currentEventOutbox, type PublishOptions } from './outbox.js'

/** What `publish` did: through the outbox, the process's extras (the webhooks) were part of the send. */
export interface PublishResult {
  throughOutbox: boolean
}

/**
 * One queue per consumer — fan-out by publishing to all. Each consumer's
 * queue is the tenant's own (`<consumer>@<tenant>`, 23 Sep 2026).
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

/**
 * Pubblica l'evento su tutte le code dei consumatori del suo tenant.
 *
 * Un evento senza tenant non si pubblica: la coda di un consumatore è quella
 * di un tenant, e `tenantQueue` lo rifiuta ad alta voce invece di metterlo in
 * una coda che nessun worker legge.
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
export async function sendToConsumers<T>(event: DomainEvent<T>): Promise<void> {
  const queues = CONSUMER_QUEUES.map((name) => tenantQueue(name, event.tenant_id))
  await Promise.all(
    queues.map(q => q.add(event.type, event, { ...JOB_OPTIONS, jobId: event.id }))
  )
  console.log(`[publisher] Published: ${event.type} (id: ${event.id}, tenant: ${event.tenant_id})`)
}

/**
 * Publishes a domain event (wave 7 · B2: through the outbox, outbox.ts).
 *
 * With an outbox the event is written down first, then sent to the
 * consumers' queues and to what the process adds (the webhooks), then marked
 * sent. Once it is written, a failed send is not the caller's failure — the
 * change it describes is committed, and the repeater sends the event — so it
 * is logged, not thrown. An event that could not even be written is sent all
 * the same, and if that fails too the error is thrown: it is lost, loudly.
 *
 * Without an outbox (a script, a test) it is sent straight away, and a
 * failure is thrown, as before.
 */
export async function publish<T>(event: DomainEvent<T>, options: PublishOptions = {}): Promise<PublishResult> {
  const outbox = currentEventOutbox()
  if (!outbox) {
    await sendToConsumers(event)
    return { throughOutbox: false }
  }
  const recorded = await outbox.record(event, options).then(() => true, (err: unknown) => {
    console.error(`[publisher] ${event.type} (id: ${event.id}, tenant: ${event.tenant_id}) was NOT written to the outbox: it is sent without its safety net`, err)
    return false
  })
  try {
    await sendToConsumers(event)
    await outbox.deliverExtras(event, options)
  } catch (err) {
    if (!recorded) throw err
    console.warn(`[publisher] ${event.type} (id: ${event.id}, tenant: ${event.tenant_id}) could not be sent now: the outbox repeater sends it`, err)
    return { throughOutbox: true }
  }
  // Sent but not marked: the repeater sends it again, and the consumers skip it (consumer.ts).
  await outbox.markSent(event).catch((err: unknown) => {
    console.warn(`[publisher] ${event.type} (id: ${event.id}) was sent but not marked: the repeater will send it again, the consumers skip it`, err)
  })
  return { throughOutbox: true }
}
