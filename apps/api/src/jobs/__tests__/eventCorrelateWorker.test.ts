/**
 * jobs/eventCorrelateWorker.ts — due code:
 *  - events-correlate: enqueueCorrelation (job id deterministico
 *    corr-<tenant>-<evento>-<dueMs>, ritardo = scadenza − ora mai negativo,
 *    errore su scadenza non ISO) → `correlate` = pipeline in modalità resume;
 *    enqueueChangeWindowReevaluation (job id win-<tenant>-<change>-<epoca>,
 *    tentativi con backoff, nessun try/catch: l'errore propaga) →
 *    `reevaluate-change-window` = reevaluateSuppressedEvents; job sconosciuto
 *    → errore; all'avvio rimuove il repeat job legacy `reevaluate-windows`.
 *  - events-maintenance (concurrency 1, lockDuration 10 min): repeat job ogni
 *    5 minuti → cinque passate (finestre chiuse, pending, sfarfallio,
 *    tempeste raffreddate, gauge di salute), ciascuna eseguita e misurata
 *    (event_pass_total/duration) anche se un'altra fallisce, con errore
 *    cumulativo alla fine, con le passate che condividono la causa accorpate
 *    in una voce sola; il job `correlate` misura il ritardo dalla scadenza.
 * BullMQ è mockato attraverso lib/bullmq.ts; i processori sono catturati da createWorker.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

type AnyProcessor = (job: Job) => Promise<unknown>
const processors = new Map<string, AnyProcessor>()
const queueAdd = vi.fn().mockResolvedValue(undefined)
/*
 * `upsertJobScheduler` nel finto (21 set 2026, BullMQ 6): le ricorrenze non
 * passano piu' da `add({ repeat })` — quella API non esiste piu' — ma da un
 * Job Scheduler con identita' esplicita. Il finto deve esporre quello che il
 * codice chiama davvero, se no il test prova un cammino che non esiste.
 */
const upsertScheduler = vi.fn().mockResolvedValue(undefined)
const removeScheduler = vi.fn().mockResolvedValue(true)
// rimpiazzato da removeScheduler (BullMQ 6)
/** Job già in coda con quell'id (revisione 2 · B2-02): null = nessuno. */
const queueGetJob = vi.fn().mockResolvedValue(null)

const poolOpts = new Map<string, { schedule?: (queue: unknown, tenantId: string) => Promise<void> }>()
const fakeQueue = { add: queueAdd, upsertJobScheduler: upsertScheduler, removeJobScheduler: removeScheduler, getJob: queueGetJob }
vi.mock('../../lib/bullmq.js', () => ({
  createTenantWorkers: vi.fn((name: string, processor: AnyProcessor, opts?: { schedule?: (queue: unknown, tenantId: string) => Promise<void> }) => {
    processors.set(name, processor)
    poolOpts.set(name, opts ?? {})
    return { name, opts, close: vi.fn() }
  }),
  getTenantQueue: vi.fn(() => fakeQueue),
}))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../../services/eventCorrelation.js', () => ({
  runEventPipeline: vi.fn().mockResolvedValue({ outcome: 'opened', status: 'firing', suppressedByChangeId: null, incidentId: 'inc-1' }),
  reevaluateSuppressedEvents: vi.fn().mockResolvedValue(3),
  reevaluateClosedWindows: vi.fn(),
  reevaluatePendingEvents: vi.fn(),
  reevaluateFlappingEvents: vi.fn(),
  refreshEventGauges: vi.fn().mockResolvedValue({ overdueDelayed: 0, firingUncorrelated: 0 }),
}))
vi.mock('../../services/eventStorm.js', () => ({ endCooledStorms: vi.fn() }))
// Servizi monitorati (revisione 2 · D6.1): a fine finestra la rivalutazione
// degli allarmi pubblica `ci.health_changed` solo se la salute cambia, quindi
// il segnale ai servizi dev'essere esplicito.
vi.mock('../../services/serviceImpact/sync.js', () => ({ notifyChangeWindowChanged: vi.fn().mockResolvedValue(2) }))
vi.mock('../../middleware/metrics.js', () => ({
  eventCorrelateJobLagSeconds: { observe: vi.fn() }, eventPassTotal: { inc: vi.fn() }, eventPassDurationSeconds: { observe: vi.fn() },
}))

