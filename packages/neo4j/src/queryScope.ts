/**
 * HOW LONG A TRANSACTION MAY RUN, AND FOR WHOM (review of 23 Sep 2026, wave 7 · A2).
 *
 * The database has limits of its own (compose: `db.transaction.timeout` 120 s,
 * `db.memory.transaction.max` 1 GB), so a runaway query stops instead of
 * holding the database of every tenant. Two kinds of work need a different
 * time limit, and a timeout sent by the client replaces the server's — in
 * both directions (verified on neo4j 5.26.29):
 *  - a PAGE: its reads stop at 30 s. Past that nobody is waiting, and the
 *    query keeps a thread and memory of the shared database busy for nothing;
 *  - MAINTENANCE (backup, restore, migrations, purges, retention, the scripts):
 *    one transaction reads or rewrites the whole graph, and a
 *    `CALL {…} IN TRANSACTIONS` keeps its outer transaction open for the whole
 *    job — the server's 120 s would kill them half way. The nightly backup of
 *    24 Sep 2026 already held its read transaction for 98 s.
 *
 * A scope is set around a unit of work — a GraphQL request, a script, a job —
 * and every transaction opened inside it without a timeout of its own gets
 * the scope's. A `timeout` in the caller's transaction config always wins.
 * The scope also says whom the queries are for (tenant, operation), for the
 * session tracker: the slow-query panel and the metrics are per tenant.
 *
 * The memory limit cannot be raised by a client: maintenance streams its
 * reads (a streamed result is not held in the transaction's memory) and
 * writes in batches.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export interface QueryScope {
  /** Timeout of the READ transactions opened in the scope, in ms. Absent: the server's. */
  readTimeoutMs?: number
  /** Timeout of the WRITE transactions opened in the scope, in ms. Absent: the server's. */
  writeTimeoutMs?: number
  /** The tenant the queries run for, when there is one. */
  tenantId?: string
  /** What asked for them: a GraphQL operation, a job. */
  operation?: string
}

/** A page's reads: past this nobody is waiting for the answer. */
export const PAGE_READ_TIMEOUT_MS = 30_000

/**
 * Maintenance transactions: two hours. The backup of 4.8 million nodes read
 * for 98 s (24 Sep 2026): the limit leaves room for a graph many times larger
 * and still stops a transaction that hangs.
 */
export const MAINTENANCE_TX_TIMEOUT_MS = 2 * 60 * 60_000

/** The scope of maintenance work, reads and writes alike. */
export const MAINTENANCE_SCOPE: Readonly<QueryScope> = Object.freeze({
  readTimeoutMs:  MAINTENANCE_TX_TIMEOUT_MS,
  writeTimeoutMs: MAINTENANCE_TX_TIMEOUT_MS,
})

/** The transaction config of a statement that is long by design (a whole-graph read, `IN TRANSACTIONS`, `db.awaitIndexes`). */
export const MAINTENANCE_TX_CONFIG: Readonly<{ timeout: number }> = Object.freeze({ timeout: MAINTENANCE_TX_TIMEOUT_MS })

const storage = new AsyncLocalStorage<QueryScope>()

/**
 * Runs `fn` in a scope. A scope inside another keeps what it does not set:
 * a maintenance job inside a job's scope keeps the job's tenant and name.
 */
export function runInQueryScope<T>(scope: QueryScope, fn: () => T): T {
  const merged: QueryScope = { ...storage.getStore() }
  for (const [key, value] of Object.entries(scope) as Array<[keyof QueryScope, QueryScope[keyof QueryScope]]>) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value
  }
  return storage.run(merged, fn)
}

/** The scope of the work in progress; empty outside one. */
export function currentQueryScope(): Readonly<QueryScope> {
  return storage.getStore() ?? {}
}

export type AccessMode = 'READ' | 'WRITE'

/**
 * The transaction config to send: the caller's, with the scope's timeout when
 * the caller gave none. The caller's object is never changed.
 */
export function withScopeTimeout(txConfig: unknown, mode: AccessMode): unknown {
  const given = (txConfig ?? undefined) as { timeout?: unknown } | undefined
  if (given?.timeout !== undefined && given.timeout !== null) return txConfig
  const scope = storage.getStore()
  const ms = mode === 'READ' ? scope?.readTimeoutMs : scope?.writeTimeoutMs
  if (ms === undefined) return txConfig
  return { ...(given ?? {}), timeout: ms }
}

/**
 * Neo4j stopped the transaction at its own memory limit
 * (`db.memory.transaction.max`). The driver files it as transient and
 * `executeRead`/`executeWrite` retried it for 30 s — five attempts in the
 * probe of 24 Sep 2026, each allocating up to the limit again — while the
 * same work on the same data hits the limit every time. The pool-wide limit
 * (`dbms.memory.transaction.total.max`) is really transient: it is not this.
 */
export function isTransactionMemoryLimit(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null
  return typeof e?.code === 'string' && e.code.includes('MemoryPoolOutOfMemoryError')
    && typeof e.message === 'string' && e.message.includes('db.memory.transaction.max')
}
