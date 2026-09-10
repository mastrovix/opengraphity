/**
 * jobs/serviceImpactWorker.ts — coda `services-impact`: enqueueServiceMapEvaluation
 * (dedup a FINESTRA `deduplication: {id: svc-<tenant>-<mapId>, ttl: 2 s}` con
 * `jobId` libero — revisione 2 · Q1/D2.1 —, ritardo 2 s, 5 tentativi con
 * backoff 5 s, rimozione a completamento/fallimento; nessun try/catch: l'errore
 * propaga), `forgetServiceMapJobs` per la mappa cancellata, job `evaluate`
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
const queueGetJobs = vi.fn().mockResolvedValue([])
const queueRemoveDeduplicationKey = vi.fn().mockResolvedValue(1)

vi.mock('../../lib/bullmq.js', () => ({
  createWorker: vi.fn((name: string, processor: AnyProcessor, opts?: unknown) => {
    processors.set(name, processor)
    return { name, opts, on: vi.fn(), close: vi.fn() }
  }),
  getQueue: vi.fn(() => ({ add: queueAdd, getJobs: queueGetJobs, removeDeduplicationKey: queueRemoveDeduplicationKey })),
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
vi.mock('../../services/serviceImpact/sync.js', () => ({
  SERVICE_MAP_SYNC_EVERY_MS: 30 * 60 * 1000,
  syncServiceMap: vi.fn().mockResolvedValue({ mapId: 'm1', version: 3, status: 'active', added: 1, removed: 0, moved: 0, changed: true, skipped: null, reason: null, syncedAt: 'T', note: 'nota', evaluation: null }),
  syncStaleOrOldMaps: vi.fn().mockResolvedValue({ evaluated: 2, failed: 0, truncated: false }),
}))

const worker = await import('../serviceImpactWorker.js')
const {
  enqueueServiceMapEvaluation, serviceMapJobId, startServiceImpactWorker,
  SERVICE_IMPACT_QUEUE, SERVICE_EVALUATE_JOB, SERVICE_PERIODIC_JOB, SERVICE_PERIODIC_EVERY_MS, SERVICE_IMPACT_LOCK_MS, SERVICE_EVALUATE_DELAY_MS,
} = worker
const {
  enqueueServiceMapSync, serviceMapSyncJobId, forgetServiceMapJobs, SERVICE_SYNC_JOB, SERVICE_SYNC_PERIODIC_JOB,
} = worker
const { createWorker, getQueue } = await import('../../lib/bullmq.js')
const { evaluateServiceMap, evaluateStaleOrOldMaps, refreshServiceGauges } = await import('../../services/serviceImpact/engine.js')
const { syncServiceMap, syncStaleOrOldMaps, SERVICE_MAP_SYNC_EVERY_MS } = await import('../../services/serviceImpact/sync.js')
const metrics = await import('../../middleware/metrics.js')

const job = (name: string, data: Record<string, unknown> = {}, timestamp = Date.now()) =>
  ({ name, data, id: 'j1', attemptsMade: 0, timestamp } as unknown as Job)

beforeEach(() => {
  vi.clearAllMocks()
  processors.clear()
  queueGetJobs.mockResolvedValue([])
  queueRemoveDeduplicationKey.mockResolvedValue(1)
  vi.mocked(evaluateStaleOrOldMaps).mockResolvedValue({ evaluated: 1, failed: 0, truncated: false })
  vi.mocked(refreshServiceGauges).mockResolvedValue({ operational: 1, degraded: 0, down: 0, maintenance: 0, unknown: 0 })
})

describe('enqueueServiceMapEvaluation (dedup a finestra, revisione 2 · Q1/D2.1)', () => {
  it('accoda `evaluate` con deduplication {id: svc-<tenant>-<mapId>, ttl: 2 s} e NESSUN jobId fisso, ritardo 2 s, 5 tentativi con backoff esponenziale 5 s, rimosso a completamento e fallimento', async () => {
    await enqueueServiceMapEvaluation('c-one', 'map-1', 'ci_health')
    expect(getQueue).toHaveBeenCalledWith(SERVICE_IMPACT_QUEUE)
    expect(SERVICE_IMPACT_QUEUE).toBe('services-impact')
    expect(queueAdd).toHaveBeenCalledWith(SERVICE_EVALUATE_JOB, { tenantId: 'c-one', mapId: 'map-1', trigger: 'ci_health' }, {
      deduplication: { id: 'svc-c-one-map-1', ttl: 2_000 },
      delay: 2_000, attempts: 5, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: true,
    })
    // il jobId fisso era il difetto: bloccava gli `add` anche mentre il job era ATTIVO
    expect(vi.mocked(queueAdd).mock.calls[0]![2]).not.toHaveProperty('jobId')
    expect(SERVICE_EVALUATE_DELAY_MS).toBe(2_000)
  })

  it('la finestra di deduplica è il debounce, non la durata del job: due `add` hanno lo stesso id e lo stesso ttl (BullMQ scarta il secondo solo entro il ttl)', async () => {
    await enqueueServiceMapEvaluation('t1', 'm1')
    await enqueueServiceMapEvaluation('t1', 'm1')
    expect(vi.mocked(queueAdd).mock.calls.map((c) => (c[2] as { deduplication: { id: string; ttl: number } }).deduplication)).toEqual([
      { id: 'svc-t1-m1', ttl: SERVICE_EVALUATE_DELAY_MS },
      { id: 'svc-t1-m1', ttl: SERVICE_EVALUATE_DELAY_MS },
    ])
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

// ── Ondata 5: mappa viva ─────────────────────────────────────────────────────

describe('sincronizzazione con la CMDB (ondata 5)', () => {
  it('enqueueServiceMapSync: dedup svcsync-<tenant>-<mapId> (diversa da quella della valutazione, senza ":"), stesso ritardo e stessi tentativi', async () => {
    await enqueueServiceMapSync('c-one', 'map-1', 'periodic')
    expect(queueAdd).toHaveBeenCalledWith(SERVICE_SYNC_JOB, { tenantId: 'c-one', mapId: 'map-1', trigger: 'periodic' }, {
      deduplication: { id: 'svcsync-c-one-map-1', ttl: 2_000 },
      delay: 2_000, attempts: 5, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: true, removeOnFail: true,
    })
    expect(SERVICE_SYNC_JOB).toBe('sync')
    expect(serviceMapSyncJobId('t1', 'm1')).not.toBe(serviceMapJobId('t1', 'm1'))
    expect(serviceMapSyncJobId('t1', 'm1')).not.toContain(':')
    expect(() => serviceMapSyncJobId('t:1', 'm1')).toThrow(/must not contain ':'/)
    // manuale: l'attore viaggia col job (serve alla nota di cronologia)
    await enqueueServiceMapSync('t1', 'm1', 'manual', 'adm-1')
    expect(vi.mocked(queueAdd).mock.calls.at(-1)![1]).toEqual({ tenantId: 't1', mapId: 'm1', trigger: 'manual', actorId: 'adm-1' })
  })

  it('`sync` → syncServiceMap(tenant, mappa, trigger, attore); un errore fa fallire il job (ritenta)', async () => {
    await startServiceImpactWorker()
    const proc = processors.get(SERVICE_IMPACT_QUEUE)!
    await proc(job(SERVICE_SYNC_JOB, { tenantId: 't1', mapId: 'm1', trigger: 'manual', actorId: 'adm-1' }))
    expect(syncServiceMap).toHaveBeenCalledWith('t1', 'm1', 'manual', 'adm-1')
    vi.mocked(syncServiceMap).mockRejectedValueOnce(new Error('ServiceMap m1 not found'))
    await expect(proc(job(SERVICE_SYNC_JOB, { tenantId: 't1', mapId: 'm1', trigger: 'periodic' }))).rejects.toThrow(/not found/)
  })

  it('rete di sicurezza `services-sync-periodic`: repeat job ogni 30 minuti (rada di proposito: l\'immediatezza la dà notifyCIGraphChanged)', async () => {
    await startServiceImpactWorker()
    expect(queueAdd).toHaveBeenCalledWith(SERVICE_SYNC_PERIODIC_JOB, {}, expect.objectContaining({ repeat: { every: SERVICE_MAP_SYNC_EVERY_MS }, jobId: SERVICE_SYNC_PERIODIC_JOB }))
    expect(SERVICE_MAP_SYNC_EVERY_MS).toBe(30 * 60 * 1000)
    const proc = processors.get(SERVICE_IMPACT_QUEUE)!
    await proc(job(SERVICE_SYNC_PERIODIC_JOB))
    expect(syncStaleOrOldMaps).toHaveBeenCalledTimes(1)
    vi.mocked(syncStaleOrOldMaps).mockRejectedValueOnce(new Error('1/2 service maps failed synchronization'))
    await expect(proc(job(SERVICE_SYNC_PERIODIC_JOB))).rejects.toThrow(/1\/2 service maps failed synchronization/)
  })
})

// ── Revisione 2 · Q1: dimenticare i job di una mappa cancellata ──────────────

describe('forgetServiceMapJobs', () => {
  it('toglie le due chiavi di deduplica e i job in attesa della SOLA mappa (gli altri restano)', async () => {
    const mine = { data: { tenantId: 't1', mapId: 'm1' }, remove: vi.fn().mockResolvedValue(undefined) }
    const mineSync = { data: { tenantId: 't1', mapId: 'm1', trigger: 'periodic' }, remove: vi.fn().mockResolvedValue(undefined) }
    const other = { data: { tenantId: 't1', mapId: 'm2' }, remove: vi.fn().mockResolvedValue(undefined) }
    queueGetJobs.mockResolvedValueOnce([mine, mineSync, other])
    expect(await forgetServiceMapJobs('t1', 'm1')).toBe(2)
    expect(queueRemoveDeduplicationKey.mock.calls.map((c) => c[0])).toEqual(['svc-t1-m1', 'svcsync-t1-m1'])
    expect(queueGetJobs).toHaveBeenCalledWith(['delayed', 'waiting', 'prioritized'])
    expect(mine.remove).toHaveBeenCalledTimes(1)
    expect(mineSync.remove).toHaveBeenCalledTimes(1)
    expect(other.remove).not.toHaveBeenCalled()
  })

  it('coda irraggiungibile: NON lancia (la mappa è già cancellata), solo un warning', async () => {
    queueRemoveDeduplicationKey.mockRejectedValueOnce(new Error('redis down'))
    queueGetJobs.mockRejectedValueOnce(new Error('redis down'))
    await expect(forgetServiceMapJobs('t1', 'm1')).resolves.toBe(0)
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
