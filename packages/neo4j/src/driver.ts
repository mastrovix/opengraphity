import neo4j, { Driver, Session, SessionMode, Integer, isInt } from 'neo4j-driver'
import { currentQueryScope, isTransactionMemoryLimit, withScopeTimeout, type AccessMode } from './queryScope.js'

// ── Global BigInt/Integer → Number conversion ────────────────────────────────
// Neo4j driver v5 returns integers as neo4j.Integer or BigInt.
// This recursive converter ensures all numeric values become plain JS numbers
// before reaching any resolver, eliminating "Cannot mix BigInt" errors.

function convertIntegers(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'bigint') return Number(value)
  if (isInt(value as Integer)) return (value as Integer).toNumber()

  if (Array.isArray(value)) return value.map(convertIntegers)

  if (value && typeof value === 'object') {
    // Neo4j Node / Relationship — convert properties in-place
    const obj = value as Record<string, unknown>
    if ('properties' in obj && typeof obj['properties'] === 'object' && obj['properties'] !== null) {
      obj['properties'] = convertIntegers(obj['properties'])
    }
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      result[k] = k === 'properties' ? obj['properties'] : convertIntegers(v)
    }
    return result
  }

  return value
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertResult(result: any): any {
  if (!result || !result.records) return result
  // Patch each record's get() to auto-convert integers
  for (const record of result.records) {
    const origGet = record.get.bind(record)
    record.get = (key: string | number) => convertIntegers(origGet(key))
  }
  return result
}

// The local-dev defaults exist ONLY outside production. In production a missing
// NEO4J_* variable is a config error (and, for the password, a security hole):
// refuse to start rather than connect "by accident" to localhost with the
// default credentials. Same contract as apps/api/src/lib/config.ts — this
// package cannot import it (dependency direction), so the rule is repeated here.
function envOrThrowInProd(name: string, devDefault: string): string {
  const value = process.env[name]
  if (value) return value
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(`[neo4j] ${name} is not set in production — refusing to start with the local-dev default`)
  }
  return devDefault
}

const NEO4J_URI      = envOrThrowInProd('NEO4J_URI',      'neo4j://localhost:7687')
const NEO4J_USER     = envOrThrowInProd('NEO4J_USER',     'neo4j')
const NEO4J_PASSWORD = envOrThrowInProd('NEO4J_PASSWORD', 'opengraphity_local')

/** Default of `maxConnectionPoolSize` (the driver's own default is 100; 50 was the platform's value before it became configurable). */
export const NEO4J_DEFAULT_MAX_POOL_SIZE = 50

/**
 * `NEO4J_MAX_POOL_SIZE`: connections the driver may hold open to Neo4j, per
 * process (revisione 2 · D1.1). Each process is sized in the compose file for
 * the work it hosts (HTTP resolvers vs. job slots × sessions per job). A value
 * that is not a positive integer is a configuration error, never NaN.
 */
export function parseMaxPoolSize(raw: string | undefined): number {
  if (raw === undefined || raw === '') return NEO4J_DEFAULT_MAX_POOL_SIZE
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new Error(`[neo4j] NEO4J_MAX_POOL_SIZE must be a positive integer (got "${raw}")`)
  return n
}

const NEO4J_MAX_POOL_SIZE = parseMaxPoolSize(process.env['NEO4J_MAX_POOL_SIZE'])

let _driver: Driver | null = null

// ── Session tracker (optional instrumentation hook) ───────────────────────────

/** What the tracker is told about a query besides its text and duration. */
export interface TrackedQuery {
  /** The access mode of the transaction it ran in. */
  mode:      AccessMode
  /** From the query scope (queryScope.ts): whom it ran for, what asked for it. */
  tenantId:  string | null
  operation: string | null
  /** The Neo4j code of the error that stopped it; null when it succeeded. */
  errorCode: string | null
}

type SessionTracker = (durationMs: number, query: string, info: TrackedQuery) => void
let _tracker: SessionTracker | null = null

export function registerSessionTracker(fn: SessionTracker | null): void {
  _tracker = fn
}

/** Runs one query through `run`, converting its integers and telling the tracker, success or failure. */
async function trackedRun(run: () => Promise<unknown>, query: unknown, mode: AccessMode): Promise<unknown> {
  const t0 = performance.now()
  let errorCode: string | null = null
  try {
    return convertResult(await run())
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    errorCode = typeof code === 'string' ? code : 'unknown'
    throw err
  } finally {
    if (_tracker) {
      const scope = currentQueryScope()
      _tracker(performance.now() - t0, typeof query === 'string' ? query : '', {
        mode, tenantId: scope.tenantId ?? null, operation: scope.operation ?? null, errorCode,
      })
    }
  }
}

// Wrap a ManagedTransaction (tx inside executeRead/executeWrite) so tx.run() is tracked
// and results are auto-converted from BigInt/Integer to Number.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapManagedTransaction(tx: any, mode: AccessMode): any {
  return new Proxy(tx, {
    get(target: Record<string, unknown>, prop: string, receiver: unknown) {
      if (prop !== 'run') return Reflect.get(target, prop, receiver)
      return (query: unknown, params?: unknown) =>
        trackedRun(() => (target['run'] as (...a: unknown[]) => Promise<unknown>)(query, params), query, mode)
    },
  })
}

/**
 * The work of `executeRead`/`executeWrite`, with the transaction's memory
 * limit made final: the driver would retry it for 30 s (queryScope.ts).
 */
function memoryLimitNotRetried(work: (tx: unknown) => unknown): (tx: unknown) => Promise<unknown> {
  return async (tx: unknown) => {
    try {
      return await work(tx)
    } catch (err) {
      if (isTransactionMemoryLimit(err)) {
        const e = err as { retryable?: boolean; retriable?: boolean }
        e.retryable = false
        e.retriable = false
      }
      throw err
    }
  }
}

