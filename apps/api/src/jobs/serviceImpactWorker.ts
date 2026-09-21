/**
 * BullMQ worker della coda `services-impact` (Servizi monitorati, ondata 1).
 *
 *  - `evaluate`           — valutazione di UNA mappa, accodata dal consumer di
 *                           `ci.health_changed` (consumers/serviceImpactConsumer.ts)
 *                           per ogni mappa che include il CI, e dalle mutation.
 *                           Dedup a FINESTRA (revisione 2 · Q1/D2.1):
 *                           `deduplication: {id: svc-<tenant>-<mapId>, ttl: 2 s}`
 *                           con `jobId` libero — una raffica di 40 CI dello
 *                           stesso servizio produce UNA valutazione (dedup
 *                           voluta), ma un cambio che arriva MENTRE il job gira
 *                           ne accoda uno nuovo. Con il vecchio `jobId` fisso
 *                           BullMQ scartava l'`add` finché il job esisteva —
 *                           anche in stato `active`, cioè dopo che la lettura del
 *                           grafo era già avvenuta: quel cambio si perdeva fino
 *                           alla passata periodica (~15 minuti).
 *  - `services-periodic`  — repeat job ogni 5 minuti (rete di sicurezza): mappe
 *                           attive non valutate da più di 10 minuti o stale
 *                           (engine.ts#evaluateStaleOrOldMaps, paginata) e
 *                           riallineamento dei gauge `services_health{health}`
 *                           e `service_maps_stale`.
 *  - `sync`               — sincronizzazione di UNA mappa viva con la CMDB
 *                           (ondata 5, services/serviceImpact/sync.ts):
 *                           accodata da `notifyCIGraphChanged` dopo ogni
 *                           scrittura che tocca le relazioni fra CI e dalla
 *                           mutation `syncServiceMap`. Stessa dedup a finestra
 *                           con id `svcsync-<tenant>-<mapId>` (diverso da quello
 *                           della valutazione: le due code di lavoro non si
 *                           deduplicano a vicenda): un import che tocca 500
 *                           relazioni produce UNA sincronizzazione per mappa,
 *                           non 500.
 *  - `services-sync-periodic` — repeat job ogni 30 minuti: rete di sicurezza
 *                           della sincronizzazione (mappe vive con `synced_at`
 *                           vecchio o mai sincronizzate), per le scritture
 *                           fatte da percorsi non strumentati — script,
 *                           migrazioni, Cypher a mano.
 *
 * Concurrency 2; `lockDuration` di 10 minuti perché la passata paginata può
 * superare i 30 s predefiniti. Gli id dei job non contengono ':' (BullMQ li
 * rifiuta).
 */
import type { Worker, Job } from 'bullmq'
import { logger } from '../lib/logger.js'
import { createWorker, getQueue } from '../lib/bullmq.js'
import { serviceEvaluationLagSeconds } from '../middleware/metrics.js'
import type { ServiceHealthTrigger } from '../lib/serviceVocabularies.js'
import { evaluateServiceMap, evaluateStaleOrOldMaps, refreshServiceGauges } from '../services/serviceImpact/engine.js'
import { SERVICE_MAP_SYNC_EVERY_MS, syncServiceMap, syncStaleOrOldMaps, type ServiceMapSyncTrigger } from '../services/serviceImpact/sync.js'

const log = logger.child({ module: 'service-impact' })

export const SERVICE_IMPACT_QUEUE = 'services-impact'
export const SERVICE_EVALUATE_JOB = 'evaluate'
export const SERVICE_SYNC_JOB = 'sync'
export const SERVICE_PERIODIC_JOB = 'services-periodic'
export const SERVICE_SYNC_PERIODIC_JOB = 'services-sync-periodic'
export const SERVICE_PERIODIC_EVERY_MS = 5 * 60 * 1000
export const SERVICE_IMPACT_LOCK_MS = 10 * 60 * 1000
/** Ritardo del job di valutazione: raccoglie i cambi di salute ravvicinati dello stesso servizio in una sola valutazione. */
export const SERVICE_EVALUATE_DELAY_MS = 2_000
export const SERVICE_EVALUATE_ATTEMPTS = 5
export const SERVICE_EVALUATE_BACKOFF_MS = 5_000

export interface ServiceEvaluateJobData {
  tenantId: string
  mapId:    string
  trigger:  ServiceHealthTrigger
}

export interface ServiceSyncJobData {
  tenantId: string
  mapId:    string
  trigger:  ServiceMapSyncTrigger
  /** Chi ha chiesto la sincronizzazione manuale (assente = monitoraggio). */
  actorId?: string
}

type ServiceQueueData = ServiceEvaluateJobData | ServiceSyncJobData | Record<string, never>

