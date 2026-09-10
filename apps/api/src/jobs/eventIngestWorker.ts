/**
 * BullMQ worker per l'ingest degli allarmi (coda "events-ingest").
 *
 * Il webhook in ingresso normalizza e accoda (risponde 202 subito); qui
 * `ingestEvent` scrive l'Event con un solo MERGE (transizione di stato in
 * Cypher), aggancia il CI ed esegue la pipeline di correlazione.
 *
 * Idempotenza dei retry. Il job id è `ev-<tenant>-<impronta>-<receivedAtMs>`:
 * `receivedAt` è l'istante di ricezione della richiesta, uguale per tutti i
 * job della stessa chiamata e per ogni tentativo dello stesso job. L'Event
 * porta `last_received_at` = receivedAt dell'ultimo payload applicato:
 * - retry dello stesso job (stessa receivedAt) → `duplicate`: il nodo non
 *   viene toccato (count, transitions, severità invariati) e la pipeline
 *   viene rieseguita — è il motivo del retry;
 * - job più vecchio dell'ultimo applicato (un `firing` ritentato dopo che il
 *   `resolved` successivo è già passato) → `stale`: scartato, così un retry
 *   tardivo non può riaprire un ciclo;
 * - concorrenza (concurrency 4, stessa impronta in due job) → il MERGE
 *   serializza sul nodo e ogni job applica la propria transizione sullo stato
 *   già scritto dall'altro: nessun incremento perso.
 * Una ri-consegna del mittente (nuova richiesta) ha una receivedAt nuova e
 * conta come una ripetizione legittima dell'allarme.
 *
 * Errori visibili (A4): all'ultimo tentativo fallito il worker scrive
 * `last_error`/`last_error_at`/`error_count` sulla sorgente (InboundWebhook)
 * con il messaggio e l'impronta (prefisso `ingest:`), così la pagina Sorgenti
 * lo mostra; il primo job riuscito dopo un errore azzera SOLO quel tipo di
 * errore. Gli scarti del webhook (payload rifiutato, batch parziale: A1) non
 * hanno il prefisso e restano finché un nuovo payload non li sostituisce: un
 * job riuscito non dice nulla sulla validità dei payload successivi. Il
 * webhook NON azzera più `last_error` al 202.
 */
export const INGEST_ERROR_PREFIX = 'ingest: '
import type { Worker, Job } from 'bullmq'
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { logger } from '../lib/logger.js'
import { createWorker, getQueue } from '../lib/bullmq.js'
import { eventsIngestFailedTotal } from '../middleware/metrics.js'
import { fingerprintOf, ingestEvent, type NormalizedEvent } from '../services/eventService.js'
import { invalidateSourceCache } from '../services/events/sourceCache.js'

const log = logger.child({ module: 'event-ingest' })

export const EVENT_INGEST_QUEUE = 'events-ingest'

/** Tentativi per job e ritardo base del backoff esponenziale: 10 s → 20 → 40 → 80 (≈ 2,5 minuti in tutto). */
export const EVENT_INGEST_ATTEMPTS = 5
export const EVENT_INGEST_BACKOFF_MS = 10_000

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
  const result = await ingestEvent({ tenantId, sourceId, ev, receivedAt, jobId: String(job.id) })
  if (result.sourceHasError) await clearSourceError(tenantId, sourceId)
}

/** Un job riuscito azzera `last_error` della sorgente solo se lo aveva scritto il worker (prefisso `ingest:`); gli scarti del webhook restano. */
async function clearSourceError(tenantId: string, sourceId: string): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    await runQueryOne(session, `
      MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})
      WHERE w.last_error STARTS WITH $prefix
      SET w.last_error = null
      RETURN w.id AS id
    `, { tenantId, sourceId, prefix: INGEST_ERROR_PREFIX })
  } finally {
    await session.close()
    invalidateSourceCache(tenantId, sourceId)
  }
}

/**
 * Ultimo tentativo fallito: il motivo va sulla sorgente, con l'impronta
 * dell'allarme perso. Un errore in questa scrittura si logga e basta (il job
 * è già fallito; la riga di log del worker resta la fonte primaria).
 */
export async function recordIngestFailure(data: EventIngestJobData, err: Error): Promise<void> {
  const fingerprint = fingerprintOf(data.sourceId, data.ev)
  const message = `${INGEST_ERROR_PREFIX}${err.message} (impronta ${fingerprint}, ${data.ev.status} ${data.ev.title} su ${data.ev.resource})`.slice(0, 2000)
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ connectorKind: string | null }>(session, `
      MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})
      SET w.last_error = $message,
          w.last_error_at = $now,
          w.error_count = coalesce(w.error_count, 0) + 1
      RETURN w.connector_kind AS connectorKind
    `, { sourceId: data.sourceId, tenantId: data.tenantId, message, now: new Date().toISOString() })
    eventsIngestFailedTotal.inc({ connector: row?.connectorKind ?? 'generic' })
  } catch (e) {
    log.error({ tenantId: data.tenantId, sourceId: data.sourceId, fingerprint, err: e }, 'Could not record event ingest failure on the source')
  } finally {
    await session.close()
    invalidateSourceCache(data.tenantId, data.sourceId)
  }
}

export function startEventIngestWorker(): Worker<EventIngestJobData> {
  getQueue<EventIngestJobData>(EVENT_INGEST_QUEUE)  // producer singleton (metriche)
  return createWorker<EventIngestJobData>(EVENT_INGEST_QUEUE, processEvent, {
    concurrency: 4,
    onFailed: (job, err) => {
      const d = job?.data as EventIngestJobData | undefined
      const attempts = job?.opts?.attempts ?? 1
      const exhausted = (job?.attemptsMade ?? 0) >= attempts
      log.error({ jobId: job?.id, tenantId: d?.tenantId, sourceId: d?.sourceId, attemptsMade: job?.attemptsMade, attempts, exhausted, err: err.message }, 'Event ingest job failed')
      if (exhausted && d) void recordIngestFailure(d, err)
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
      attempts: EVENT_INGEST_ATTEMPTS,
      backoff:  { type: 'exponential', delay: EVENT_INGEST_BACKOFF_MS },
      removeOnComplete: { age: 3600, count: 10_000 },
      removeOnFail:     { age: 7 * 24 * 3600 },
    },
  })))
  log.info({ tenantId, sourceId, count: events.length }, 'Event ingest jobs enqueued')
  return events.length
}
