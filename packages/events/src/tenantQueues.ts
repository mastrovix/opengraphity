/**
 * ONE QUEUE PER TENANT (owner's decision, 23 Sep 2026).
 *
 * Every tenant used to share the same BullMQ queues: a job said whose it was
 * only inside its data, under three different names, and nothing made a new
 * job say it. The queue console of a tenant admin listed and retried the jobs
 * of every tenant, and one tenant's burst waited in front of everyone else's.
 *
 * Now a queue that holds a tenant's work is that tenant's alone:
 * `<base>@<tenant>` (`sla-jobs@c-one`). The `@` cannot appear in a tenant id
 * nor in a base name, and BullMQ refuses `:` in a queue name.
 *
 * - Producers: `tenantQueue(base, tenantId)` — a per-name singleton on ONE
 *   shared Redis connection per process (a hundred producer queues must not
 *   mean a hundred connections).
 * - Consumers: a `TenantWorkerPool` per base holds one Worker per tenant,
 *   each with the concurrency the base had when it was shared. Every job must
 *   name the tenant of its queue: a job of another tenant, or of none, is
 *   refused loudly instead of being worked on the wrong tenant's time.
 * - `reconcileTenantPools(tenants)` makes every pool of this process match
 *   the tenants that exist: a new tenant gets its workers (and its recurring
 *   jobs, through `schedule`), a purged one loses them, a suspended one has
 *   its queues paused — a pause is kept by BullMQ in Redis, so it holds for
 *   every process until the tenant is resumed. The host (apps/api) calls it
 *   at boot, on a lifecycle message and every minute.
 * - Queues of the platform itself (backup, self-analysis) are not here: they
 *   stay plain queues in apps/api.
 */
import { Queue, Worker, type Job, type Processor, type WorkerOptions } from 'bullmq'
import { Redis } from 'ioredis'
import { getRedisConnection } from './redis.js'

export const TENANT_QUEUE_SEPARATOR = '@'

/** A tenant id as it may appear in a queue name: a slug, no separator, no `:`. */
const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** A base name: the name the queue had when it was shared. */
const BASE_RE = /^[a-z][a-z0-9-]*$/

/** `<base>@<tenant>`. Throws on an empty or malformed tenant: a tenant queue exists only for a tenant. */
export function tenantQueueName(base: string, tenantId: string): string {
  if (!BASE_RE.test(base)) throw new Error(`[tenant-queues] "${base}" is not a queue base name`)
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`[tenant-queues] ${JSON.stringify(tenantId)} is not a tenant id: the work of queue "${base}" belongs to a tenant, and the caller did not say which`)
  }
  return `${base}${TENANT_QUEUE_SEPARATOR}${tenantId}`
}

/** The base and the tenant of a tenant queue name, or null for any other name. */
export function splitTenantQueueName(name: string): { base: string; tenantId: string } | null {
  const at = name.indexOf(TENANT_QUEUE_SEPARATOR)
  if (at <= 0) return null
  const base = name.slice(0, at)
  const tenantId = name.slice(at + 1)
  return BASE_RE.test(base) && TENANT_ID_RE.test(tenantId) ? { base, tenantId } : null
}

/**
 * The tenant a job's data names: `tenantId`, `tenant_id` (a domain event), or
 * either one level down. Null when it names none.
 */
export function jobTenantOf(data: unknown): string | null {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  for (const key of ['tenantId', 'tenant_id']) {
    if (typeof d[key] === 'string' && d[key] !== '') return d[key] as string
  }
  for (const inner of Object.values(d)) {
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) continue
    const i = inner as Record<string, unknown>
    for (const key of ['tenantId', 'tenant_id']) {
      if (typeof i[key] === 'string' && i[key] !== '') return i[key] as string
    }
  }
  return null
}

// ── What the host process does with the events of the queues ─────────────────

