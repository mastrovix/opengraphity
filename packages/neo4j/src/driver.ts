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

const NEO4J_URI      = process.env['NEO4J_URI']      ?? 'neo4j://localhost:7687'
const NEO4J_USER     = process.env['NEO4J_USER']     ?? 'neo4j'
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'opengraphity_local'

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
      maxConnectionPoolSize:       50,
      connectionAcquisitionTimeout: 30_000,
      maxTransactionRetryTime:      30_000,
    },
  )

  d.verifyConnectivity()
    .then(() => console.log(`[neo4j] Connected to ${NEO4J_URI}`))
    .catch((err: unknown) => console.error('[neo4j] Connection failed:', err))

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