function assertJobId(id: string, what: string, tenantId: string, mapId: string): string {
  if (id.includes(':')) throw new Error(`${what}: job id must not contain ':' (tenant ${JSON.stringify(tenantId)}, map ${JSON.stringify(mapId)})`)
  return id
}

/** Chiave di deduplica della valutazione (non più il `jobId`: vedi il commento di testa). */
export function serviceMapJobId(tenantId: string, mapId: string): string {
  return assertJobId(`svc-${tenantId}-${mapId}`, 'serviceMapJobId', tenantId, mapId)
}

/** Chiave di deduplica della sincronizzazione: diversa da quella della valutazione (le due code di lavoro non si deduplicano a vicenda). */
export function serviceMapSyncJobId(tenantId: string, mapId: string): string {
  return assertJobId(`svcsync-${tenantId}-${mapId}`, 'serviceMapSyncJobId', tenantId, mapId)
}

/**
 * Opzioni comuni dei due job di lavoro: dedup a finestra (`ttl` = il ritardo di
 * debounce) e `jobId` libero. `removeOnComplete`/`removeOnFail` restano: la
 * chiave di deduplica scade da sola dopo il `ttl`, il job non deve restare in
 * coda; il fallimento resta nel log, nella metrica e la passata periodica
 * ripassa comunque.
 */
function serviceJobOptions(deduplicationId: string) {
  return {
    deduplication: { id: deduplicationId, ttl: SERVICE_EVALUATE_DELAY_MS },
    delay: SERVICE_EVALUATE_DELAY_MS,
    attempts: SERVICE_EVALUATE_ATTEMPTS,
    backoff:  { type: 'exponential', delay: SERVICE_EVALUATE_BACKOFF_MS },
    removeOnComplete: true,
    removeOnFail:     true,
  }
}

/**
 * Accoda la valutazione della mappa (dedup a finestra di 2 s). Awaited dal
 * chiamante e senza try/catch: una coda non disponibile deve far fallire il
 * consumer (che ritenta), non perdere la valutazione in silenzio.
 */
export async function enqueueServiceMapEvaluation(tenantId: string, mapId: string, trigger: ServiceHealthTrigger = 'ci_health'): Promise<void> {
  await getQueue<ServiceQueueData>(SERVICE_IMPACT_QUEUE).add(SERVICE_EVALUATE_JOB, { tenantId, mapId, trigger }, serviceJobOptions(serviceMapJobId(tenantId, mapId)))
  log.info({ tenantId, mapId, trigger }, 'Service map evaluation enqueued')
}

/**
 * Accoda la sincronizzazione della mappa con la CMDB (dedup a finestra di 2 s).
 * Chiamata da `notifyCIGraphChanged` (che la avvolge in un try/catch: una coda
 * giù non deve far fallire la scrittura CMDB già committata) e dalla mutation
 * `syncServiceMap`.
 */
export async function enqueueServiceMapSync(tenantId: string, mapId: string, trigger: ServiceMapSyncTrigger, actorId?: string): Promise<void> {
  await getQueue<ServiceQueueData>(SERVICE_IMPACT_QUEUE).add(SERVICE_SYNC_JOB, { tenantId, mapId, trigger, ...(actorId ? { actorId } : {}) }, serviceJobOptions(serviceMapSyncJobId(tenantId, mapId)))
  log.info({ tenantId, mapId, trigger }, 'Service map synchronization enqueued')
}

/**
 * Toglie dalla coda i job in attesa di UNA mappa e le sue chiavi di deduplica
 * (`deleteServiceMap`): senza il `jobId` fisso non basta più `queue.remove(id)`,
 * quindi si cercano i job per dati. I job già in esecuzione non si toccano:
 * falliranno con NOT_FOUND, visibile nel log. Non lancia mai — la mappa è già
 * cancellata — ma restituisce quanti ne ha tolti.
 */
export async function forgetServiceMapJobs(tenantId: string, mapId: string): Promise<number> {
  const queue = getQueue<ServiceQueueData>(SERVICE_IMPACT_QUEUE)
  let removed = 0
  for (const id of [serviceMapJobId(tenantId, mapId), serviceMapSyncJobId(tenantId, mapId)]) {
    try {
      await queue.removeDeduplicationKey(id)
    } catch (err) {
      log.warn({ err, tenantId, mapId, deduplicationId: id }, 'Deduplication key could not be removed after map deletion')
    }
  }
  try {
    const pending = await queue.getJobs(['delayed', 'waiting', 'prioritized'])
    for (const job of pending) {
      const d = job.data as Partial<ServiceEvaluateJobData>
      if (d.tenantId !== tenantId || d.mapId !== mapId) continue
      await job.remove()
      removed++
    }
  } catch (err) {
    log.warn({ err, tenantId, mapId }, 'Pending jobs could not be removed after map deletion (they will fail with NOT_FOUND)')
  }
  return removed
}