export interface TenantQueueHooks {
  /** A producer queue (or the shared producer connection) reported an error. */
  queueError(queueName: string, err: Error): void
  /** A worker reported an error: Redis unreachable, mostly. It reconnects by itself. */
  workerError(base: string, tenantId: string, err: Error): void
  /** A worker is connected (again). */
  workerReady(base: string, tenantId: string): void
  /** One attempt of a job failed. */
  jobFailed(base: string, tenantId: string, job: Job | undefined, err: Error): void
}

const consoleHooks: TenantQueueHooks = {
  queueError: (name, err) => { console.error(`[tenant-queues] queue ${name}: ${err.message}`) },
  workerError: (base, tenantId, err) => { console.error(`[tenant-queues] worker ${base}@${tenantId}: ${err.message}`) },
  workerReady: () => {},
  jobFailed: (base, tenantId, job, err) => {
    console.error(`[tenant-queues] ${base}@${tenantId} job ${job?.name ?? '?'} (${job?.id ?? '?'}) failed: ${err.message}`)
  },
}

let hooks: TenantQueueHooks = consoleHooks

/** The host replaces the console lines with its own logger (apps/api lib/bullmq.ts). */
export function setTenantQueueHooks(next: Partial<TenantQueueHooks>): void {
  hooks = { ...consoleHooks, ...next }
}

// ── Producers ─────────────────────────────────────────────────────────────────

const producers = new Map<string, Queue>()
let producerConnection: Redis | null = null

/**
 * One connection for every producer queue of the process. BullMQ does not
 * close a connection it was given: `closeTenantQueues` does. Default ioredis
 * retries, as the producers had before: an `add` while Redis is down fails
 * after a while instead of waiting for ever, so a webhook still answers 500.
 */
function sharedProducerConnection(): Redis {
  if (!producerConnection) {
    producerConnection = new Redis(getRedisConnection())
    producerConnection.on('error', (err: Error) => { hooks.queueError('tenant-producers', err) })
  }
  return producerConnection
}

/** The producer queue of a tenant for a base. Per-name singleton: never `close()` it, use `closeTenantQueues`. */
export function tenantQueue<D = unknown>(base: string, tenantId: string): Queue<D> {
  const name = tenantQueueName(base, tenantId)
  let q = producers.get(name)
  if (!q) {
    q = new Queue(name, { connection: sharedProducerConnection() })
    // An EventEmitter with no 'error' listener throws: every queue gets one.
    q.on('error', (err: Error) => { hooks.queueError(name, err) })
    producers.set(name, q)
  }
  return q as Queue<D>
}

/** The producer queues open in this process (metrics). */
export function openTenantQueues(): Queue[] {
  return [...producers.values()]
}

async function dropProducer(name: string): Promise<void> {
  const q = producers.get(name)
  producers.delete(name)
  pausedState.delete(name)
  if (q) await q.close()
}

