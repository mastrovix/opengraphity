/**
 * IS THIS WORKER CONTAINER ALIVE? (23 Sep 2026)
 *
 * The probe of the `worker` and `events-worker` containers used to ask Redis
 * whether a BullMQ worker of one queue (`embeddings`, `events-ingest`) was
 * connected. Since every tenant has its own queues (`<base>@<tenant>`) there is
 * no such queue any more: the workers are `embeddings@acme`, `embeddings@globex`…
 * and a process with no tenants has no workers at all.
 *
 * So the verdict has two parts:
 *  - THIS container's process is alive and following the tenants: at every
 *    reconciliation (boot, announcement, every minute) it writes a heartbeat
 *    under its hostname, with the number of tenants it follows
 *    (lib/tenantQueueLifecycle.ts). A heartbeat older than its TTL is gone;
 *  - when there are tenants, a worker of the probed base is connected, for
 *    one tenant at least — as before, a per-queue check, not per-container.
 * No tenant yet (a fresh install) is healthy: there is no work to take.
 */

/** Where each process writes its heartbeat: one key per hostname (container). */
export const ALIVE_KEY_PREFIX = 'og:tenant-queues:alive:'
/** Three missed reconciliations (one a minute) and the heartbeat is gone. */
export const ALIVE_TTL_SECONDS = 180

export interface AliveRecord {
  readonly tenants: number
  readonly at: string
}

/**
 * The BullMQ workers of a queue base, for any tenant, in the text of Redis
 * `CLIENT LIST`. A BullMQ connection is named `<prefix>:<base64(queue)><suffix>`
 * (RedisQueueBackend.clientName), and a worker's suffix is empty or `:w:<name>`.
 */
export function workersOfBase(clientList: string, base: string, prefix = 'bull'): number {
  let workers = 0
  for (const line of clientList.split('\n')) {
    const name = /(?:^|\s)name=(\S+)/.exec(line)?.[1]
    if (!name?.startsWith(`${prefix}:`)) continue
    const rest = name.slice(prefix.length + 1)
    const colon = rest.indexOf(':')
    const suffix = colon === -1 ? '' : rest.slice(colon)
    if (suffix !== '' && !suffix.startsWith(':w:')) continue
    const queue = Buffer.from(colon === -1 ? rest : rest.slice(0, colon), 'base64').toString('utf8')
    if (queue === base || queue.startsWith(`${base}@`)) workers++
  }
  return workers
}

export interface LivenessVerdict {
  readonly ok: boolean
  readonly reason: string
}

/** The verdict from this container's heartbeat and the connected workers. */
export function livenessVerdict(alive: string | null, clientList: string, base: string): LivenessVerdict {
  if (alive === null) return { ok: false, reason: 'no heartbeat: the process is not following the tenants (down, stuck, or Redis unreachable)' }
  let record: AliveRecord
  try {
    record = JSON.parse(alive) as AliveRecord
  } catch {
    return { ok: false, reason: `unreadable heartbeat: ${alive.slice(0, 80)}` }
  }
  if (typeof record.tenants !== 'number') return { ok: false, reason: `unreadable heartbeat: ${alive.slice(0, 80)}` }
  if (record.tenants === 0) return { ok: true, reason: 'alive, no tenant yet' }
  const workers = workersOfBase(clientList, base)
  return workers > 0
    ? { ok: true, reason: `alive, ${String(workers)} ${base} worker(s) for ${String(record.tenants)} tenant(s)` }
    : { ok: false, reason: `alive, but no ${base} worker connected for its ${String(record.tenants)} tenant(s)` }
}