/**
 * EVERY session of the process honours the query scope (queryScope.ts),
 * the raw ones included: the backup and the schema initialisation open their
 * sessions on the driver itself (the backup streams its records, which the
 * wrapped session would collect), and their transactions are exactly the
 * long ones. This layer only adds the scope's timeout to a transaction config
 * that has none and stops the memory limit's retries; results pass untouched.
 */
function scopedSession(session: Session, mode: AccessMode): Session {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Proxy(session as any, {
    get(target: Record<string, unknown>, prop: string, receiver: unknown) {
      if (prop === 'run') {
        return (query: unknown, params?: unknown, txConfig?: unknown) =>
          (target['run'] as (...a: unknown[]) => unknown)(query, params, withScopeTimeout(txConfig, mode))
      }
      if (prop === 'beginTransaction') {
        return (txConfig?: unknown) =>
          (target['beginTransaction'] as (...a: unknown[]) => unknown)(withScopeTimeout(txConfig, mode))
      }
      if (prop === 'executeRead' || prop === 'executeWrite') {
        const txMode: AccessMode = prop === 'executeRead' ? 'READ' : 'WRITE'
        return (work: (tx: unknown) => unknown, txConfig?: unknown) =>
          (target[prop] as (...a: unknown[]) => unknown)(memoryLimitNotRetried(work), withScopeTimeout(txConfig, txMode))
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as Session
}

function wrapSession(session: Session, mode: AccessMode): Session {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Proxy(session as any, {
    get(target: Record<string, unknown>, prop: string, receiver: unknown) {
      // session.run() — used by runQuery / runQueryOne. The transaction config
      // (third argument) goes through: it was dropped here, so a timeout
      // given to `session.run` never reached the database (wave 7 · A2).
      if (prop === 'run') {
        return (query: unknown, params?: unknown, txConfig?: unknown) =>
          trackedRun(() => (target['run'] as (...a: unknown[]) => Promise<unknown>)(query, params, txConfig), query, mode)
      }

      /**
       * session.beginTransaction() — la transazione ESPLICITA
       * (revisione totale · M-22).
       *
       * Era l'unico modo di ottenere una transazione non avvolta: le sue
       * `tx.run` non passavano da `convertResult`, quindi il chiamante
       * riceveva `neo4j.Integer` invece di numeri, e le sue query non
       * finivano nel tracciamento. Un chiamante c'e (`backup-neo4j.ts`, che
       * esporta tutto in una sola transazione di lettura) e leggeva i
       * conteggi da li.
       */
      if (prop === 'beginTransaction') {
        return (...args: unknown[]) =>
          wrapManagedTransaction((target['beginTransaction'] as (...a: unknown[]) => unknown)(...args), mode)
      }

      // session.executeRead/executeWrite — used by the majority of resolvers.
      // Proxy the ManagedTransaction passed to the callback so tx.run() is tracked.
      if (prop === 'executeRead' || prop === 'executeWrite') {
        const txMode: AccessMode = prop === 'executeRead' ? 'READ' : 'WRITE'
        return (work: (tx: unknown) => unknown, txConfig?: unknown) => {
          const wrappedWork = (tx: unknown) => work(wrapManagedTransaction(tx, txMode))
          return (target[prop] as (...a: unknown[]) => unknown)(wrappedWork, txConfig)
        }
      }

      return Reflect.get(target, prop, receiver)
    },
  }) as Session
}

function createDriver(): Driver {
  const d = neo4j.driver(
    NEO4J_URI,
    neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
    {
      maxConnectionPoolSize:       NEO4J_MAX_POOL_SIZE,
      connectionAcquisitionTimeout: 30_000,
      maxTransactionRetryTime:      30_000,
    },
  )

  // Fail-fast: a process that cannot reach Neo4j must not come up "healthy"
  // and then fail scattered across every later query. The container
  // orchestrator (healthcheck/depends_on/restart) handles the retry.
  // Under a test runner the driver is created at module import with no DB
  // available by design — exiting would kill the vitest worker, so the error
  // is logged and each query fails loudly on its own instead.
  const underTest = process.env['VITEST'] !== undefined || process.env['NODE_ENV'] === 'test'

  // Every session of the driver honours the query scope, raw ones included (scopedSession).
  const openSession = d.session.bind(d)
  d.session = ((config?: Parameters<Driver['session']>[0]) =>
    scopedSession(openSession(config), config?.defaultAccessMode === neo4j.session.READ ? 'READ' : 'WRITE')) as Driver['session']

  d.verifyConnectivity()
    .then(() => console.log(`[neo4j] Connected to ${NEO4J_URI} (max pool size ${NEO4J_MAX_POOL_SIZE})`))
    .catch((err: unknown) => {
      console.error(`[neo4j] FATAL: connection to ${NEO4J_URI} failed:`, err)
      if (!underTest) process.exit(1)
    })

  return d
}

export function getDriver(): Driver {
  if (!_driver) {
    _driver = createDriver()
  }
  return _driver
}

export const driver: Driver = getDriver()

export function getSession(
  database?: string,
  accessMode: SessionMode = neo4j.session.READ,
): Session {
  const session = getDriver().session({
    database,
    defaultAccessMode: accessMode,
  })
  return wrapSession(session, accessMode === neo4j.session.READ ? 'READ' : 'WRITE')
}

export async function closeDriver(): Promise<void> {
  if (_driver) {
    await _driver.close()
    _driver = null
    console.log('[neo4j] Driver closed')
  }
}
