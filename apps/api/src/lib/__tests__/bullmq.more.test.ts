/**
 * BullMQ wiring: the parts the base test does not reach.
 *
 * Why these behaviours matter:
 *  - Since BullMQ 6 the raw Redis client of a queue lives behind
 *    `getBackend().client`. That is where the "back up" line comes from: without
 *    it, an outage is announced when Redis falls and never when it returns,
 *    which is exactly the information an operator needs during an incident.
 *  - Attaching that listener must never break `getQueue`: a queue that is not
 *    created stops the product, a missing recovery line is only an annoyance.
 *  - The graceful shutdown must close EVERY queue and the shared Redis even
 *    when one of them fails to close; a throw there would leave connections
 *    open and the process hanging on SIGTERM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'

type Backend = { client?: unknown } | undefined
let nextBackend: () => Backend = () => undefined
let nextHasGetBackend = true

class FakeQueue extends EventEmitter {
  constructor(public name: string) { super() }
  close = vi.fn().mockResolvedValue(undefined)
}

vi.mock('bullmq', () => ({
  Worker: vi.fn(function (this: unknown) { return new EventEmitter() }),
  Queue: vi.fn(function (name: string) {
    const q = new FakeQueue(name)
    if (nextHasGetBackend) Object.assign(q, { getBackend: () => nextBackend() })
    return q
  }),
}))

const quit = vi.fn().mockResolvedValue('OK')
vi.mock('ioredis', () => ({
  Redis: vi.fn(function () { return Object.assign(new EventEmitter(), { quit }) }),
}))

const logError = vi.fn()
const logWarn = vi.fn()
const logInfo = vi.fn()
vi.mock('../logger.js', () => ({
  logger: { child: () => ({ error: logError, info: logInfo, warn: logWarn }) },
}))

const { getQueue, closeAllQueues, getSharedRedis, createWorker } = await import('../bullmq.js')

/** Lets the `.then` / `.catch` chained on the backend client promise run. */
const flush = () => new Promise((r) => setImmediate(r))

beforeEach(async () => {
  await closeAllQueues()
  vi.clearAllMocks()
  nextBackend = () => undefined
  nextHasGetBackend = true
})

describe('getQueue recovery listener (BullMQ 6 backend client)', () => {
  it('a queue that went down and whose connection is ready again logs ONE recovery line', async () => {
    const conn = new EventEmitter()
    nextBackend = () => ({ client: Promise.resolve(conn) })
    const q = getQueue('recovering') as unknown as FakeQueue
    await flush()
    q.emit('error', new Error('ECONNREFUSED'))
    conn.emit('ready')
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ queue: 'recovering' }), expect.stringContaining('back up after'))
  })

  it('a backend client that never connects is logged, and the queue is still created', async () => {
    nextBackend = () => ({ client: Promise.reject(new Error('no redis')) })
    const q = getQueue('never-connects')
    await flush()
    expect(q).toBeDefined()
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ queue: 'never-connects' }), expect.stringContaining('could not attach the recovery listener'))
  })

  it('no backend, or a backend without a client promise, still yields a working queue', () => {
    nextHasGetBackend = false
    expect(getQueue('old-bullmq')).toBeDefined()
    nextHasGetBackend = true
    nextBackend = () => ({ client: {} })
    expect(getQueue('sync-client')).toBeDefined()
    expect(logError).not.toHaveBeenCalled()
  })
})

describe('closeAllQueues failure isolation', () => {
  it('one queue failing to close does not stop the others nor the shared Redis', async () => {
    const bad = getQueue('bad') as unknown as FakeQueue
    const good = getQueue('good') as unknown as FakeQueue
    bad.close.mockRejectedValue(new Error('close failed'))
    getSharedRedis()
    await expect(closeAllQueues()).resolves.toBeUndefined()
    expect(good.close).toHaveBeenCalled()
    expect(quit).toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ queue: 'bad' }), '[bullmq] queue close failed')
    expect(logInfo).toHaveBeenCalledWith({ queues: 2 }, '[bullmq] queues closed')
  })

  it('a failing quit of the shared Redis is logged, not thrown, and the next call gets a new client', async () => {
    const first = getSharedRedis()
    quit.mockRejectedValueOnce(new Error('quit failed'))
    await expect(closeAllQueues()).resolves.toBeUndefined()
    expect(logError).toHaveBeenCalledWith(expect.anything(), '[bullmq] shared redis quit failed')
    expect(getSharedRedis()).not.toBe(first)
  })

  it('the shared Redis logs its outage and its recovery', () => {
    const r = getSharedRedis() as unknown as EventEmitter
    expect(getSharedRedis()).toBe(r)
    r.emit('error', new Error('ECONNRESET'))
    r.emit('ready')
    expect(logError).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('connection lost'))
    expect(logWarn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('back up after'))
  })
})

describe('createWorker failed-job log', () => {
  it('a failure without a job (stalled / lost) still logs, with a single attempt assumed', () => {
    const w = createWorker('w-nojob', async () => undefined) as unknown as EventEmitter
    w.emit('failed', undefined, new Error('lost'))
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ worker: 'w-nojob', jobId: undefined, attempts: 1, err: 'lost' }), '[bullmq] job failed')
  })
})
