/**
 * BullMQ wiring shared by every worker/queue of the API (A-06, A-13).
 *
 * - `createWorker` registers `on('error')` on every Worker: BullMQ emits
 *   `'error'` on Redis blips (`this.run().catch(err => this.emit('error', err))`)
 *   and an EventEmitter with no `'error'` listener THROWS — the whole API
 *   process died on a Redis reconnect. The listener logs and never rethrows;
 *   the worker reconnects on its own.
 * - `getQueue(name)` is a per-name singleton: a `new Queue(...)` per call
 *   leaked one Redis connection each and was never closed.
 * - `closeAllQueues()` must be invoked from the graceful shutdown in index.ts
 *   after the workers are closed.
 *
 * Single-replica note: the singletons are per process; every replica holds its
 * own Queue objects, which is fine (Queue objects are cheap producers).
 */
import { Queue, Worker, type Job, type Processor, type WorkerOptions, type QueueOptions } from 'bullmq'
import { Redis } from 'ioredis'
import { getRedisOptions } from '@opengraphity/events'
import { logger } from './logger.js'

const log = logger.child({ module: 'bullmq' })

// ── Queues ───────────────────────────────────────────────────────────────────

const queues = new Map<string, Queue>()

/** Per-name Queue singleton (producer side). Never `close()` the returned object: use closeAllQueues(). */
export function getQueue<D = unknown>(name: string, opts?: Omit<QueueOptions, 'connection'>): Queue<D> {
  let q = queues.get(name)
  if (!q) {
    q = new Queue(name, { ...opts, connection: getRedisOptions() })
    q.on('error', (err: Error) => {
      log.error({ err, queue: name }, '[bullmq] queue connection error')
    })
    queues.set(name, q)
  }
  return q as Queue<D>
}

/** All queues opened so far (metrics collector). */
export function getAllQueues(): Queue[] {
  return [...queues.values()]
}

// ── Shared plain Redis client (idempotency markers, SET NX, …) ───────────────

let redis: Redis | null = null

/** Lazy shared ioredis client. Closed by closeAllQueues(). */
export function getSharedRedis(): Redis {
  if (!redis) {
    const { host, port } = getRedisOptions()
    redis = new Redis({ host, port, maxRetriesPerRequest: 3, lazyConnect: false })
    redis.on('error', (err: Error) => {
      log.error({ err }, '[bullmq] shared redis client error')
    })
  }
  return redis
}

/**
 * Close every Queue singleton and the shared Redis client. To be called from
 * the graceful shutdown in index.ts AFTER the workers have been closed.
 */
export async function closeAllQueues(): Promise<void> {
  const all = [...queues.entries()]
  queues.clear()
  await Promise.all(all.map(async ([name, q]) => {
    try {
      await q.close()
    } catch (err) {
      log.error({ err, queue: name }, '[bullmq] queue close failed')
    }
  }))
  if (redis) {
    const r = redis
    redis = null
    try {
      await r.quit()
    } catch (err) {
      log.error({ err }, '[bullmq] shared redis quit failed')
    }
  }
  log.info({ queues: all.length }, '[bullmq] queues closed')
}

// ── Workers ──────────────────────────────────────────────────────────────────

export interface CreateWorkerOptions extends Omit<WorkerOptions, 'connection'> {
  /**
   * Called on every failed job attempt, AFTER the structured log line. Use it
   * for worker-specific diagnostics (e.g. "all retries exhausted" details).
   */
  onFailed?: (job: Job | undefined, err: Error) => void
}

/**
 * Creates a Worker with the mandatory `'error'` + `'failed'` listeners.
 * `'error'` logs and never throws (a Redis blip must NOT crash the API).
 */
export function createWorker<D = unknown, R = unknown, N extends string = string>(
  name: string,
  processor: Processor<D, R, N>,
  opts: CreateWorkerOptions = {},
): Worker<D, R, N> {
  const { onFailed, ...workerOpts } = opts
  const worker = new Worker<D, R, N>(name, processor, { ...workerOpts, connection: getRedisOptions() })

  worker.on('error', (err: Error) => {
    log.error({ err, worker: name }, '[bullmq] worker error (connection/internal) — worker keeps running')
  })

  worker.on('failed', (job, err) => {
    log.error({
      worker:       name,
      jobId:        job?.id,
      jobName:      job?.name,
      attemptsMade: job?.attemptsMade,
      attempts:     job?.opts?.attempts ?? 1,
      err:          err.message,
    }, '[bullmq] job failed')
    onFailed?.(job as Job | undefined, err)
  })

  log.info({ worker: name, concurrency: workerOpts.concurrency ?? 1 }, '[bullmq] worker started')
  return worker
}
