/**
 * A-06 / A-13: every worker gets an 'error' listener (a Redis blip must not
 * crash the process) and queues are per-name singletons closed together.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

class FakeWorker extends EventEmitter {
  constructor(public name: string, public processor: unknown, public opts: Record<string, unknown>) { super() }
  close = vi.fn().mockResolvedValue(undefined)
}
class FakeQueue extends EventEmitter {
  constructor(public name: string, public opts: Record<string, unknown>) { super() }
  close = vi.fn().mockResolvedValue(undefined)
}

// vitest 4: a mock is constructible (`new Worker(...)`) only when its
// implementation is a `function`/class, not an arrow function.
vi.mock('bullmq', () => ({
  Worker: vi.fn(function (name: string, processor: unknown, opts: Record<string, unknown>) { return new FakeWorker(name, processor, opts) }),
  /*
   * `client` c'è anche nel finto: una `Queue` vera lo espone (è il getter di
   * `QueueBase`), ed è da lì che si aggancia la ripresa dopo un guasto
   * (21 set 2026, `PRB00000002`). Un finto senza `client` avrebbe provato un
   * codice diverso da quello che gira.
   */
  Queue:  vi.fn(function (name: string, opts: Record<string, unknown>) {
    const q = new FakeQueue(name, opts)
    Object.defineProperty(q, 'client', { get: () => Promise.resolve(q) })
    return q
  }),
}))

const quit = vi.fn().mockResolvedValue('OK')
vi.mock('ioredis', () => ({
  Redis: vi.fn(function () { return Object.assign(new EventEmitter(), { quit }) }),
}))

const logError = vi.fn()
const logWarn  = vi.fn()
vi.mock('../logger.js', () => ({
  logger: { child: () => ({ error: logError, info: vi.fn(), warn: logWarn }) },
}))

const { createWorker, getQueue, getAllQueues, closeAllQueues, getSharedRedis, getTenantQueue, createTenantWorkers } = await import('../bullmq.js')

describe('createWorker', () => {
  beforeEach(() => vi.clearAllMocks())

  it("registra on('error') e non rilancia: un errore di connessione viene solo loggato", () => {
    const w = createWorker('q1', async () => undefined, { concurrency: 2 }) as unknown as FakeWorker
    expect(w.listenerCount('error')).toBe(1)
    expect(() => w.emit('error', new Error('ECONNRESET'))).not.toThrow()
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ worker: 'q1' }), expect.stringContaining('connection lost'))
  })

  /*
   * LA RIPETIZIONE NON SCRIVE UNA RIGA A TESTA (21 set 2026, `PRB00000002`).
   *
   * Prima qui c'era un `log.error` per ogni tentativo, e ioredis riprova
   * senza sosta: un solo guasto di Redis ha scritto 728 righe sull'api in un
   * giorno, 952 su tre processi. Vedi `lib/dipendenzaGiu.ts`.
   */
  it('cinquanta cadute uguali scrivono UNA riga, e la ripresa dice quante ne ha taciute', () => {
    const w = createWorker('q-flood', async () => undefined) as unknown as FakeWorker
    for (let i = 0; i < 50; i++) w.emit('error', new Error('getaddrinfo ENOTFOUND redis'))
    expect(logError.mock.calls.filter((c) => String(c[1]).includes('connection lost'))).toHaveLength(1)
    w.emit('ready')
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ worker: 'q-flood', taciute: 49 }), expect.stringContaining('back up after'))
  })

  it("registra on('failed') con log strutturato e invoca onFailed", () => {
    const onFailed = vi.fn()
    const w = createWorker('q2', async () => undefined, { onFailed }) as unknown as FakeWorker
    const job = { id: '1', name: 'x', attemptsMade: 2, opts: { attempts: 3 } }
    w.emit('failed', job, new Error('boom'))
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ worker: 'q2', jobId: '1', jobName: 'x', attemptsMade: 2, attempts: 3, err: 'boom' }),
      expect.any(String),
    )
    expect(onFailed).toHaveBeenCalledWith(job, expect.any(Error))
  })

  it('passa la connection Redis e le opzioni al Worker senza onFailed', () => {
    const w = createWorker('q3', async () => undefined, { concurrency: 7, onFailed: vi.fn() }) as unknown as FakeWorker
    expect(w.opts).toEqual(expect.objectContaining({ concurrency: 7, connection: expect.objectContaining({ host: expect.any(String) }) }))
    expect(w.opts).not.toHaveProperty('onFailed')
  })
})

describe('getQueue / closeAllQueues', () => {
  it('è un singleton per nome', () => {
    const a = getQueue('same')
    const b = getQueue('same')
    const c = getQueue('other')
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(getAllQueues()).toEqual(expect.arrayContaining([a, c]))
  })

  it("registra on('error') sulla queue", () => {
    const q = getQueue('with-error') as unknown as FakeQueue
    expect(q.listenerCount('error')).toBe(1)
    expect(() => q.emit('error', new Error('x'))).not.toThrow()
  })

  it('closeAllQueues chiude tutte le queue e il redis condiviso, poi riparte da zero', async () => {
    const q = getQueue('to-close') as unknown as FakeQueue
    getSharedRedis()
    await closeAllQueues()
    expect(q.close).toHaveBeenCalled()
    expect(quit).toHaveBeenCalled()
    expect(getAllQueues()).toEqual([])
    expect(getQueue('to-close')).not.toBe(q)
  })
})

