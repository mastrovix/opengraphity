/**
 * THE TENANT QUEUES FOLLOW THE TENANTS (owner's decision, 23 Sep 2026).
 *
 * Every queue that holds a tenant's work is that tenant's alone
 * (`<base>@<tenant>`, packages/events/src/tenantQueues.ts), so each process
 * needs one worker per tenant for every pool it runs. This module keeps them
 * in step with the graph:
 *
 *  - at boot, after the pools are registered, every tenant gets its workers
 *    and its recurring jobs — a failure here stops the boot, as a failed
 *    scheduler registration always did;
 *  - a tenant created, suspended, resumed or deleted is announced on a Redis
 *    channel, and every process reconciles at once;
 *  - every minute each process reconciles anyway: a message lost while a
 *    subscriber was disconnected (Redis pub/sub keeps no backlog) costs at
 *    most a minute, never a tenant without workers.
 *
 * A suspended tenant has its queues paused (owner's decision): nothing of its
 * runs — timers, webhooks, notifications, alarms — and what came due while it
 * was suspended runs when it is resumed. The pause is kept by BullMQ in
 * Redis, so it holds for every process.
 *
 * Every reconciliation also leaves this process's heartbeat, under its
 * hostname: the liveness probe of the worker containers reads it
 * (lib/workerLiveness.ts).
 */
import { hostname } from 'node:os'
import { Redis } from 'ioredis'
import { getRedisConnection, reconcileTenantPools, type ReconcileOutcome, type TenantState } from '@opengraphity/events'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { getSharedRedis } from './bullmq.js'
import { logger } from './logger.js'
import { guastoDi, ripresaDi } from './dipendenzaGiu.js'
import { ALIVE_KEY_PREFIX, ALIVE_TTL_SECONDS } from './workerLiveness.js'

const log = logger.child({ module: 'tenant-queues' })

export const TENANT_QUEUES_CHANNEL = 'og:tenant-queues'
export const TENANT_QUEUES_RECONCILE_MS = 60_000

export type TenantChange = 'created' | 'suspended' | 'resumed' | 'deleted'

let subscriber: Redis | null = null
let timer: NodeJS.Timeout | null = null
let current: readonly TenantState[] = []

/** Every tenant of the graph, and whether it is suspended. */
export async function loadTenantStates(): Promise<TenantState[]> {
  const session = getSession(undefined, 'READ')
  try {
    // tenant-ok(piattaforma): the workers of a process follow every tenant that exists.
    const rows = await runQuery<{ id: string; suspended: boolean }>(session, `
      MATCH (t:Tenant)
      WHERE t.id IS NOT NULL
      RETURN t.id AS id, t.suspended_at IS NOT NULL AS suspended
      ORDER BY id
    `, {})
    return rows.map((r) => ({ id: r.id, suspended: r.suspended === true }))
  } finally {
    await session.close()
  }
}

/** The tenants the queues of this process follow, as of the last reconciliation. */
export function tenantsWithQueues(): readonly TenantState[] {
  return current
}

const aliveKey = () => `${ALIVE_KEY_PREFIX}${hostname()}`

/** Reads the tenants and makes every pool of this process match them. Says what changed and what failed. */
export async function reconcileTenantQueues(reason: string): Promise<ReconcileOutcome> {
  const tenants = await loadTenantStates()
  current = tenants
  const outcome = await reconcileTenantPools(tenants)
  await getSharedRedis().set(aliveKey(), JSON.stringify({ tenants: tenants.length, at: new Date().toISOString() }), 'EX', ALIVE_TTL_SECONDS)
  if (outcome.added.length + outcome.removed.length + outcome.paused.length + outcome.resumed.length > 0) {
    log.info({
      reason, tenants: tenants.length, added: outcome.added.length,
      removed: outcome.removed, paused: outcome.paused, resumed: outcome.resumed,
    }, 'tenant queues reconciled')
  }
  if (outcome.failures.length > 0) {
    log.error({ reason, failures: outcome.failures }, 'tenant queues: some queues could not be reconciled; the next pass retries them')
  }
  return outcome
}

function reconcileInBackground(reason: string): void {
  void reconcileTenantQueues(reason).catch((err: unknown) => {
    log.error({ err, reason }, 'tenant queues: reconciliation failed; the next pass retries it')
  })
}

/**
 * Gives every registered pool its tenants, then follows the tenants. Call it
 * AFTER every pool of the process is registered: a pool created later waits
 * for the next reconciliation (at most a minute) for its workers.
 */
export async function startTenantQueueLifecycle(): Promise<void> {
  const first = await reconcileTenantQueues('boot')
  if (first.failures.length > 0) {
    throw new Error(`tenant queues could not be set up at boot: ${first.failures.map((f) => `${f.queue}: ${f.error}`).join('; ')}`)
  }
  if (!subscriber) {
    subscriber = new Redis({ ...getRedisConnection(), maxRetriesPerRequest: null })
    subscriber.on('error', (err: Error) => { guastoDi(log, `tenant-queues:${TENANT_QUEUES_CHANNEL}`, err, { channel: TENANT_QUEUES_CHANNEL }) })
    subscriber.on('ready', () => { ripresaDi(log, `tenant-queues:${TENANT_QUEUES_CHANNEL}`, { channel: TENANT_QUEUES_CHANNEL }) })
    subscriber.on('message', (_channel: string, message: string) => { reconcileInBackground(`announced: ${message.slice(0, 200)}`) })
    await subscriber.subscribe(TENANT_QUEUES_CHANNEL)
  }
  if (!timer) {
    timer = setInterval(() => { reconcileInBackground('periodic') }, TENANT_QUEUES_RECONCILE_MS)
    timer.unref()
  }
  log.info({ tenants: current.length }, 'tenant queues follow the tenants')
}

/**
 * A tenant was created, suspended, resumed or deleted: this process
 * reconciles now, and every other one hears it on the channel. A failed
 * publish is not the end of it — the others reconcile within a minute — but
 * it is said.
 */
export async function announceTenantChange(tenantId: string, change: TenantChange): Promise<void> {
  await reconcileTenantQueues(`${change} ${tenantId}`)
  try {
    await getSharedRedis().publish(TENANT_QUEUES_CHANNEL, JSON.stringify({ tenantId, change }))
  } catch (err) {
    log.error({ err, tenantId, change }, 'tenant queues: the change could not be announced; the other processes see it at their next pass (within a minute)')
  }
}

/** Stops following the tenants (shutdown). The pools are closed by their owners. */
export async function stopTenantQueueLifecycle(): Promise<void> {
  const wasRunning = timer !== null
  if (timer) { clearInterval(timer); timer = null }
  const s = subscriber
  subscriber = null
  if (s) await s.quit().catch(() => { s.disconnect() })
  // A process that stops is no longer alive: its heartbeat goes with it instead of lasting its TTL.
  if (wasRunning) {
    await getSharedRedis().del(aliveKey()).catch((err: unknown) => { log.warn({ err }, 'tenant queues: heartbeat not removed at shutdown; it expires by itself') })
  }
}