const worker = await import('../eventCorrelateWorker.js')
const {
  enqueueCorrelation, correlationJobId, enqueueChangeWindowReevaluation, changeWindowJobId, runPeriodicPasses,
  startEventCorrelateWorker, startEventMaintenanceWorker,
  EVENT_CORRELATE_QUEUE, EVENT_MAINTENANCE_QUEUE, CHANGE_WINDOW_JOB, EVENT_MAINTENANCE_JOB, EVENT_MAINTENANCE_EVERY_MS, EVENT_MAINTENANCE_LOCK_MS,
} = worker
const { createTenantWorkers, getTenantQueue } = await import('../../lib/bullmq.js')
const { notifyChangeWindowChanged } = await import('../../services/serviceImpact/sync.js')
const { runEventPipeline, reevaluateSuppressedEvents, reevaluateClosedWindows, reevaluatePendingEvents, reevaluateFlappingEvents, refreshEventGauges } = await import('../../services/eventCorrelation.js')
const { endCooledStorms } = await import('../../services/eventStorm.js')
const metrics = await import('../../middleware/metrics.js')

const job = (name: string, data: Record<string, unknown> = {}) => ({ name, data, id: 'j1', attemptsMade: 0 } as unknown as Job)
const NOW = '2026-09-09T10:00:00.000Z'

beforeEach(() => {
  vi.clearAllMocks()
  processors.clear()
  poolOpts.clear()
  removeScheduler.mockResolvedValue(false)
  queueGetJob.mockResolvedValue(null)
  vi.mocked(reevaluateClosedWindows).mockResolvedValue({ evaluated: 2, failed: 0, truncated: false })
  vi.mocked(reevaluatePendingEvents).mockResolvedValue({ evaluated: 1, failed: 0, truncated: false })
  vi.mocked(reevaluateFlappingEvents).mockResolvedValue({ evaluated: 1, stabilized: 1, failed: 0, truncated: false })
  vi.mocked(endCooledStorms).mockResolvedValue({ evaluated: 1, active: 0, ended: 1, failed: 0, truncated: false })
})

describe('enqueueCorrelation', () => {
  it('accoda `correlate` con job id deterministico e ritardo fino alla scadenza, tentativi con backoff', async () => {
    vi.useFakeTimers({ now: Date.parse(NOW) })
    try {
      await enqueueCorrelation('t1', 'ev-1', '2026-09-09T10:00:30.000Z')
    } finally { vi.useRealTimers() }
    expect(getTenantQueue).toHaveBeenCalledWith(EVENT_CORRELATE_QUEUE, 't1')
    expect(queueAdd).toHaveBeenCalledWith('correlate', { tenantId: 't1', eventId: 'ev-1', dueAt: '2026-09-09T10:00:30.000Z' }, expect.objectContaining({
      jobId: `corr-t1-ev-1-${Date.parse('2026-09-09T10:00:30.000Z')}`, delay: 30_000, attempts: 3, backoff: { type: 'exponential', delay: 5_000 },
    }))
  })

  // Revisione 2 · B2-02: BullMQ ignora un `add` con un id già presente, anche
  // se quel job è `failed` (li tiene 7 giorni): la ripetizione dell'allarme
  // riusa la stessa scadenza, quindi lo stesso id, e l'evento restava `delayed`
  // per sempre. Un job fallito si rimette in coda con retry().
  it('job già presente e FALLITO → retry() invece di un add ignorato in silenzio; già presente e non fallito → nessun retry, add come sempre (BullMQ deduplica)', async () => {
    const failed = { isFailed: vi.fn().mockResolvedValue(true), retry: vi.fn().mockResolvedValue(undefined), attemptsMade: 3 }
    queueGetJob.mockResolvedValueOnce(failed)
    await enqueueCorrelation('t1', 'ev-1', '2026-09-09T10:00:30.000Z')
    expect(queueGetJob).toHaveBeenCalledWith(`corr-t1-ev-1-${Date.parse('2026-09-09T10:00:30.000Z')}`)
    expect(failed.retry).toHaveBeenCalledTimes(1)
    expect(queueAdd).not.toHaveBeenCalled()

    const running = { isFailed: vi.fn().mockResolvedValue(false), retry: vi.fn() }
    queueGetJob.mockResolvedValueOnce(running)
    await enqueueCorrelation('t1', 'ev-1', '2026-09-09T10:00:30.000Z')
    expect(running.retry).not.toHaveBeenCalled()
    expect(queueAdd).toHaveBeenCalledTimes(1)
  })

  it('scadenza già passata → ritardo 0 (mai negativo); scadenza non ISO → errore senza accodare', async () => {
    await enqueueCorrelation('t1', 'ev-1', '2000-01-01T00:00:00.000Z')
    expect(vi.mocked(queueAdd).mock.calls[0]![2]).toMatchObject({ delay: 0 })
    expect(() => correlationJobId('t1', 'ev-1', 'domani')).toThrow(/dueAt is not an ISO date/)
    await expect(enqueueCorrelation('t1', 'ev-1', 'domani')).rejects.toThrow(/not an ISO date/)
    expect(queueAdd).toHaveBeenCalledTimes(1)
  })
})