/** Closes every producer queue and the shared connection. Workers are closed by their pools. */
export async function closeTenantQueues(): Promise<void> {
  const names = [...producers.keys()]
  const failures: string[] = []
  for (const name of names) {
    try { await dropProducer(name) } catch (err) { failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`) }
  }
  const conn = producerConnection
  producerConnection = null
  if (conn) await conn.quit().catch(() => { conn.disconnect() })
  if (failures.length) throw new Error(`[tenant-queues] ${failures.length} queue(s) did not close: ${failures.join('; ')}`)
}

// ── Consumers ─────────────────────────────────────────────────────────────────

export interface TenantPoolOptions extends Omit<WorkerOptions, 'connection'> {
  /**
   * Registers the tenant's own recurring jobs on its queue (a job scheduler
   * is kept in Redis, so `upsertJobScheduler` is safe from every process).
   * Retried at every reconciliation until it succeeds once.
   */
  schedule?: (queue: Queue, tenantId: string) => Promise<void>
  /** Called after the host's `jobFailed` hook, for the diagnostics of one pool. */
  onFailed?: (job: Job | undefined, err: Error, tenantId: string) => void
  /**
   * At most this many jobs of the base run at once in this PROCESS, whatever
   * their tenant. For work bound by what the process itself has — the CPU of
   * a local model, one heavy scan at a time — which one queue per tenant would
   * otherwise multiply by the number of tenants. A job over the limit waits
   * its turn, first come first served; BullMQ keeps renewing its lock.
   */
  processLimit?: number
}

/** At most `limit` holders at once; the others wait, first come first served. */
class Turns {
  private running = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running < this.limit) this.running++
    else await new Promise<void>((resolve) => { this.waiting.push(resolve) })
    try {
      return await work()
    } finally {
      // The turn passes to the next in line; only when nobody waits is it given back.
      const next = this.waiting.shift()
      if (next) next()
      else this.running--
    }
  }
}

// The pools of the process; their data types differ, the registry does not care.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pools = new Set<TenantWorkerPool<any, any>>()

/** A base's workers, one per tenant, created and closed with the tenants. */
export class TenantWorkerPool<D = unknown, R = unknown> {
  private readonly workers = new Map<string, Worker<D, R>>()
  private readonly scheduled = new Set<string>()
  private readonly turns: Turns | null
  private closed = false

  constructor(
    readonly base: string,
    private readonly processor: Processor<D, R>,
    private readonly opts: TenantPoolOptions = {},
  ) {
    if (!BASE_RE.test(base)) throw new Error(`[tenant-queues] "${base}" is not a queue base name`)
    const limit = opts.processLimit
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new Error(`[tenant-queues] processLimit of ${base} must be a whole number of at least 1, not ${String(limit)}`)
    }
    this.turns = limit === undefined ? null : new Turns(limit)
    pools.add(this)
  }

  /** For the shutdown list and the logs: the base name. */
  get name(): string { return this.base }

  /** The tenants this pool has a worker for. */
  tenants(): string[] { return [...this.workers.keys()] }

  /** The worker of a tenant (tests, diagnostics). */
  workerOf(tenantId: string): Worker<D, R> | undefined { return this.workers.get(tenantId) }

  /** Gives the tenant a worker (once) and registers its recurring jobs (until that succeeds). */
  async add(tenantId: string): Promise<void> {
    if (this.closed) throw new Error(`[tenant-queues] pool ${this.base} is closed`)
    if (!this.workers.has(tenantId)) this.workers.set(tenantId, this.startWorker(tenantId))
    if (this.opts.schedule && !this.scheduled.has(tenantId)) {
      await this.opts.schedule(tenantQueue(this.base, tenantId), tenantId)
      this.scheduled.add(tenantId)
    }
  }

  /** Closes the tenant's worker: the tenant is gone. */
  async remove(tenantId: string): Promise<void> {
    const worker = this.workers.get(tenantId)
    this.workers.delete(tenantId)
    this.scheduled.delete(tenantId)
    if (worker) await worker.close()
  }

  /** Closes every worker of the pool (shutdown). */
  async close(): Promise<void> {
    this.closed = true
    pools.delete(this)
    const all = [...this.workers.values()]
    this.workers.clear()
    this.scheduled.clear()
    await Promise.all(all.map((w) => w.close()))
  }

  private startWorker(tenantId: string): Worker<D, R> {
    const name = tenantQueueName(this.base, tenantId)
    const { schedule: _schedule, onFailed, processLimit: _processLimit, ...workerOpts } = this.opts
    const guarded: Processor<D, R> = async (job, ...rest) => {
      const owner = jobTenantOf(job.data)
      if (owner !== tenantId) {
        throw new Error(owner === null
          ? `[${name}] job ${job.name} (${String(job.id)}) names no tenant: every job of a tenant queue must carry its tenant`
          : `[${name}] job ${job.name} (${String(job.id)}) belongs to tenant ${owner}, not to ${tenantId}: refused`)
      }
      return this.turns ? this.turns.run(() => this.processor(job, ...rest)) : this.processor(job, ...rest)
    }
    const worker = new Worker<D, R>(name, guarded, { ...workerOpts, connection: getRedisConnection() })
    worker.on('error', (err: Error) => { hooks.workerError(this.base, tenantId, err) })
    worker.on('ready', () => { hooks.workerReady(this.base, tenantId) })
    worker.on('failed', (job: Job<D, R> | undefined, err: Error) => {
      hooks.jobFailed(this.base, tenantId, job as Job | undefined, err)
      onFailed?.(job as Job | undefined, err, tenantId)
    })
    return worker
  }
}

/** The pools registered in this process. */
export function tenantWorkerPools(): ReadonlyArray<TenantWorkerPool<unknown, unknown>> {
  return [...pools]
}

// ── Reconciliation ────────────────────────────────────────────────────────────

export interface TenantState {
  readonly id: string
  readonly suspended: boolean
}

export interface ReconcileOutcome {
  /** `<base>@<tenant>` given a worker. */
  readonly added: string[]
  /** `<base>@<tenant>` whose worker was closed: the tenant is gone. */
  readonly removed: string[]
  readonly paused: string[]
  readonly resumed: string[]
  readonly failures: Array<{ queue: string; error: string }>
}

/** The pause state last applied to each queue by this process: a pause is applied on change, not every minute. */
const pausedState = new Map<string, boolean>()

let reconciling: Promise<unknown> = Promise.resolve()

/**
 * Makes every pool of this process match `tenants`. Serialized: a lifecycle
 * message and the periodic pass never run over each other. A failure on one
 * queue does not stop the others; it is in the outcome, for the host to say.
 */
export function reconcileTenantPools(tenants: readonly TenantState[]): Promise<ReconcileOutcome> {
  const run = reconciling.then(() => reconcileOnce(tenants))
  reconciling = run.catch(() => undefined)
  return run
}

async function reconcileOnce(tenants: readonly TenantState[]): Promise<ReconcileOutcome> {
  const out: ReconcileOutcome = { added: [], removed: [], paused: [], resumed: [], failures: [] }
  const wanted = new Set(tenants.map((t) => t.id))
  const fail = (queue: string, err: unknown) => { out.failures.push({ queue, error: err instanceof Error ? err.message : String(err) }) }

  for (const pool of [...pools]) {
    for (const id of pool.tenants()) {
      if (wanted.has(id)) continue
      try { await pool.remove(id); out.removed.push(`${pool.base}@${id}`) } catch (err) { fail(`${pool.base}@${id}`, err) }
    }
    for (const t of tenants) {
      const name = `${pool.base}@${t.id}`
      const had = pool.tenants().includes(t.id)
      try {
        await pool.add(t.id)
        if (!had) out.added.push(name)
      } catch (err) { fail(name, err); continue }
      if (pausedState.get(name) === t.suspended) continue
      try {
        const q = tenantQueue(pool.base, t.id)
        if (t.suspended) { await q.pause(); out.paused.push(name) } else { await q.resume(); if (pausedState.get(name) === true) out.resumed.push(name) }
        pausedState.set(name, t.suspended)
      } catch (err) { fail(name, err) }
    }
  }
  for (const name of [...producers.keys()]) {
    const parts = splitTenantQueueName(name)
    if (parts && !wanted.has(parts.tenantId)) {
      try { await dropProducer(name) } catch (err) { fail(name, err) }
    }
  }
  return out
}

/**
 * Removes every queue of a purged tenant from Redis: its jobs, its recurring
 * jobs, its history. `force`: a job still running is dropped too — the tenant
 * no longer exists, and neither does its data.
 */
export async function obliterateTenantQueues(tenantId: string, bases: readonly string[]): Promise<void> {
  const failures: string[] = []
  for (const base of bases) {
    const name = tenantQueueName(base, tenantId)
    try {
      await tenantQueue(base, tenantId).obliterate({ force: true })
      await dropProducer(name)
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (failures.length) throw new Error(`[tenant-queues] the queues of tenant ${tenantId} were not all removed: ${failures.join('; ')}`)
}

/** Test hook: forget the pools, the producers and the pause state without touching Redis. */
export function resetTenantQueuesForTests(): void {
  pools.clear()
  producers.clear()
  pausedState.clear()
  producerConnection = null
  reconciling = Promise.resolve()
  hooks = consoleHooks
}
