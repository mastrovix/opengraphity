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
  Queue:  vi.fn(function (name: string, opts: Record<string, unknown>) { return new FakeQueue(name, opts) }),
}))

const quit = vi.fn().mockResolvedValue('OK')
vi.mock('ioredis', () => ({
  Redis: vi.fn(function () { return Object.assign(new EventEmitter(), { quit }) }),
}))

const logError = vi.fn()
vi.mock('../logger.js', () => ({
  logger: { child: () => ({ error: logError, info: vi.fn(), warn: vi.fn() }) },
}))

const { createWorker, getQueue, getAllQueues, closeAllQueues, getSharedRedis } = await import('../bullmq.js')

describe('createWorker', () => {
  beforeEach(() => vi.clearAllMocks())

  it("registra on('error') e non rilancia: un errore di connessione viene solo loggato", () => {
    const w = createWorker('q1', async () => undefined, { concurrency: 2 }) as unknown as FakeWorker
    expect(w.listenerCount('error')).toBe(1)
    expect(() => w.emit('error', new Error('ECONNRESET'))).not.toThrow()
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ worker: 'q1' }), expect.stringContaining('worker error'))
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