/*
 * THE TENANT QUEUES (23 Sep 2026): a queue that holds a tenant's work is that
 * tenant's, `<base>@<tenant>`. Each queue is opened through the API of its
 * scope, and a tenant worker reports its faults like a platform one does.
 */
describe('tenant queues', () => {
  beforeEach(() => vi.clearAllMocks())

  it('getQueue and createWorker refuse a tenant base: nothing would ever work a job put in a shared queue', () => {
    expect(() => getQueue('sla-jobs')).toThrow('queue "sla-jobs" is per tenant since 23 Sep 2026: use getTenantQueue("sla-jobs", tenantId)')
    expect(() => createWorker('sla-jobs', async () => undefined)).toThrow(/is per tenant/)
  })

  it('getTenantQueue opens <base>@<tenant>, once per name, apart from the platform queues; a platform queue has no tenant', () => {
    const a = getTenantQueue('sla-jobs', 't1') as unknown as FakeQueue
    expect(a.name).toBe('sla-jobs@t1')
    expect(getTenantQueue('sla-jobs', 't1')).toBe(a)
    expect((getTenantQueue('sla-jobs', 't2') as unknown as FakeQueue).name).toBe('sla-jobs@t2')
    expect(getAllQueues()).not.toContain(a)
    expect(() => getTenantQueue('maintenance', 't1')).toThrow('[bullmq] "maintenance" is not a tenant queue (lib/queueRegistry.ts)')
  })

  /*
   * A job's queries say whom they run for (wave 7 · A2): the tenant its data
   * names and the job, so its slow queries land in that tenant's panel and
   * metrics — they showed under nobody.
   */
  it('a job runs in a query scope with the tenant of its data and its name; a platform job has no tenant', async () => {
    const { currentQueryScope } = await import('@opengraphity/neo4j')
    const w = createWorker('q-scope', async () => currentQueryScope()) as unknown as FakeWorker
    const run = w.processor as (job: unknown) => Promise<unknown>
    await expect(run({ name: 'sweep', data: { tenantId: 't1' } })).resolves.toEqual({ tenantId: 't1', operation: 'job q-scope/sweep' })
    await expect(run({ name: 'backup_database', data: {} })).resolves.toEqual({ operation: 'job q-scope/backup_database' })
  })

  it('so does a job of a tenant queue', async () => {
    const { currentQueryScope } = await import('@opengraphity/neo4j')
    const pool = createTenantWorkers('webhook-delivery', async () => currentQueryScope())
    await pool.add('t1')
    const run = (pool.workerOf('t1') as unknown as FakeWorker).processor as (job: unknown) => Promise<unknown>
    await expect(run({ name: 'deliver', id: 'j1', data: { tenantId: 't1' } })).resolves.toEqual({ tenantId: 't1', operation: 'job webhook-delivery/deliver' })
    await pool.close()
  })

  it('createTenantWorkers registers the pool of a tenant base; a platform base is refused', async () => {
    const pool = createTenantWorkers('webhook-delivery', async () => undefined, { concurrency: 3 })
    expect(pool.base).toBe('webhook-delivery')
    await pool.add('t1')
    expect((pool.workerOf('t1') as unknown as FakeWorker).opts).toEqual(expect.objectContaining({ concurrency: 3 }))
    expect(() => createTenantWorkers('maintenance', async () => undefined)).toThrow(/not a tenant queue/)
    await pool.close()
  })

  it('an outage hitting every tenant\'s worker writes ONE line, and a failed job is logged with its tenant', async () => {
    const pool = createTenantWorkers('email-digest', async () => undefined)
    await pool.add('t1')
    await pool.add('t2')
    const w1 = pool.workerOf('t1') as unknown as FakeWorker
    const w2 = pool.workerOf('t2') as unknown as FakeWorker
    expect(w1.listenerCount('error')).toBe(1)
    w1.emit('error', new Error('ECONNRESET'))
    w2.emit('error', new Error('ECONNRESET'))
    expect(logError.mock.calls.filter((c) => String(c[1]).includes('connection lost'))).toHaveLength(1)
    w2.emit('ready')
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ worker: 'email-digest', taciute: 1 }), expect.stringContaining('back up after'))

    w1.emit('failed', { id: 'j1', name: 'tick', attemptsMade: 1, opts: { attempts: 3 } }, new Error('boom'))
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ worker: 'email-digest', tenantId: 't1', jobId: 'j1', jobName: 'tick', attemptsMade: 1, attempts: 3, err: 'boom' }),
      '[bullmq] job failed',
    )
    await pool.close()
  })
})