describe('enqueueChangeWindowReevaluation (fine finestra come job)', () => {
  it('accoda `reevaluate-change-window` sulla coda events-correlate con id win-<tenant>-<change>-<epoca> (senza ":"), tentativi con backoff; epoca non valida → errore', async () => {
    await enqueueChangeWindowReevaluation('t1', 'chg-1', 1_757_412_000_000)
    expect(getTenantQueue).toHaveBeenCalledWith(EVENT_CORRELATE_QUEUE, 't1')
    expect(queueAdd).toHaveBeenCalledWith(CHANGE_WINDOW_JOB, { tenantId: 't1', changeId: 'chg-1', stepEpoch: 1_757_412_000_000 }, expect.objectContaining({
      jobId: 'win-t1-chg-1-1757412000000', attempts: 3, backoff: { type: 'exponential', delay: 5_000 },
    }))
    expect(changeWindowJobId('t1', 'chg-1', 5)).not.toContain(':')
    expect(() => changeWindowJobId('t1', 'chg-1', -1)).toThrow(/stepEpoch/)
    expect(() => changeWindowJobId('t1', 'chg-1', 1.5)).toThrow(/stepEpoch/)
  })

  it('coda non disponibile → l\'errore propaga al chiamante (nessun try/catch)', async () => {
    queueAdd.mockRejectedValueOnce(new Error('Redis down'))
    await expect(enqueueChangeWindowReevaluation('t1', 'chg-1', 1)).rejects.toThrow('Redis down')
  })
})

describe('worker events-correlate', () => {
  it('startEventCorrelateWorker: un worker per tenant (concurrency 2), senza job ripetuti', () => {
    const w = startEventCorrelateWorker()
    expect(w.name).toBe(EVENT_CORRELATE_QUEUE)
    expect(queueAdd).not.toHaveBeenCalled()
    expect(createTenantWorkers).toHaveBeenCalledWith(EVENT_CORRELATE_QUEUE, expect.any(Function), expect.objectContaining({ concurrency: 2 }))
    expect(poolOpts.get(EVENT_CORRELATE_QUEUE)!.schedule).toBeUndefined()
  })

  it('`correlate` → pipeline in modalità resume per (tenant, evento) con il job id nei log; ritardo dalla scadenza misurato (mai negativo); un errore della pipeline fa fallire il job', async () => {
    await startEventCorrelateWorker()
    const proc = processors.get(EVENT_CORRELATE_QUEUE)!
    await proc(job('correlate', { tenantId: 't1', eventId: 'ev-1', dueAt: '2026-09-09T10:00:30.000Z' }))
    expect(runEventPipeline).toHaveBeenCalledWith({ tenantId: 't1', eventId: 'ev-1', mode: 'resume', jobId: 'j1' })
    const lag = vi.mocked(metrics.eventCorrelateJobLagSeconds.observe).mock.calls[0]!
    expect(lag[0]).toEqual({})
    expect(lag[1]).toBeGreaterThan(0)   // la scadenza è nel passato
    vi.mocked(metrics.eventCorrelateJobLagSeconds.observe).mockClear()
    await proc(job('correlate', { tenantId: 't1', eventId: 'ev-1', dueAt: new Date(Date.now() + 60_000).toISOString() }))
    expect(vi.mocked(metrics.eventCorrelateJobLagSeconds.observe).mock.calls[0]![1]).toBe(0)
    vi.mocked(runEventPipeline).mockRejectedValueOnce(new Error('Event ev-1 not found'))
    await expect(proc(job('correlate', { tenantId: 't1', eventId: 'ev-1', dueAt: '2026-09-09T10:00:30.000Z' }))).rejects.toThrow(/not found/)
  })

  it('`reevaluate-change-window` → reevaluateSuppressedEvents(tenant, change); un fallimento fa fallire il job (ritenta); job sconosciuto → errore', async () => {
    await startEventCorrelateWorker()
    const proc = processors.get(EVENT_CORRELATE_QUEUE)!
    await proc(job(CHANGE_WINDOW_JOB, { tenantId: 't1', changeId: 'chg-1', stepEpoch: 1 }))
    expect(reevaluateSuppressedEvents).toHaveBeenCalledWith('t1', 'chg-1')
    // …e le mappe dei servizi che includono i CI della change vengono rivalutate
    expect(notifyChangeWindowChanged).toHaveBeenCalledWith('t1', 'chg-1', 'change.window_reevaluated')
    // il segnale non lancia mai: un suo fallimento non farebbe fallire il job
    vi.mocked(notifyChangeWindowChanged).mockResolvedValueOnce(0)
    await proc(job(CHANGE_WINDOW_JOB, { tenantId: 't1', changeId: 'chg-1', stepEpoch: 1 }))
    vi.mocked(reevaluateSuppressedEvents).mockRejectedValueOnce(new Error('1/3 events suppressed by change chg-1 failed'))
    await expect(proc(job(CHANGE_WINDOW_JOB, { tenantId: 't1', changeId: 'chg-1', stepEpoch: 1 }))).rejects.toThrow(/1\/3 events/)
    await expect(proc(job('nope'))).rejects.toThrow(/\[events-correlate\] unknown job "nope"/)
    await expect(proc(job('reevaluate-windows'))).rejects.toThrow(/unknown job "reevaluate-windows"/)
  })
})