async function processServiceJob(job: Job<ServiceQueueData>): Promise<void> {
  switch (job.name) {
    case SERVICE_EVALUATE_JOB: {
      const { tenantId, mapId, trigger } = job.data as ServiceEvaluateJobData
      // Ritardo rispetto all'istante in cui il job era atteso (accodamento +
      // ritardo di dedup): stessa formula di event_correlate_job_lag_seconds
      // (jobs/eventCorrelateWorker.ts), mai negativo — un job non parte prima
      // del suo delay. Un `job.timestamp` assente (job costruito a mano) non
      // produce un valore inventato: la misura si salta.
      const dueAt = job.timestamp + SERVICE_EVALUATE_DELAY_MS
      const lagSeconds = Math.max(0, (Date.now() - dueAt) / 1000)
      if (Number.isFinite(lagSeconds)) serviceEvaluationLagSeconds.observe({}, lagSeconds)
      const result = await evaluateServiceMap({ tenantId, mapId, trigger, jobId: String(job.id) })
      log.info({ jobId: job.id, tenantId, mapId, trigger, lagSeconds, health: result.health, impactScore: result.impactScore, changed: result.changed, stale: result.stale }, 'Service map evaluated')
      return
    }
    case SERVICE_SYNC_JOB: {
      const { tenantId, mapId, trigger, actorId } = job.data as ServiceSyncJobData
      const r = await syncServiceMap(tenantId, mapId, trigger, actorId)
      log.info({ jobId: job.id, tenantId, mapId, trigger, changed: r.changed, skipped: r.skipped, added: r.added, removed: r.removed, moved: r.moved, version: r.version }, 'Service map synchronized')
      return
    }
    case SERVICE_SYNC_PERIODIC_JOB: {
      const r = await syncStaleOrOldMaps()
      if (r.evaluated > 0) log.info({ ...r }, 'Service maps synchronized with the CMDB (periodic safety net)')
      return
    }
    case SERVICE_PERIODIC_JOB: {
      const now = new Date().toISOString()
      const failures: string[] = []
      try {
        const r = await evaluateStaleOrOldMaps(now)
        if (r.evaluated > 0) log.info({ ...r }, 'Stale or old service maps evaluated (periodic)')
      } catch (err) {
        failures.push(`evaluate: ${err instanceof Error ? err.message : String(err)}`)
      }
      try {
        await refreshServiceGauges()
      } catch (err) {
        failures.push(`gauges: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (failures.length) throw new Error(`[${SERVICE_IMPACT_QUEUE}] ${SERVICE_PERIODIC_JOB}: ${failures.join('; ')}`)
      return
    }
    default:
      throw new Error(`[${SERVICE_IMPACT_QUEUE}] unknown job "${job.name}"`)
  }
}

export async function startServiceImpactWorker(): Promise<Worker<ServiceQueueData>> {
  const queue = getQueue<ServiceQueueData>(SERVICE_IMPACT_QUEUE)
  // Repeat job: BullMQ deduplica per (name, repeat) — riavviare l'API non ne crea un secondo.
  await queue.add(SERVICE_PERIODIC_JOB, {}, {
    repeat: { every: SERVICE_PERIODIC_EVERY_MS },
    jobId: SERVICE_PERIODIC_JOB,
    removeOnComplete: { count: 20 },
    removeOnFail:     { age: 7 * 24 * 3600 },
  })
  // Rete di sicurezza della mappa viva (ondata 5): rada di proposito, il
  // meccanismo principale è `notifyCIGraphChanged` (immediato).
  await queue.add(SERVICE_SYNC_PERIODIC_JOB, {}, {
    repeat: { every: SERVICE_MAP_SYNC_EVERY_MS },
    jobId: SERVICE_SYNC_PERIODIC_JOB,
    removeOnComplete: { count: 20 },
    removeOnFail:     { age: 7 * 24 * 3600 },
  })
  return createWorker<ServiceQueueData>(SERVICE_IMPACT_QUEUE, processServiceJob, {
    concurrency: 2,
    lockDuration: SERVICE_IMPACT_LOCK_MS,
    onFailed: (job, err) => {
      const d = job?.data as Partial<ServiceEvaluateJobData> | undefined
      log.error({ jobId: job?.id, jobName: job?.name, tenantId: d?.tenantId, mapId: d?.mapId, trigger: d?.trigger, attemptsMade: job?.attemptsMade, err: err.message }, 'Service impact job failed')
    },
  })
}
