import { Session, Integer, isInt, isDate, isDateTime, isLocalDateTime, isLocalTime, isTime, isDuration } from 'neo4j-driver'

function toNative(value: unknown): unknown {
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
  session: Session,
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
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`[neo4j] Query failed: ${message}\nCypher: ${cypher}`)
  }
}

export async function runQueryOne<T>(
  session: Session,
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T | null> {
  const results = await runQuery<T>(session, cypher, params)
  return results[0] ?? null
}