describe('worker events-maintenance (periodico)', () => {
  it('startEventMaintenanceWorker: un worker per tenant con concurrency 1 e lockDuration 10 min; ogni tenant ha la sua ricorrenza ogni 5 minuti, nella sua coda, che porta il tenant', async () => {
    const w = startEventMaintenanceWorker()
    expect(w.name).toBe(EVENT_MAINTENANCE_QUEUE)
    expect(EVENT_MAINTENANCE_EVERY_MS).toBe(5 * 60 * 1000)
    expect(EVENT_MAINTENANCE_LOCK_MS).toBe(10 * 60 * 1000)
    expect(createTenantWorkers).toHaveBeenCalledWith(EVENT_MAINTENANCE_QUEUE, expect.any(Function), expect.objectContaining({ concurrency: 1, lockDuration: EVENT_MAINTENANCE_LOCK_MS }))
    await poolOpts.get(EVENT_MAINTENANCE_QUEUE)!.schedule!(fakeQueue, 't1')
    expect(upsertScheduler).toHaveBeenCalledWith(EVENT_MAINTENANCE_JOB, { every: EVENT_MAINTENANCE_EVERY_MS }, expect.objectContaining({ name: EVENT_MAINTENANCE_JOB, data: { tenantId: 't1' } }))
  })

  it('`events-maintenance` → finestre chiuse + pending + sfarfallio + tempeste raffreddate del TENANT del job + gauge, con lo stesso istante, ogni passata contata ok e misurata; job sconosciuto → errore', async () => {
    startEventMaintenanceWorker()
    const proc = processors.get(EVENT_MAINTENANCE_QUEUE)!
    await proc(job(EVENT_MAINTENANCE_JOB, { tenantId: 't1' }))
    expect(reevaluateClosedWindows).toHaveBeenCalledTimes(1)
    expect(reevaluatePendingEvents).toHaveBeenCalledTimes(1)
    expect(reevaluateFlappingEvents).toHaveBeenCalledTimes(1)
    expect(endCooledStorms).toHaveBeenCalledTimes(1)
    expect(refreshEventGauges).toHaveBeenCalledTimes(1)
    const [tenant, now] = vi.mocked(reevaluateClosedWindows).mock.calls[0]!
    expect(tenant).toBe('t1')
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(vi.mocked(reevaluatePendingEvents).mock.calls[0]).toEqual(['t1', now])
    expect(vi.mocked(reevaluateFlappingEvents).mock.calls[0]).toEqual(['t1', now])
    expect(vi.mocked(endCooledStorms).mock.calls[0]).toEqual(['t1', now])
    expect(vi.mocked(refreshEventGauges).mock.calls[0]![0]).toBe(now)
    expect(vi.mocked(metrics.eventPassTotal.inc).mock.calls.map((c) => c[0])).toEqual(
      ['closed_windows', 'pending', 'flapping', 'storms', 'gauges'].map((pass) => ({ pass, result: 'ok' })))
    expect(vi.mocked(metrics.eventPassDurationSeconds.observe).mock.calls.map((c) => c[0])).toEqual(
      ['closed_windows', 'pending', 'flapping', 'storms', 'gauges'].map((pass) => ({ pass })))
    await expect(proc(job('nope'))).rejects.toThrow(/\[events-maintenance\] unknown job "nope"/)
  })

  it('una passata fallita non ferma le altre (contata failed, durata comunque misurata), ma il job fallisce con tutti i motivi', async () => {
    vi.mocked(reevaluateClosedWindows).mockRejectedValueOnce(new Error('1/3 suppressed events failed'))
    vi.mocked(reevaluatePendingEvents).mockRejectedValueOnce(new Error('2/2 pending events failed'))
    vi.mocked(endCooledStorms).mockRejectedValueOnce(new Error('redis down'))
    await expect(runPeriodicPasses('t1', NOW)).rejects.toThrow(/closed_windows: 1\/3 suppressed events failed; pending: 2\/2 pending events failed; storms: redis down/)
    expect(reevaluateFlappingEvents).toHaveBeenCalledWith('t1', NOW)
    expect(endCooledStorms).toHaveBeenCalledWith('t1', NOW)
    expect(refreshEventGauges).toHaveBeenCalledWith(NOW)
    expect(vi.mocked(metrics.eventPassTotal.inc).mock.calls.map((c) => c[0])).toEqual([
      { pass: 'closed_windows', result: 'failed' }, { pass: 'pending', result: 'failed' }, { pass: 'flapping', result: 'ok' }, { pass: 'storms', result: 'failed' }, { pass: 'gauges', result: 'ok' },
    ])
    expect(metrics.eventPassDurationSeconds.observe).toHaveBeenCalledTimes(5)
  })

  it('le passate fallite per la stessa causa (database irraggiungibile) sono elencate insieme una volta sola', async () => {
    // Il testo del driver Neo4j è lungo 200 caratteri: ripetuto per ciascuna
    // delle cinque passate rendeva illeggibile il motivo nella pagina delle code.
    const giu = () => new Error('Failed to connect to server. Caused by: connect ECONNREFUSED 172.19.0.15:7687')
    vi.mocked(reevaluateClosedWindows).mockRejectedValueOnce(giu())
    vi.mocked(reevaluatePendingEvents).mockRejectedValueOnce(giu())
    vi.mocked(reevaluateFlappingEvents).mockRejectedValueOnce(giu())
    vi.mocked(endCooledStorms).mockRejectedValueOnce(giu())
    vi.mocked(refreshEventGauges).mockRejectedValueOnce(giu())
    const err = await runPeriodicPasses('t1', NOW).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    const message = (err as Error).message
    expect(message).toBe('[events-maintenance] events-maintenance: closed_windows, pending, flapping, storms, gauges: Failed to connect to server. Caused by: connect ECONNREFUSED 172.19.0.15:7687')
    expect(message.match(/ECONNREFUSED/g)).toHaveLength(1)
    // Tutte e cinque restano contate come fallite: accorpiamo il testo, non le misure.
    expect(vi.mocked(metrics.eventPassTotal.inc).mock.calls.map((c) => c[0])).toEqual(
      ['closed_windows', 'pending', 'flapping', 'storms', 'gauges'].map((pass) => ({ pass, result: 'failed' })))
  })

  it('cause diverse restano separate: il dato di una passata non si confonde col database giù', async () => {
    vi.mocked(reevaluateClosedWindows).mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    vi.mocked(reevaluatePendingEvents).mockRejectedValueOnce(new Error('2/2 pending events failed'))
    vi.mocked(refreshEventGauges).mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    await expect(runPeriodicPasses('t1', NOW)).rejects.toThrow(
      'closed_windows, gauges: connect ECONNREFUSED; pending: 2/2 pending events failed')
  })
})
