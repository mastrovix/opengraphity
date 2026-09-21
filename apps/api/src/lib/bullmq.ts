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
 *
 * Connection options come from `getRedisConnection()` in @opengraphity/events —
 * the single parser of REDIS_URL/REDIS_PASSWORD for the whole platform (D-14).
 */
import { Queue, Worker, type Job, type Processor, type WorkerOptions, type QueueOptions } from 'bullmq'
import { Redis } from 'ioredis'
import { getRedisConnection } from '@opengraphity/events'
import { logger } from './logger.js'

import { guastoDi, ripresaDi } from './dipendenzaGiu.js'

const log = logger.child({ module: 'bullmq' })

// ── Queues ───────────────────────────────────────────────────────────────────

const queues = new Map<string, Queue>()

/** Per-name Queue singleton (producer side). Never `close()` the returned object: use closeAllQueues(). */
export function getQueue<D = unknown>(name: string, opts?: Omit<QueueOptions, 'connection'>): Queue<D> {
  let q = queues.get(name)
  if (!q) {
    q = new Queue(name, { ...opts, connection: getRedisConnection() })
    /*
     * UN GUASTO È UN CAMBIO DI STATO, NON UN EVENTO PER TENTATIVO (21 set
     * 2026, `PRB00000002`). Prima qui c'era un `log.error` secco: ioredis
     * riprova senza sosta, e un solo guasto di Redis ha scritto 728 righe su
     * questo processo in un giorno. Vedi `lib/dipendenzaGiu.ts`.
     */
    q.on('error', (err: Error) => {
      guastoDi(log, `bullmq:queue:${name}`, err, { queue: name })
    })
    /*
     * `Queue` non emette `ready` (emette solo `error` e `ioredis:close`), ma
     * si arriva alla connessione sottostante: è da lì che si sa che è
     * rientrata. Senza questo il prodotto direbbe quando cade e mai quando
     * torna, che è l'informazione che serve davvero durante un guasto.
     *
     * DA BULLMQ 6 la strada è `getBackend().client` e non più `queue.client`:
     * «High-level classes no longer expose Redis internals … Access the raw
     * Redis client through the RedisQueueBackend returned by getBackend()».
     * È un miglioramento: prima la coda prometteva un client qualunque fosse
     * il motore sotto, ora lo chiede a chi quel motore lo è davvero — e in
     * BullMQ 6 il motore può anche essere PostgreSQL.
     */
    const backend: unknown = (q as unknown as { getBackend?: () => unknown }).getBackend?.()
    const connessione: unknown = (backend as { client?: unknown } | undefined)?.client
    if (connessione instanceof Promise) {
      void connessione.then((c: { on: (e: string, f: () => void) => void }) => {
        c.on('ready', () => { ripresaDi(log, `bullmq:queue:${name}`, { queue: name }) })
      }).catch((err: unknown) => {
        log.error({ err, queue: name }, '[bullmq] could not attach the recovery listener to the queue connection')
      })
    }
    /*
     * La guardia non è pedanteria: senza, un `client` assente farebbe
     * fallire `getQueue` e con essa OGNI coda del processo. Una riga di
     * ripresa che manca è una scomodità; una coda che non nasce è il
     * prodotto fermo. Fra i due, si perde la riga.
     */
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
    redis = new Redis({ ...getRedisConnection(), maxRetriesPerRequest: 3, lazyConnect: false })
    // Stessa regola delle code: la prima caduta si grida, le ripetizioni si
    // contano, e la ripresa si dice. Qui `ready` lo dà ioredis direttamente.
    redis.on('error', (err: Error) => { guastoDi(log, 'bullmq:shared-redis', err, {}) })
    redis.on('ready', () => { ripresaDi(log, 'bullmq:shared-redis', {}) })
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
  const worker = new Worker<D, R, N>(name, processor, { ...workerOpts, connection: getRedisConnection() })

  worker.on('error', (err: Error) => {
    guastoDi(log, `bullmq:worker:${name}`, err, { worker: name })
  })
  // `Worker` emette `ready` quando la connessione bloccante è pronta: è il
  // segnale di ripresa, e prima non lo ascoltava nessuno.
  worker.on('ready', () => { ripresaDi(log, `bullmq:worker:${name}`, { worker: name }) })

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
