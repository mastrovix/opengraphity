import neo4j, { Driver, Session, SessionMode, Integer, isInt } from 'neo4j-driver'

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
type SessionTracker = (durationMs: number, query: string) => void
let _tracker: SessionTracker | null = null

export function registerSessionTracker(fn: SessionTracker | null): void {
  _tracker = fn
}

// Wrap a ManagedTransaction (tx inside executeRead/executeWrite) so tx.run() is tracked
// and results are auto-converted from BigInt/Integer to Number.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wrapManagedTransaction(tx: any): any {
  return new Proxy(tx, {
    get(target: Record<string, unknown>, prop: string, receiver: unknown) {
      if (prop !== 'run') return Reflect.get(target, prop, receiver)
      return async (query: unknown, params?: unknown) => {
        const t0       = performance.now()
        const queryStr = typeof query === 'string' ? query : ''
        try {
          const result = await (target['run'] as (...a: unknown[]) => Promise<unknown>)(query, params)
          return convertResult(result)
        } finally {
          _tracker?.(performance.now() - t0, queryStr)
        }
      }
    },
  })
}

function wrapSession(session: Session): Session {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Proxy(session as any, {
    get(target: Record<string, unknown>, prop: string, receiver: unknown) {
      // session.run() — used by runQuery / runQueryOne
      if (prop === 'run') {
        return async (query: unknown, params?: unknown) => {
          const t0       = performance.now()
          const queryStr = typeof query === 'string' ? query : ''
          try {
            const result = await (target['run'] as (...a: unknown[]) => Promise<unknown>)(query, params)
            return convertResult(result)
          } finally {
            _tracker?.(performance.now() - t0, queryStr)
          }
        }
      }

      // session.executeRead/executeWrite — used by the majority of resolvers.
      // Proxy the ManagedTransaction passed to the callback so tx.run() is tracked.
      if (prop === 'executeRead' || prop === 'executeWrite') {
        return (work: (tx: unknown) => unknown, txConfig?: unknown) => {
          const wrappedWork = (tx: unknown) => work(wrapManagedTransaction(tx))
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
  return wrapSession(session)
}

export async function closeDriver(): Promise<void> {
  if (_driver) {
    await _driver.close()
    _driver = null
    console.log('[neo4j] Driver closed')
  }
}
