/**
 * Eventi di dominio persi → metrica (revisione 2 · D2.2).
 *
 * `packages/events` promette dal D-33 un gancio `onEventFailed` «così che
 * l'API possa esporlo come `events_failed_total{queue,type}`» — e nessuno lo
 * collegava: un `ci.health_changed` che esauriva i 4 tentativi del consumer
 * dei servizi (Redis o Neo4j in affanno) spariva con una riga `console.error`
 * e basta. Da chiamare una volta per processo che avvia consumer di dominio
 * (index.ts e, con il profilo `events`, worker.ts).
 */
import { onEventFailed } from '@opengraphity/events'
import { eventsFailedTotal } from '../middleware/metrics.js'

/** Registra il listener; restituisce la funzione per toglierlo (test, spegnimento). */
export function wireDomainEventFailureMetric(): () => void {
  return onEventFailed((info) => {
    eventsFailedTotal.inc({ queue: info.queue, type: info.eventType })
  })
}
