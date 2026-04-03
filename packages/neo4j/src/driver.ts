import neo4j, { Driver, Session, SessionMode } from 'neo4j-driver'

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

function wrapSession(session: Session): Session {
  if (!_tracker) return session
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Proxy(session as any, {
    get(target: Record<string, unknown>, prop: string) {
      if (prop !== 'run') return target[prop]
      return (query: unknown, params?: unknown) => {
        const t0 = performance.now()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = (target['run'] as (...args: unknown[]) => Record<string, any>)(query, params)
        const tracker = _tracker
        if (!tracker) return result
        const queryStr = typeof query === 'string' ? query : ''
        const originalSubscribe = (result['subscribe'] as (...args: unknown[]) => unknown).bind(result as unknown)
        result['subscribe'] = (observer: Record<string, ((...args: unknown[]) => void) | undefined>) => {
          return originalSubscribe({
            onKeys:      observer['onKeys'],
            onNext:      observer['onNext'],
            onCompleted: (...args: unknown[]) => {
              tracker(performance.now() - t0, queryStr)
              observer['onCompleted']?.(...args)
            },
            onError: (...args: unknown[]) => {
              tracker(performance.now() - t0, queryStr)
              observer['onError']?.(...args)
            },
          })
        }
        return result
      }
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
