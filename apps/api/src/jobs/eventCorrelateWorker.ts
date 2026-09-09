/**
 * BullMQ worker della coda "events-correlate" (Event Management, ondata 3).
 *
 *  - `correlate`          — job ritardato accodato dalla pipeline quando la
 *                           policy ha `open_delay_seconds > 0`: alla scadenza
 *                           ricarica l'evento e, se è ancora firing, riparte dal
 *                           raggruppamento (services/eventCorrelation.ts, mode
 *                           `resume`); se nel frattempo è risolto → `none`.
 *                           Job id deterministico per (tenant, evento, scadenza).
 *  - `reevaluate-windows` — job ripetuto ogni 5 minuti: rivaluta gli eventi
 *                           soppressi la cui finestra di change risulta chiusa
 *                           (copre le change che non passano dalle mutation).
 */
import type { Worker, Job } from 'bullmq'
import { logger } from '../lib/logger.js'
import { createWorker, getQueue } from '../lib/bullmq.js'
import { reevaluateClosedWindows, runEventPipeline } from '../services/eventCorrelation.js'

const log = logger.child({ module: 'event-correlate' })

export const EVENT_CORRELATE_QUEUE = 'events-correlate'
export const REEVALUATE_WINDOWS_JOB = 'reevaluate-windows'
export const REEVALUATE_WINDOWS_EVERY_MS = 5 * 60 * 1000

export interface CorrelateJobData {
  tenantId: string
  eventId:  string
  /** ISO: scadenza del ritardo. */
  dueAt:    string
}

export function correlationJobId(tenantId: string, eventId: string, dueAt: string): string {
  const ms = Date.parse(dueAt)
  if (Number.isNaN(ms)) throw new Error(`correlationJobId: dueAt is not an ISO date: ${dueAt}`)
  return `corr-${tenantId}-${eventId}-${ms}`
}

async function processJob(job: Job<CorrelateJobData | Record<string, never>>): Promise<void> {
  switch (job.name) {
    case 'correlate': {
      const { tenantId, eventId, dueAt } = job.data as CorrelateJobData
      const result = await runEventPipeline({ tenantId, eventId, mode: 'resume' })
      log.info({ tenantId, eventId, dueAt, outcome: result.outcome }, 'Delayed correlation evaluated')
      return
    }
    case REEVALUATE_WINDOWS_JOB: {
      const r = await reevaluateClosedWindows()
      if (r.evaluated > 0) log.info(r, 'Suppressed events re-evaluated (periodic)')
      return
    }
    default:
      throw new Error(`[events-correlate] unknown job "${job.name}"`)
  }
}

/**
 * Accoda la valutazione ritardata. Awaited dal chiamante: una coda non
 * disponibile deve far fallire l'ingest (che ritenta), non lasciare l'evento
 * `delayed` per sempre.
 */
export async function enqueueCorrelation(tenantId: string, eventId: string, dueAt: string): Promise<void> {
  const delay = Math.max(Date.parse(dueAt) - Date.now(), 0)
  await getQueue<CorrelateJobData>(EVENT_CORRELATE_QUEUE).add('correlate', { tenantId, eventId, dueAt }, {
    jobId: correlationJobId(tenantId, eventId, dueAt),
    delay,
    attempts: 3,
    backoff:  { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 3600, count: 10_000 },
    removeOnFail:     { age: 7 * 24 * 3600 },
  })
  log.info({ tenantId, eventId, dueAt, delayMs: delay }, 'Delayed correlation enqueued')
}

export async function startEventCorrelateWorker(): Promise<Worker<CorrelateJobData | Record<string, never>>> {
  const queue = getQueue<CorrelateJobData | Record<string, never>>(EVENT_CORRELATE_QUEUE)
  // Repeat job: BullMQ deduplica per (name, repeat) — riavviare l'API non ne crea un secondo.
  await queue.add(REEVALUATE_WINDOWS_JOB, {}, {
    repeat: { every: REEVALUATE_WINDOWS_EVERY_MS },
    jobId: REEVALUATE_WINDOWS_JOB,
    removeOnComplete: { count: 20 },
    removeOnFail:     { age: 7 * 24 * 3600 },
  })
  return createWorker<CorrelateJobData | Record<string, never>>(EVENT_CORRELATE_QUEUE, processJob, {
    concurrency: 2,
    onFailed: (job, err) => {
      const d = job?.data as Partial<CorrelateJobData> | undefined
      log.error({ jobId: job?.id, jobName: job?.name, tenantId: d?.tenantId, eventId: d?.eventId, attemptsMade: job?.attemptsMade, err: err.message }, 'Event correlate job failed')
    },
  })
}
