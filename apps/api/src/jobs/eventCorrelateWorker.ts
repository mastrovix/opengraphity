/**
 * BullMQ worker delle code dell'Event Management (ondata 3 + 4, revisione).
 *
 * Coda `events-correlate` (concurrency 2) — lavoro puntuale per evento/change:
 *  - `correlate`                — job ritardato accodato dalla pipeline quando
 *                                 la policy ha `open_delay_seconds > 0`: alla
 *                                 scadenza ricarica l'evento e, se è ancora
 *                                 firing, riparte dal raggruppamento (mode
 *                                 `resume`); se nel frattempo è risolto → `none`.
 *                                 Job id deterministico per (tenant, evento, scadenza).
 *  - `reevaluate-change-window` — fine finestra di una change: accodato dalle
 *                                 mutation della change (autoTransitions.ts)
 *                                 quando la change esce dai passi di finestra
 *                                 con allarmi ancora silenziati; rivaluta quegli
 *                                 eventi fuori dalla mutation (che non aspetta
 *                                 né fallisce per la correlazione). Job id
 *                                 deterministico per (tenant, change, epoca del passo).
 *
 * Coda `events-maintenance` (concurrency 1, separata così le passate lunghe
 * non rubano gli slot ai job ritardati; `lockDuration` di 10 minuti) — job
 * `events-maintenance` ripetuto ogni 5 minuti, quattro passate paginate e
 * indipendenti: eventi soppressi con finestra chiusa (copre le change che non
 * passano dalle mutation); eventi `pending` (fine soppressione /
 * stabilizzazione la cui correlazione era fallita); stabilizzazione degli
 * eventi `flapping`; chiusura delle tempeste raffreddate. Ogni passata gira
 * anche se la precedente fallisce; alla fine il job fallisce se una è fallita.
 *
 * Gli id dei job non contengono ':' (BullMQ li rifiuta, vedi f36083a).
 */
import type { Worker, Job } from 'bullmq'
import { logger } from '../lib/logger.js'
import { createWorker, getQueue } from '../lib/bullmq.js'
import { reevaluateClosedWindows, reevaluateFlappingEvents, reevaluatePendingEvents, reevaluateSuppressedEvents, runEventPipeline } from '../services/eventCorrelation.js'
import { endCooledStorms } from '../services/eventStorm.js'

const log = logger.child({ module: 'event-correlate' })

export const EVENT_CORRELATE_QUEUE = 'events-correlate'
export const EVENT_MAINTENANCE_QUEUE = 'events-maintenance'
export const CHANGE_WINDOW_JOB = 'reevaluate-change-window'
export const EVENT_MAINTENANCE_JOB = 'events-maintenance'
export const EVENT_MAINTENANCE_EVERY_MS = 5 * 60 * 1000
/** Una passata può superare i 30 s predefiniti di BullMQ (fino a 20 pagine × 200 eventi × 4 passate): oltre il lock il job sarebbe considerato bloccato e rieseguito. */
export const EVENT_MAINTENANCE_LOCK_MS = 10 * 60 * 1000
/** Nome del job ripetuto che viveva sulla coda events-correlate prima della revisione: rimosso all'avvio. */
export const LEGACY_REEVALUATE_WINDOWS_JOB = 'reevaluate-windows'
const LEGACY_REEVALUATE_WINDOWS_EVERY_MS = EVENT_MAINTENANCE_EVERY_MS

export interface CorrelateJobData {
  tenantId: string
  eventId:  string
  /** ISO: scadenza del ritardo. */
  dueAt:    string
}

export interface ChangeWindowJobData {
  tenantId: string
  changeId: string
  /** Epoca (ms) dell'ingresso nel passo corrente della change: distingue una fine finestra dalla successiva. */
  stepEpoch: number
}

type CorrelateQueueData = CorrelateJobData | ChangeWindowJobData

export function correlationJobId(tenantId: string, eventId: string, dueAt: string): string {
  const ms = Date.parse(dueAt)
  if (Number.isNaN(ms)) throw new Error(`correlationJobId: dueAt is not an ISO date: ${dueAt}`)
  return `corr-${tenantId}-${eventId}-${ms}`
}

export function changeWindowJobId(tenantId: string, changeId: string, stepEpoch: number): string {
  if (!Number.isInteger(stepEpoch) || stepEpoch < 0) throw new Error(`changeWindowJobId: stepEpoch must be a non-negative integer, got ${JSON.stringify(stepEpoch)}`)
  return `win-${tenantId}-${changeId}-${stepEpoch}`
}

async function processCorrelateJob(job: Job<CorrelateQueueData>): Promise<void> {
  switch (job.name) {
    case 'correlate': {
      const { tenantId, eventId, dueAt } = job.data as CorrelateJobData
      const result = await runEventPipeline({ tenantId, eventId, mode: 'resume' })
      log.info({ jobId: job.id, tenantId, eventId, dueAt, outcome: result.outcome }, 'Delayed correlation evaluated')
      return
    }
    case CHANGE_WINDOW_JOB: {
      const { tenantId, changeId } = job.data as ChangeWindowJobData
      const n = await reevaluateSuppressedEvents(tenantId, changeId)
      log.info({ jobId: job.id, tenantId, changeId, reevaluated: n }, 'Change window closed: suppressed events re-evaluated')
      return
    }
    default:
      throw new Error(`[${EVENT_CORRELATE_QUEUE}] unknown job "${job.name}"`)
  }
}

async function processMaintenanceJob(job: Job<Record<string, never>>): Promise<void> {
  if (job.name !== EVENT_MAINTENANCE_JOB) throw new Error(`[${EVENT_MAINTENANCE_QUEUE}] unknown job "${job.name}"`)
  await runPeriodicPasses()
}

