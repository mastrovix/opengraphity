/**
 * events-ingest (jobs/eventIngestWorker.ts):
 *  - eventJobId: `ev-<tenant>-<impronta>-<receivedAtMs>`, mai `:`; errore su receivedAt non ISO;
 *  - enqueueEvents: addBulk con 5 tentativi e backoff esponenziale da 10 s,
 *    job id deterministico; lista vuota → 0; errore di coda che propaga;
 *  - processore: ingestEvent con i dati del job; azzera `last_error` della
 *    sorgente SOLO quando l'ingest dice che ne porta uno;
 *  - onFailed all'ultimo tentativo → last_error/last_error_at/error_count sulla
 *    sorgente (scoped per tenant) con impronta e messaggio, metrica
 *    events_ingest_failed_total{connector}; ai tentativi intermedi non scrive;
 *    scrittura fallita → solo log.
 * BullMQ è mockato attraverso lib/bullmq.ts; il processore e onFailed sono catturati da createWorker.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

type AnyProcessor = (job: Job) => Promise<unknown>
interface Captured { processor: AnyProcessor; opts: { concurrency?: number; onFailed?: (job: Job | undefined, err: Error) => void } }
const captured: Captured[] = []
const addBulk = vi.fn().mockResolvedValue(undefined)

vi.mock('../../lib/bullmq.js', () => ({
  createWorker: vi.fn((name: string, processor: AnyProcessor, opts: Captured['opts']) => {
    captured.push({ processor, opts })
    return { name, opts, on: vi.fn(), close: vi.fn() }
  }),
  getQueue: vi.fn(() => ({ addBulk })),
}))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../middleware/metrics.js', () => ({ eventsIngestFailedTotal: { inc: vi.fn() } }))
vi.mock('../../services/eventService.js', () => ({
  ingestEvent: vi.fn(),
  fingerprintOf: (sourceId: string, ev: { title: string }) => `fp-${sourceId}-${ev.title}`,
}))

const worker = await import('../eventIngestWorker.js')
const { eventJobId, enqueueEvents, startEventIngestWorker, recordIngestFailure, EVENT_INGEST_QUEUE, EVENT_INGEST_ATTEMPTS, EVENT_INGEST_BACKOFF_MS } = worker
const { createWorker, getQueue } = await import('../../lib/bullmq.js')
const { getSession, runQueryOne } = await import('@opengraphity/neo4j')
const { ingestEvent } = await import('../../services/eventService.js')
const { eventsIngestFailedTotal } = await import('../../middleware/metrics.js')
const { logger } = await import('../../lib/logger.js')

const session = { close: vi.fn().mockResolvedValue(undefined) }
const EV = { status: 'firing', severity: 'critical', title: 'DiskFull', resource: 'db-01', resourceKind: 'hostname', labels: {} } as const
const DATA = { tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: '2026-09-09T10:00:00.000Z' }
const job = (over: Partial<Job> = {}) => ({ id: 'j1', name: 'ingest', data: DATA, attemptsMade: 1, opts: { attempts: EVENT_INGEST_ATTEMPTS }, ...over } as unknown as Job)
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const ingestResult = (over: Record<string, unknown> = {}) => ({ props: { id: 'ev-1' }, ciId: null, created: true, outcome: 'created', sourceHasError: false, ...over })

beforeEach(() => {
  vi.clearAllMocks()
  captured.length = 0
  vi.mocked(getSession).mockReturnValue(session as never)
  vi.mocked(runQueryOne).mockResolvedValue(null as never)
  vi.mocked(ingestEvent).mockResolvedValue(ingestResult() as never)
})

describe('eventJobId / enqueueEvents', () => {
  it('job id deterministico ev-<tenant>-<impronta>-<ms>, senza `:`; receivedAt non ISO → errore', () => {
    expect(eventJobId('t1', 'abc', '2026-09-09T10:00:00.000Z')).toBe(`ev-t1-abc-${Date.parse('2026-09-09T10:00:00.000Z')}`)
    expect(eventJobId('t1', 'abc', '2026-09-09T10:00:00.000Z')).not.toContain(':')
    expect(() => eventJobId('t1', 'abc', 'adesso')).toThrow(/receivedAt is not an ISO date: adesso/)
  })

  it('accoda in blocco con 5 tentativi e backoff esponenziale da 10 s (≈ 2,5 min), removeOnComplete/removeOnFail; stessa receivedAt per tutti i job della richiesta', async () => {
    expect(EVENT_INGEST_ATTEMPTS).toBe(5)
    expect(EVENT_INGEST_BACKOFF_MS).toBe(10_000)
    const n = await enqueueEvents('t1', 'hook-1', [EV, { ...EV, title: 'HighLoad' }], DATA.receivedAt)
    expect(n).toBe(2)
    expect(getQueue).toHaveBeenCalledWith(EVENT_INGEST_QUEUE)
    const jobs = vi.mocked(addBulk).mock.calls[0]![0] as Array<{ name: string; data: unknown; opts: Record<string, unknown> }>
    expect(jobs).toHaveLength(2)
    expect(jobs[0]).toEqual({
      name: 'ingest',
      data: DATA,
      opts: {
        jobId: `ev-t1-fp-hook-1-DiskFull-${Date.parse(DATA.receivedAt)}`,
        attempts: 5, backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 3600, count: 10_000 }, removeOnFail: { age: 7 * 24 * 3600 },
      },
    })
    expect(jobs[1]!.opts['jobId']).toBe(`ev-t1-fp-hook-1-HighLoad-${Date.parse(DATA.receivedAt)}`)
  })

  it('lista vuota → 0 senza toccare la coda; coda che fallisce → l\'errore propaga (il webhook risponde 500)', async () => {
    await expect(enqueueEvents('t1', 'hook-1', [])).resolves.toBe(0)
    expect(addBulk).not.toHaveBeenCalled()
    vi.mocked(addBulk).mockRejectedValueOnce(new Error('redis down'))
    await expect(enqueueEvents('t1', 'hook-1', [EV])).rejects.toThrow(/redis down/)
  })
})

describe('processore', () => {
  it('startEventIngestWorker: worker sulla coda con concurrency 4 e onFailed', () => {
    const w = startEventIngestWorker()
    expect(w.name).toBe(EVENT_INGEST_QUEUE)
    expect(createWorker).toHaveBeenCalledWith(EVENT_INGEST_QUEUE, expect.any(Function), expect.objectContaining({ concurrency: 4, onFailed: expect.any(Function) }))
  })

  it('`ingest` → ingestEvent con tenant, sorgente, evento e receivedAt del job; senza last_error sulla sorgente nessuna scrittura', async () => {
    startEventIngestWorker()
    await captured[0]!.processor(job())
    expect(ingestEvent).toHaveBeenCalledWith({ tenantId: 't1', sourceId: 'hook-1', ev: EV, receivedAt: DATA.receivedAt, jobId: 'j1' })
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('A4 — job riuscito su una sorgente con last_error → azzera SOLO gli errori scritti dal worker (prefisso `ingest: `), non gli scarti del webhook (batch parziale)', async () => {
    vi.mocked(ingestEvent).mockResolvedValue(ingestResult({ sourceHasError: true }) as never)
    startEventIngestWorker()
    await captured[0]!.processor(job())
    expect(runQueryOne).toHaveBeenCalledTimes(1)
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toContain('MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})')
    expect(cypher).toContain('WHERE w.last_error STARTS WITH $prefix')
    expect(cypher).toContain('SET w.last_error = null')
    expect(cypher).not.toMatch(/error_count/)
    expect(params).toEqual({ tenantId: 't1', sourceId: 'hook-1', prefix: 'ingest: ' })
    expect(session.close).toHaveBeenCalled()
  })

  it('ingestEvent che fallisce → il job fallisce (BullMQ ritenta)', async () => {
    vi.mocked(ingestEvent).mockRejectedValueOnce(new Error('Tenant t1 has no event_policy'))
    startEventIngestWorker()
    await expect(captured[0]!.processor(job())).rejects.toThrow(/no event_policy/)
    expect(runQueryOne).not.toHaveBeenCalled()
  })
})

describe('onFailed — errori visibili sulla sorgente (A4)', () => {
  it('ultimo tentativo (attemptsMade = attempts) → last_error con messaggio e impronta, last_error_at, error_count+1, scoped per tenant; metrica {connector}', async () => {
    vi.mocked(runQueryOne).mockResolvedValue({ connectorKind: 'zabbix' } as never)
    startEventIngestWorker()
    captured[0]!.opts.onFailed!(job({ attemptsMade: 5 }), new Error('neo4j down'))
    await flush()
    expect(runQueryOne).toHaveBeenCalledTimes(1)
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toContain('MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})')
    expect(cypher).toMatch(/SET w\.last_error = \$message,\s+w\.last_error_at = \$now,\s+w\.error_count = coalesce\(w\.error_count, 0\) \+ 1/)
    expect(params).toMatchObject({ sourceId: 'hook-1', tenantId: 't1', message: 'ingest: neo4j down (impronta fp-hook-1-DiskFull, firing DiskFull su db-01)' })
    expect(Number.isNaN(Date.parse((params as Record<string, string>)['now']!))).toBe(false)
    expect(eventsIngestFailedTotal.inc).toHaveBeenCalledWith({ connector: 'zabbix' })
    expect(session.close).toHaveBeenCalled()
  })

  it('tentativo intermedio → solo log, nessuna scrittura; job senza dati → nessuna scrittura', async () => {
    startEventIngestWorker()
    captured[0]!.opts.onFailed!(job({ attemptsMade: 2 }), new Error('boom'))
    captured[0]!.opts.onFailed!(undefined, new Error('boom'))
    await flush()
    expect(runQueryOne).not.toHaveBeenCalled()
    const log = logger.child({} as never)
    expect(vi.mocked(log.error).mock.calls[0]![0]).toMatchObject({ jobId: 'j1', tenantId: 't1', sourceId: 'hook-1', attemptsMade: 2, attempts: 5, exhausted: false, err: 'boom' })
  })

  it('opts.attempts assente → vale 1: il primo fallimento è l\'ultimo; messaggio troncato a 2000; scrittura fallita → log error, nessuna eccezione, sorgente senza connettore → metrica generic', async () => {
    startEventIngestWorker()
    captured[0]!.opts.onFailed!(job({ attemptsMade: 1, opts: {} } as never), new Error('x'.repeat(3000)))
    await flush()
    expect(runQueryOne).toHaveBeenCalledTimes(1)
    expect(((vi.mocked(runQueryOne).mock.calls[0]![2] as Record<string, string>)['message']!).length).toBe(2000)
    expect(eventsIngestFailedTotal.inc).toHaveBeenCalledWith({ connector: 'generic' })

    vi.mocked(runQueryOne).mockRejectedValueOnce(new Error('neo4j down again'))
    await expect(recordIngestFailure(DATA, new Error('boom'))).resolves.toBeUndefined()
    const log = logger.child({} as never)
    expect(vi.mocked(log.error).mock.calls.some(([ctx, msg]) => /Could not record event ingest failure/.test(String(msg)) && (ctx as Record<string, unknown>)['fingerprint'] === 'fp-hook-1-DiskFull')).toBe(true)
    expect(session.close).toHaveBeenCalledTimes(2)
  })
})
