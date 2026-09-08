import {
  Session, ManagedTransaction, Integer, isInt, isDate, isDateTime, isLocalDateTime, isLocalTime, isTime, isDuration,
  Neo4jError, isRetriableError,
} from 'neo4j-driver'

/**
 * Anything runQuery/runQueryOne can execute against: a plain Session
 * (auto-commit query) or a ManagedTransaction (participates in the caller's
 * open transaction, e.g. inside session.executeWrite). Both expose .run().
 */
export type Queryable = Session | ManagedTransaction

// ── Numbers ──────────────────────────────────────────────────────────────────

/**
 * Neo4j Integer / BigInt / number → plain JS number (D-22). The single helper
 * behind the many local `toInt`/`toNum` copies:
 *   - `null`/`undefined` → 0 (every former copy did this: a missing count is 0)
 *   - numeric strings are accepted (`"42"` → 42)
 *   - anything else (NaN, objects, booleans) THROWS — a silent NaN reaching a
 *     resolver or a SLA deadline is worse than a loud failure.
 */
export function toNumber(v: unknown): number {
  if (v === null || v === undefined) return 0
  if (typeof v === 'number') {
    if (Number.isNaN(v)) throw new TypeError('[neo4j] toNumber: value is NaN')
    return v
  }
  if (typeof v === 'bigint') return Number(v)
  if (isInt(v as Integer)) return (v as Integer).toNumber()
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (!Number.isNaN(n)) return n
  }
  throw new TypeError(`[neo4j] toNumber: cannot convert ${typeof v} ${JSON.stringify(v)} to a number`)
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * Error thrown by runQuery/runQueryOne (D-16). The message is the Neo4j
 * message (no Cypher in it: the statement is a property, for logs that want
 * it, not for responses); `code` is the Neo4j status code
 * (e.g. `Neo.ClientError.Schema.ConstraintValidationFailed`) so callers can map
 * it (→ 409) and `retryable` tells transient failures apart. `cause` keeps the
 * original error.
 */
export class QueryError extends Error {
  override readonly name = 'QueryError'
  readonly code: string | undefined
  readonly retryable: boolean
  readonly cypher: string
  override readonly cause: unknown

  constructor(cause: unknown, cypher: string) {
    const message = cause instanceof Error ? cause.message : String(cause)
    super(message)
    this.cause     = cause
    this.cypher    = cypher
    this.code      = cause instanceof Neo4jError ? cause.code : undefined
    this.retryable = cause instanceof Error ? isRetriableError(cause) : false
  }

  /** True when the failure is a uniqueness/existence constraint violation. */
  get isConstraintViolation(): boolean {
    return this.code === 'Neo.ClientError.Schema.ConstraintValidationFailed'
  }
}

// ── Records → plain values ───────────────────────────────────────────────────

/**
 * Driver value → JSON-friendly plain value: Integer → number, temporal types
 * and Duration → their ISO string, recursively through lists and maps.
 * Exported for the backup (raw driver records, no session wrapper).
 */
export function toNative(value: unknown): unknown {
  if (value === null || value === undefined) return value

  if (isInt(value as Integer)) return (value as Integer).toNumber()
  if (isDate(value))          return (value as { toString(): string }).toString()
  if (isDateTime(value))      return (value as { toString(): string }).toString()
  if (isLocalDateTime(value)) return (value as { toString(): string }).toString()
  if (isLocalTime(value))     return (value as { toString(): string }).toString()
  if (isTime(value))          return (value as { toString(): string }).toString()
  if (isDuration(value))      return (value as { toString(): string }).toString()

  if (Array.isArray(value)) return value.map(toNative)

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = toNative(v)
    }
    return result
  }

  return value
}

export async function runQuery<T>(
  session: Queryable,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  try {
    const result = await session.run(cypher, params)
    return result.records.map((record) => {
      const obj: Record<string, unknown> = {}
      for (const key of record.keys) {
        obj[key as string] = toNative(record.get(key))
      }
      return obj as T
    })
  } catch (err) {
    throw new QueryError(err, cypher)
  }
}

export async function runQueryOne<T>(
  session: Queryable,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T | null> {
  const results = await runQuery<T>(session, cypher, params)
  return results[0] ?? null
}
