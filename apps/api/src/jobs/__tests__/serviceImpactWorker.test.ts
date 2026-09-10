/**
 * jobs/serviceImpactWorker.ts — coda `services-impact`: enqueueServiceMapEvaluation
 * (job id fisso svc-<tenant>-<mapId> senza ':', ritardo 2 s, 5 tentativi con
 * backoff 5 s, rimozione a completamento/fallimento così l'id non blocca le
 * valutazioni successive; nessun try/catch: l'errore propaga), job `evaluate`
 * → evaluateServiceMap con il job id nei log, repeat job `services-periodic`
 * ogni 5 minuti (passata + gauge, ognuno anche se l'altro fallisce), worker
 * con concurrency 2 e lockDuration 10 min, job sconosciuto → errore.
 *
 * Ondata 4: istogramma `service_evaluation_lag_seconds` — secondi fra
 * l'istante in cui il job era atteso (`job.timestamp` + ritardo di dedup) e
 * l'inizio della valutazione, come `event_correlate_job_lag_seconds`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

type AnyProcessor = (job: Job) => Promise<unknown>
const processors = new Map<string, AnyProcessor>()
const queueAdd = vi.fn().mockResolvedValue(undefined)

vi.mock('../../lib/bullmq.js', () => ({
  createWorker: vi.fn((name: string, processor: AnyProcessor, opts?: unknown) => {
    processors.set(name, processor)
    return { name, opts, on: vi.fn(), close: vi.fn() }
  }),
  getQueue: vi.fn(() => ({ add: queueAdd })),
}))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../../middleware/metrics.js', () => ({ serviceEvaluationLagSeconds: { observe: vi.fn() } }))
vi.mock('../../services/serviceImpact/engine.js', () => ({
  evaluateServiceMap: vi.fn().mockResolvedValue({ mapId: 'm1', health: 'degraded', previousHealth: 'operational', impactScore: 41, changed: true, stale: false, causes: [] }),
  evaluateStaleOrOldMaps: vi.fn().mockResolvedValue({ evaluated: 1, failed: 0, truncated: false }),
  refreshServiceGauges: vi.fn().mockResolvedValue({ operational: 1, degraded: 0, down: 0, maintenance: 0, unknown: 0 }),
}))

const worker = await import('../serviceImpactWorker.js')
const {
  enqueueServiceMapEvaluation, serviceMapJobId, startServiceImpactWorker,
  SERVICE_IMPACT_QUEUE, SERVICE_EVALUATE_JOB, SERVICE_PERIODIC_JOB, SERVICE_PERIODIC_EVERY_MS, SERVICE_IMPACT_LOCK_MS, SERVICE_EVALUATE_DELAY_MS,
} = worker
const { createWorker, getQueue } = await import('../../lib/bullmq.js')
const { evaluateServiceMap, evaluateStaleOrOldMaps, refreshServiceGauges } = await import('../../services/serviceImpact/engine.js')
const metrics = await import('../../middleware/metrics.js')

const job = (name: string, data: Record<string, unknown> = {}, timestamp = Date.now()) =>
  ({ name, data, id: 'j1', attemptsMade: 0, timestamp } as unknown as Job)

beforeEach(() => {
  vi.clearAllMocks()
  processors.clear()
  vi.mocked(evaluateStaleOrOldMaps).mockResolvedValue({ evaluated: 1, failed: 0, truncated: false })
  vi.mocked(refreshServiceGauges).mockResolvedValue({ operational: 1, degraded: 0, down: 0, maintenance: 0, unknown: 0 })
})

describe('enqueueServiceMapEvaluation (dedup per mappa)', () => {
  it('accoda `evaluate` con job id svc-<tenant>-<mapId>, ritardo 2 s, 5 tentativi con backoff esponenziale 5 s, rimosso a completamento e fallimento', async () => {
    await enqueueServiceMapEvaluation('c-one', 'map-1', 'ci_health')
    expect(getQueue).toHaveBeenCalledWith(SERVICE_IMPACT_QUEUE)
    expect(SERVICE_IMPACT_QUEUE).toBe('services-impact')
    expect(queueAdd).toHaveBeenCalledWith(SERVICE_EVALUATE_JOB, { tenantId: 'c-one', mapId: 'map-1', trigger: 'ci_health' }, {
      jobId: 'svc-c-one-map-1', delay: 2_000, attempts: 5, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: true,
    })
    expect(SERVICE_EVALUATE_DELAY_MS).toBe(2_000)
  })

  it('trigger predefinito ci_health; lo stesso (tenant, mappa) produce sempre lo stesso id (è BullMQ a scartare il doppione)', async () => {
    await enqueueServiceMapEvaluation('t1', 'm1')
    await enqueueServiceMapEvaluation('t1', 'm1')
    expect(vi.mocked(queueAdd).mock.calls.map((c) => (c[2] as { jobId: string }).jobId)).toEqual(['svc-t1-m1', 'svc-t1-m1'])
    expect(vi.mocked(queueAdd).mock.calls[0]![1]).toMatchObject({ trigger: 'ci_health' })
  })

  it('job id senza ":" (BullMQ lo rifiuta): un id con ":" è un errore; coda non disponibile → l\'errore propaga', async () => {
    expect(serviceMapJobId('t1', 'm1')).not.toContain(':')
    expect(() => serviceMapJobId('t:1', 'm1')).toThrow(/must not contain ':'/)
    queueAdd.mockRejectedValueOnce(new Error('Redis down'))
    await expect(enqueueServiceMapEvaluation('t1', 'm1')).rejects.toThrow('Redis down')
  })
})

describe('worker services-impact', () => {
  it('startServiceImpactWorker: registra il repeat job ogni 5 minuti e avvia il worker con concurrency 2 e lockDuration 10 min', async () => {
    const w = await startServiceImpactWorker()
    expect(w.name).toBe(SERVICE_IMPACT_QUEUE)
    expect(queueAdd).toHaveBeenCalledWith(SERVICE_PERIODIC_JOB, {}, expect.objectContaining({ repeat: { every: SERVICE_PERIODIC_EVERY_MS }, jobId: SERVICE_PERIODIC_JOB, removeOnComplete: { count: 20 } }))
    expect(SERVICE_PERIODIC_EVERY_MS).toBe(5 * 60 * 1000)
    expect(SERVICE_IMPACT_LOCK_MS).toBe(10 * 60 * 1000)
    expect(createWorker).toHaveBeenCalledWith(SERVICE_IMPACT_QUEUE, expect.any(Function), expect.objectContaining({ concurrency: 2, lockDuration: SERVICE_IMPACT_LOCK_MS }))
  })

  it('`evaluate` → evaluateServiceMap(tenant, mappa, trigger) con il job id; un errore del motore fa fallire il job (ritenta)', async () => {
    await startServiceImpactWorker()
    const proc = processors.get(SERVICE_IMPACT_QUEUE)!
    await proc(job(SERVICE_EVALUATE_JOB, { tenantId: 't1', mapId: 'm1', trigger: 'ci_health' }))
    expect(evaluateServiceMap).toHaveBeenCalledWith({ tenantId: 't1', mapId: 'm1', trigger: 'ci_health', jobId: 'j1' })
    vi.mocked(evaluateServiceMap).mockRejectedValueOnce(new Error('ServiceMap m1 not found'))
    await expect(proc(job(SERVICE_EVALUATE_JOB, { tenantId: 't1', mapId: 'm1', trigger: 'ci_health' }))).rejects.toThrow(/not found/)
  })

  it('`services-periodic` → passata delle mappe vecchie/stale + gauge; ognuno gira anche se l\'altro fallisce, il job fallisce con tutti i motivi; job sconosciuto → errore', async () => {
    await startServiceImpactWorker()
    const proc = processors.get(SERVICE_IMPACT_QUEUE)!
    await proc(job(SERVICE_PERIODIC_JOB))
    expect(evaluateStaleOrOldMaps).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/))
    expect(refreshServiceGauges).toHaveBeenCalledTimes(1)

    vi.mocked(evaluateStaleOrOldMaps).mockRejectedValueOnce(new Error('1/2 service maps failed'))
    vi.mocked(refreshServiceGauges).mockRejectedValueOnce(new Error('neo4j down'))
    await expect(proc(job(SERVICE_PERIODIC_JOB))).rejects.toThrow(/\[services-impact\] services-periodic: evaluate: 1\/2 service maps failed; gauges: neo4j down/)
    expect(refreshServiceGauges).toHaveBeenCalledTimes(2)
    await expect(proc(job('nope'))).rejects.toThrow(/\[services-impact\] unknown job "nope"/)
  })
})

// ── Ondata 4 §1: ritardo del job ─────────────────────────────────────────────

describe('service_evaluation_lag_seconds', () => {
  it('misura i secondi fra l\'istante atteso (accodamento + ritardo di dedup) e l\'inizio della valutazione, una volta per job', async () => {
    await startServiceImpactWorker()
    const proc = processors.get(SERVICE_IMPACT_QUEUE)!
    // accodato 32 s fa con 2 s di ritardo → atteso 30 s fa
    await proc(job(SERVICE_EVALUATE_JOB, { tenantId: 't1', mapId: 'm1', trigger: 'ci_health' }, Date.now() - 32_000))
    expect(metrics.serviceEvaluationLagSeconds.observe).toHaveBeenCalledTimes(1)
    const [labels, lag] = vi.mocked(metrics.serviceEvaluationLagSeconds.observe).mock.calls[0]!
    expect(labels).toEqual({})
    expect(lag).toBeGreaterThanOrEqual(29.5)
    expect(lag).toBeLessThan(31)
  })

  it('job partito puntuale → 0, mai un valore negativo; `services-periodic` non misura nulla', async () => {
    await startServiceImpactWorker()
    const proc = processors.get(SERVICE_IMPACT_QUEUE)!
    await proc(job(SERVICE_EVALUATE_JOB, { tenantId: 't1', mapId: 'm1', trigger: 'ci_health' }, Date.now()))
    expect(vi.mocked(metrics.serviceEvaluationLagSeconds.observe).mock.calls[0]![1]).toBe(0)
    vi.mocked(metrics.serviceEvaluationLagSeconds.observe).mockClear()
    await proc(job(SERVICE_PERIODIC_JOB))
    expect(metrics.serviceEvaluationLagSeconds.observe).not.toHaveBeenCalled()
  })

  it('job senza timestamp (non accodato da BullMQ) → nessuna misura inventata', async () => {
    await startServiceImpactWorker()
    const proc = processors.get(SERVICE_IMPACT_QUEUE)!
    await proc({ name: SERVICE_EVALUATE_JOB, data: { tenantId: 't1', mapId: 'm1', trigger: 'ci_health' }, id: 'j1' } as unknown as Job)
    expect(metrics.serviceEvaluationLagSeconds.observe).not.toHaveBeenCalled()
    expect(evaluateServiceMap).toHaveBeenCalledTimes(1)
  })
})
