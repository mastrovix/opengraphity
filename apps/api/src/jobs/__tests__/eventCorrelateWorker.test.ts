/**
 * events-correlate (jobs/eventCorrelateWorker.ts):
 *  - enqueueCorrelation: job id deterministico corr-<tenant>-<evento>-<dueMs>,
 *    ritardo = scadenza − ora (mai negativo), errore su scadenza non ISO;
 *  - `correlate` → runEventPipeline in modalità resume;
 *  - `reevaluate-windows` → tre passate (finestre chiuse, sfarfallio,
 *    tempeste raffreddate), ciascuna eseguita anche se un'altra fallisce, con
 *    errore cumulativo alla fine; job sconosciuto → errore;
 *  - startEventCorrelateWorker registra il job ripetuto ogni 5 minuti.
 * BullMQ è mockato attraverso lib/bullmq.ts; il processore è catturato da createWorker.
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
vi.mock('../../services/eventCorrelation.js', () => ({
  runEventPipeline: vi.fn().mockResolvedValue({ outcome: 'opened', status: 'firing', suppressedByChangeId: null, incidentId: 'inc-1' }),
  reevaluateClosedWindows: vi.fn(),
  reevaluateFlappingEvents: vi.fn(),
}))
vi.mock('../../services/eventStorm.js', () => ({ endCooledStorms: vi.fn() }))

const worker = await import('../eventCorrelateWorker.js')
const { enqueueCorrelation, correlationJobId, startEventCorrelateWorker, EVENT_CORRELATE_QUEUE, REEVALUATE_WINDOWS_JOB, REEVALUATE_WINDOWS_EVERY_MS } = worker
const { createWorker, getQueue } = await import('../../lib/bullmq.js')
const { runEventPipeline, reevaluateClosedWindows, reevaluateFlappingEvents } = await import('../../services/eventCorrelation.js')
const { endCooledStorms } = await import('../../services/eventStorm.js')

const job = (name: string, data: Record<string, unknown> = {}) => ({ name, data, id: 'j1', attemptsMade: 0 } as unknown as Job)

beforeEach(() => {
  vi.clearAllMocks()
  processors.clear()
  vi.mocked(reevaluateClosedWindows).mockResolvedValue({ evaluated: 2, failed: 0 })
  vi.mocked(reevaluateFlappingEvents).mockResolvedValue({ evaluated: 1, stabilized: 1, failed: 0 })
  vi.mocked(endCooledStorms).mockResolvedValue({ active: 0, ended: 1, failed: 0 })
})

describe('enqueueCorrelation', () => {
  it('accoda `correlate` con job id deterministico e ritardo fino alla scadenza, tentativi con backoff', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-09-09T10:00:00.000Z') })
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

describe('processore', () => {
  it('startEventCorrelateWorker: registra il job ripetuto ogni 5 minuti e avvia il worker sulla coda', async () => {
    const w = await startEventCorrelateWorker()
    expect(w.name).toBe(EVENT_CORRELATE_QUEUE)
    expect(queueAdd).toHaveBeenCalledWith(REEVALUATE_WINDOWS_JOB, {}, expect.objectContaining({ repeat: { every: REEVALUATE_WINDOWS_EVERY_MS }, jobId: REEVALUATE_WINDOWS_JOB }))
    expect(REEVALUATE_WINDOWS_EVERY_MS).toBe(5 * 60 * 1000)
    expect(createWorker).toHaveBeenCalledWith(EVENT_CORRELATE_QUEUE, expect.any(Function), expect.objectContaining({ concurrency: 2 }))
  })

  it('`correlate` → pipeline in modalità resume per (tenant, evento); un errore della pipeline fa fallire il job', async () => {
    await startEventCorrelateWorker()
    const proc = processors.get(EVENT_CORRELATE_QUEUE)!
    await proc(job('correlate', { tenantId: 't1', eventId: 'ev-1', dueAt: '2026-09-09T10:00:30.000Z' }))
    expect(runEventPipeline).toHaveBeenCalledWith({ tenantId: 't1', eventId: 'ev-1', mode: 'resume' })
    vi.mocked(runEventPipeline).mockRejectedValueOnce(new Error('Event ev-1 not found'))
    await expect(proc(job('correlate', { tenantId: 't1', eventId: 'ev-1', dueAt: '2026-09-09T10:00:30.000Z' }))).rejects.toThrow(/not found/)
  })

  it('`reevaluate-windows` → finestre chiuse + sfarfallio + tempeste raffreddate; job sconosciuto → errore', async () => {
    await startEventCorrelateWorker()
    const proc = processors.get(EVENT_CORRELATE_QUEUE)!
    await proc(job(REEVALUATE_WINDOWS_JOB))
    expect(reevaluateClosedWindows).toHaveBeenCalledTimes(1)
    expect(reevaluateFlappingEvents).toHaveBeenCalledTimes(1)
    expect(endCooledStorms).toHaveBeenCalledTimes(1)
    await expect(proc(job('nope'))).rejects.toThrow(/unknown job "nope"/)
  })

  it('`reevaluate-windows`: una passata fallita non ferma le altre, ma il job fallisce con tutti i motivi', async () => {
    await startEventCorrelateWorker()
    const proc = processors.get(EVENT_CORRELATE_QUEUE)!
    vi.mocked(reevaluateClosedWindows).mockRejectedValueOnce(new Error('1/3 suppressed events failed'))
    vi.mocked(endCooledStorms).mockRejectedValueOnce(new Error('redis down'))
    await expect(proc(job(REEVALUATE_WINDOWS_JOB))).rejects.toThrow(/closed windows: 1\/3 suppressed events failed; storms: redis down/)
    expect(reevaluateFlappingEvents).toHaveBeenCalledTimes(1)
    expect(endCooledStorms).toHaveBeenCalledTimes(1)
  })
})
