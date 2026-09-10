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
 *    cumulativo alla fine; il job `correlate` misura il ritardo dalla scadenza.
 * BullMQ è mockato attraverso lib/bullmq.ts; i processori sono catturati da createWorker.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

type AnyProcessor = (job: Job) => Promise<unknown>
const processors = new Map<string, AnyProcessor>()
const queueAdd = vi.fn().mockResolvedValue(undefined)
const removeRepeatable = vi.fn().mockResolvedValue(false)

vi.mock('../../lib/bullmq.js', () => ({
  createWorker: vi.fn((name: string, processor: AnyProcessor, opts?: unknown) => {
    processors.set(name, processor)
    return { name, opts, on: vi.fn(), close: vi.fn() }
  }),
  getQueue: vi.fn(() => ({ add: queueAdd, removeRepeatable })),
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
  EVENT_CORRELATE_QUEUE, EVENT_MAINTENANCE_QUEUE, CHANGE_WINDOW_JOB, EVENT_MAINTENANCE_JOB, EVENT_MAINTENANCE_EVERY_MS, EVENT_MAINTENANCE_LOCK_MS, LEGACY_REEVALUATE_WINDOWS_JOB,
} = worker
const { createWorker, getQueue } = await import('../../lib/bullmq.js')
const { notifyChangeWindowChanged } = await import('../../services/serviceImpact/sync.js')
const { runEventPipeline, reevaluateSuppressedEvents, reevaluateClosedWindows, reevaluatePendingEvents, reevaluateFlappingEvents, refreshEventGauges } = await import('../../services/eventCorrelation.js')
const { endCooledStorms } = await import('../../services/eventStorm.js')
const metrics = await import('../../middleware/metrics.js')

const job = (name: string, data: Record<string, unknown> = {}) => ({ name, data, id: 'j1', attemptsMade: 0 } as unknown as Job)
const NOW = '2026-09-09T10:00:00.000Z'

beforeEach(() => {
  vi.clearAllMocks()
  processors.clear()
  removeRepeatable.mockResolvedValue(false)
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
    expect(getQueue).toHaveBeenCalledWith(EVENT_CORRELATE_QUEUE)
    expect(queueAdd).toHaveBeenCalledWith('correlate', { tenantId: 't1', eventId: 'ev-1', dueAt: '2026-09-09T10:00:30.000Z' }, expect.objectContaining({
      jobId: `corr-t1-ev-1-${Date.parse('2026-09-09T10:00:30.000Z')}`, delay: 30_000, attempts: 3, backoff: { type: 'exponential', delay: 5_000 },
    }))
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
    expect(getQueue).toHaveBeenCalledWith(EVENT_CORRELATE_QUEUE)
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
  it('startEventCorrelateWorker: rimuove il repeat job legacy `reevaluate-windows` e avvia il worker (concurrency 2) senza registrare job ripetuti', async () => {
    removeRepeatable.mockResolvedValueOnce(true)
    const w = await startEventCorrelateWorker()
    expect(w.name).toBe(EVENT_CORRELATE_QUEUE)
    expect(removeRepeatable).toHaveBeenCalledWith(LEGACY_REEVALUATE_WINDOWS_JOB, { every: EVENT_MAINTENANCE_EVERY_MS }, LEGACY_REEVALUATE_WINDOWS_JOB)
    expect(queueAdd).not.toHaveBeenCalled()
    expect(createWorker).toHaveBeenCalledWith(EVENT_CORRELATE_QUEUE, expect.any(Function), expect.objectContaining({ concurrency: 2 }))
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
    await expect(proc(job(LEGACY_REEVALUATE_WINDOWS_JOB))).rejects.toThrow(/unknown job "reevaluate-windows"/)
  })
})

describe('worker events-maintenance (periodico)', () => {
  it('startEventMaintenanceWorker: registra il repeat job ogni 5 minuti sulla coda dedicata e avvia il worker con concurrency 1 e lockDuration 10 min', async () => {
    const w = await startEventMaintenanceWorker()
    expect(w.name).toBe(EVENT_MAINTENANCE_QUEUE)
    expect(getQueue).toHaveBeenCalledWith(EVENT_MAINTENANCE_QUEUE)
    expect(queueAdd).toHaveBeenCalledWith(EVENT_MAINTENANCE_JOB, {}, expect.objectContaining({ repeat: { every: EVENT_MAINTENANCE_EVERY_MS }, jobId: EVENT_MAINTENANCE_JOB, removeOnComplete: { count: 20 } }))
    expect(EVENT_MAINTENANCE_EVERY_MS).toBe(5 * 60 * 1000)
    expect(EVENT_MAINTENANCE_LOCK_MS).toBe(10 * 60 * 1000)
    expect(createWorker).toHaveBeenCalledWith(EVENT_MAINTENANCE_QUEUE, expect.any(Function), expect.objectContaining({ concurrency: 1, lockDuration: EVENT_MAINTENANCE_LOCK_MS }))
  })

  it('`events-maintenance` → finestre chiuse + pending + sfarfallio + tempeste raffreddate + gauge, con lo stesso istante, ogni passata contata ok e misurata; job sconosciuto → errore', async () => {
    await startEventMaintenanceWorker()
    const proc = processors.get(EVENT_MAINTENANCE_QUEUE)!
    await proc(job(EVENT_MAINTENANCE_JOB))
    expect(reevaluateClosedWindows).toHaveBeenCalledTimes(1)
    expect(reevaluatePendingEvents).toHaveBeenCalledTimes(1)
    expect(reevaluateFlappingEvents).toHaveBeenCalledTimes(1)
    expect(endCooledStorms).toHaveBeenCalledTimes(1)
    expect(refreshEventGauges).toHaveBeenCalledTimes(1)
    const now = vi.mocked(reevaluateClosedWindows).mock.calls[0]![0]
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(vi.mocked(reevaluatePendingEvents).mock.calls[0]![0]).toBe(now)
    expect(vi.mocked(reevaluateFlappingEvents).mock.calls[0]![0]).toBe(now)
    expect(vi.mocked(endCooledStorms).mock.calls[0]![0]).toBe(now)
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
    await expect(runPeriodicPasses(NOW)).rejects.toThrow(/closed_windows: 1\/3 suppressed events failed; pending: 2\/2 pending events failed; storms: redis down/)
    expect(reevaluateFlappingEvents).toHaveBeenCalledWith(NOW)
    expect(endCooledStorms).toHaveBeenCalledWith(NOW)
    expect(refreshEventGauges).toHaveBeenCalledWith(NOW)
    expect(vi.mocked(metrics.eventPassTotal.inc).mock.calls.map((c) => c[0])).toEqual([
      { pass: 'closed_windows', result: 'failed' }, { pass: 'pending', result: 'failed' }, { pass: 'flapping', result: 'ok' }, { pass: 'storms', result: 'failed' }, { pass: 'gauges', result: 'ok' },
    ])
    expect(metrics.eventPassDurationSeconds.observe).toHaveBeenCalledTimes(5)
  })
})
