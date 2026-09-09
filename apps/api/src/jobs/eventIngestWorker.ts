/**
 * BullMQ worker per l'ingest degli allarmi (coda "events-ingest").
 *
 * Il webhook in ingresso normalizza e accoda (risponde 202 subito); qui
 * `ingestEvent` fa MERGE per impronta, aggancia il CI e ricalcola lo stato.
 * Job id deterministico per (tenant, impronta, istante di ricezione): una
 * ri-consegna dello stesso batch non raddoppia il conteggio.
 *
 * Nota: con concurrency 4, un `firing` e un `resolved` della stessa impronta
 * arrivati nella stessa richiesta possono essere elaborati fuori ordine; il
 * caso è raro (Alertmanager manda stati coerenti per batch) ed è accettato
 * nell'ondata 1.
 */
import type { Worker, Job } from 'bullmq'
import { logger } from '../lib/logger.js'
import { createWorker, getQueue } from '../lib/bullmq.js'
import { fingerprintOf, ingestEvent, type NormalizedEvent } from '../services/eventService.js'

const log = logger.child({ module: 'event-ingest' })

export const EVENT_INGEST_QUEUE = 'events-ingest'

export interface EventIngestJobData {
  tenantId:   string
  sourceId:   string
  ev:         NormalizedEvent
  receivedAt: string
}

export function eventJobId(tenantId: string, fingerprint: string, receivedAt: string): string {
  const ms = Date.parse(receivedAt)
  if (Number.isNaN(ms)) throw new Error(`eventJobId: receivedAt is not an ISO date: ${receivedAt}`)
  return `ev-${tenantId}-${fingerprint}-${ms}`
}

async function processEvent(job: Job<EventIngestJobData>): Promise<void> {
  const { tenantId, sourceId, ev, receivedAt } = job.data
  await ingestEvent({ tenantId, sourceId, ev, receivedAt })
}

export function startEventIngestWorker(): Worker<EventIngestJobData> {
  getQueue<EventIngestJobData>(EVENT_INGEST_QUEUE)  // producer singleton (metriche)
  return createWorker<EventIngestJobData>(EVENT_INGEST_QUEUE, processEvent, {
    concurrency: 4,
    onFailed: (job, err) => {
      const d = job?.data as EventIngestJobData | undefined
      log.error({ jobId: job?.id, tenantId: d?.tenantId, sourceId: d?.sourceId, attemptsMade: job?.attemptsMade, err: err.message }, 'Event ingest job failed')
    },
  })
}

/**
 * Accoda gli eventi normalizzati di una richiesta. Un errore di coda (Redis
 * giù) propaga: il webhook risponde 500 e il mittente ritenta, invece di un
 * 202 che perde allarmi.
 */
export async function enqueueEvents(
  tenantId: string,
  sourceId: string,
  events: readonly NormalizedEvent[],
  receivedAt: string = new Date().toISOString(),
): Promise<number> {
  if (events.length === 0) return 0
  const queue = getQueue<EventIngestJobData>(EVENT_INGEST_QUEUE)
  await queue.addBulk(events.map((ev) => ({
    name: 'ingest',
    data: { tenantId, sourceId, ev, receivedAt } satisfies EventIngestJobData,
    opts: {
      jobId: eventJobId(tenantId, fingerprintOf(sourceId, ev), receivedAt),
      attempts: 3,
      backoff:  { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 3600, count: 10_000 },
      removeOnFail:     { age: 7 * 24 * 3600 },
    },
  })))
  log.info({ tenantId, sourceId, count: events.length }, 'Event ingest jobs enqueued')
  return events.length
}