/** Le quattro passate del job periodico, ciascuna eseguita anche se le altre falliscono. */
export async function runPeriodicPasses(now: string = new Date().toISOString()): Promise<void> {
  const failures: string[] = []
  const pass = async (label: string, run: () => Promise<{ evaluated: number }>, what: string) => {
    try {
      const r = await run()
      if (r.evaluated > 0) log.info({ ...r }, what)
    } catch (err) { failures.push(`${label}: ${err instanceof Error ? err.message : String(err)}`) }
  }
  await pass('closed windows', () => reevaluateClosedWindows(now), 'Suppressed events re-evaluated (periodic)')
  await pass('pending', () => reevaluatePendingEvents(now), 'Pending events re-evaluated (periodic)')
  await pass('flapping', () => reevaluateFlappingEvents(now), 'Flapping events evaluated for stabilisation (periodic)')
  try {
    const r = await endCooledStorms(now)
    if (r.active > 0 || r.ended > 0) log.info(r, 'Alert storms checked for cooldown (periodic)')
  } catch (err) { failures.push(`storms: ${err instanceof Error ? err.message : String(err)}`) }
  if (failures.length) throw new Error(`[${EVENT_MAINTENANCE_QUEUE}] ${EVENT_MAINTENANCE_JOB}: ${failures.join('; ')}`)
}

/**
 * Accoda la valutazione ritardata. Awaited dal chiamante: una coda non
 * disponibile deve far fallire l'ingest (che ritenta), non lasciare l'evento
 * `delayed` per sempre.
 */
export async function enqueueCorrelation(tenantId: string, eventId: string, dueAt: string): Promise<void> {
  const delay = Math.max(Date.parse(dueAt) - Date.now(), 0)
  await getQueue<CorrelateQueueData>(EVENT_CORRELATE_QUEUE).add('correlate', { tenantId, eventId, dueAt }, {
    jobId: correlationJobId(tenantId, eventId, dueAt),
    delay,
    attempts: 3,
    backoff:  { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 3600, count: 10_000 },
    removeOnFail:     { age: 7 * 24 * 3600 },
  })
  log.info({ tenantId, eventId, dueAt, delayMs: delay }, 'Delayed correlation enqueued')
}

/**
 * Accoda la rivalutazione degli eventi silenziati da una change uscita dalla
 * finestra. Awaited dal chiamante e senza try/catch: l'accodamento è locale a
 * Redis e se fallisce deve propagare (fail-loud); l'esecuzione, lunga e
 * ritentabile, è nel job.
 */
export async function enqueueChangeWindowReevaluation(tenantId: string, changeId: string, stepEpoch: number): Promise<void> {
  await getQueue<CorrelateQueueData>(EVENT_CORRELATE_QUEUE).add(CHANGE_WINDOW_JOB, { tenantId, changeId, stepEpoch }, {
    jobId: changeWindowJobId(tenantId, changeId, stepEpoch),
    attempts: 3,
    backoff:  { type: 'exponential', delay: 5_000 },
    removeOnComplete: { age: 3600, count: 1_000 },
    removeOnFail:     { age: 7 * 24 * 3600 },
  })
  log.info({ tenantId, changeId, stepEpoch }, 'Change window re-evaluation enqueued')
}

export async function startEventCorrelateWorker(): Promise<Worker<CorrelateQueueData>> {
  const queue = getQueue<CorrelateQueueData>(EVENT_CORRELATE_QUEUE)
  // Prima della revisione il job periodico era un repeat job su questa coda:
  // BullMQ lo conserva in Redis, e questo processore non lo conosce più.
  const removed = await queue.removeRepeatable(LEGACY_REEVALUATE_WINDOWS_JOB, { every: LEGACY_REEVALUATE_WINDOWS_EVERY_MS }, LEGACY_REEVALUATE_WINDOWS_JOB)
  if (removed) log.info({ job: LEGACY_REEVALUATE_WINDOWS_JOB }, `Legacy repeat job removed from ${EVENT_CORRELATE_QUEUE} (now on ${EVENT_MAINTENANCE_QUEUE})`)
  return createWorker<CorrelateQueueData>(EVENT_CORRELATE_QUEUE, processCorrelateJob, {
    concurrency: 2,
    onFailed: (job, err) => {
      const d = job?.data as Partial<CorrelateJobData & ChangeWindowJobData> | undefined
      log.error({ jobId: job?.id, jobName: job?.name, tenantId: d?.tenantId, eventId: d?.eventId, changeId: d?.changeId, attemptsMade: job?.attemptsMade, err: err.message }, 'Event correlate job failed')
    },
  })
}

export async function startEventMaintenanceWorker(): Promise<Worker<Record<string, never>>> {
  const queue = getQueue<Record<string, never>>(EVENT_MAINTENANCE_QUEUE)
  // Repeat job: BullMQ deduplica per (name, repeat) — riavviare l'API non ne crea un secondo.
  await queue.add(EVENT_MAINTENANCE_JOB, {}, {
    repeat: { every: EVENT_MAINTENANCE_EVERY_MS },
    jobId: EVENT_MAINTENANCE_JOB,
    removeOnComplete: { count: 20 },
    removeOnFail:     { age: 7 * 24 * 3600 },
  })
  return createWorker<Record<string, never>>(EVENT_MAINTENANCE_QUEUE, processMaintenanceJob, {
    concurrency: 1,
    lockDuration: EVENT_MAINTENANCE_LOCK_MS,
    onFailed: (job, err) => {
      log.error({ jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade, err: err.message }, 'Event maintenance job failed')
    },
  })
}
