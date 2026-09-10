/**
 * BullMQ worker della coda `services-impact` (Servizi monitorati, ondata 1).
 *
 *  - `evaluate`           — valutazione di UNA mappa, accodata dal consumer di
 *                           `ci.health_changed` (consumers/serviceImpactConsumer.ts)
 *                           per ogni mappa che include il CI, e dalle mutation.
 *                           Job id fisso `svc-<tenant>-<mapId>` con ritardo di
 *                           2 s: BullMQ scarta un secondo `add` con lo stesso id
 *                           finché il job esiste, quindi una raffica di 40 CI
 *                           dello stesso servizio produce UNA valutazione (dedup
 *                           voluta). Per questo il job viene rimosso appena
 *                           completato o fallito in via definitiva: un id che
 *                           restasse in coda bloccherebbe le valutazioni
 *                           successive; il fallimento resta nel log, nella
 *                           metrica `service_evaluations_total{result="error"}`
 *                           e la passata periodica rivaluta comunque la mappa.
 *  - `services-periodic`  — repeat job ogni 5 minuti (rete di sicurezza): mappe
 *                           attive non valutate da più di 10 minuti o stale
 *                           (engine.ts#evaluateStaleOrOldMaps, paginata) e
 *                           riallineamento dei gauge `services_health{health}`
 *                           e `service_maps_stale`.
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

const log = logger.child({ module: 'service-impact' })

export const SERVICE_IMPACT_QUEUE = 'services-impact'
export const SERVICE_EVALUATE_JOB = 'evaluate'
export const SERVICE_PERIODIC_JOB = 'services-periodic'
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

type ServiceQueueData = ServiceEvaluateJobData | Record<string, never>

export function serviceMapJobId(tenantId: string, mapId: string): string {
  const id = `svc-${tenantId}-${mapId}`
  if (id.includes(':')) throw new Error(`serviceMapJobId: job id must not contain ':' (tenant ${JSON.stringify(tenantId)}, map ${JSON.stringify(mapId)})`)
  return id
}

/**
 * Accoda la valutazione della mappa (dedup per job id). Awaited dal chiamante
 * e senza try/catch: una coda non disponibile deve far fallire il consumer
 * (che ritenta), non perdere la valutazione in silenzio.
 */
export async function enqueueServiceMapEvaluation(tenantId: string, mapId: string, trigger: ServiceHealthTrigger = 'ci_health'): Promise<void> {
  await getQueue<ServiceQueueData>(SERVICE_IMPACT_QUEUE).add(SERVICE_EVALUATE_JOB, { tenantId, mapId, trigger }, {
    jobId: serviceMapJobId(tenantId, mapId),
    delay: SERVICE_EVALUATE_DELAY_MS,
    attempts: SERVICE_EVALUATE_ATTEMPTS,
    backoff:  { type: 'exponential', delay: SERVICE_EVALUATE_BACKOFF_MS },
    removeOnComplete: true,
    removeOnFail:     true,
  })
  log.info({ tenantId, mapId, trigger }, 'Service map evaluation enqueued')
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
  return createWorker<ServiceQueueData>(SERVICE_IMPACT_QUEUE, processServiceJob, {
    concurrency: 2,
    lockDuration: SERVICE_IMPACT_LOCK_MS,
    onFailed: (job, err) => {
      const d = job?.data as Partial<ServiceEvaluateJobData> | undefined
      log.error({ jobId: job?.id, jobName: job?.name, tenantId: d?.tenantId, mapId: d?.mapId, trigger: d?.trigger, attemptsMade: job?.attemptsMade, err: err.message }, 'Service impact job failed')
    },
  })
}
