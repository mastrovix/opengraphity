import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { ciTypeFromLabels } from '../../lib/ciTypeFromLabels.js'
import { neo4jDateToISO } from '../../lib/mappers.js'
import { neo4jQueryDurationSeconds, recordSlowQuery } from '../../middleware/metrics.js'

export { ciTypeFromLabels }

/**
 * @deprecated Use ciTypeFromLabels([label]) instead.
 * Kept for compatibility — delegates to ciTypeFromLabels.
 */
export function labelToType(label: string): string {
  return ciTypeFromLabels([label])
}

export type Props = Record<string, unknown>

export async function withSession<T>(fn: (s: ReturnType<typeof getSession>) => Promise<T>, write = false): Promise<T> {
  const operation = write ? 'WRITE' : 'READ'
  const session = getSession(undefined, operation)
  const t0 = performance.now()
  try {
    return await fn(session)
  } finally {
    await session.close()
    const durationMs = performance.now() - t0
    neo4jQueryDurationSeconds.observe({ operation }, durationMs / 1000)
    if (durationMs > 500) recordSlowQuery(`${operation} session`, durationMs)
  }
}

export function mapBase(props: Props) {
  return {
    id:           props['id']          as string,
    name:         (props['name']       ?? '') as string,
    // type must be set by the caller via ciTypeFromLabels([label]) before mapCI is called
    type:         (props['type']       ?? null) as string | null,
    status:       props['status']      as string | null ?? null,
    environment:  props['environment'] as string | null ?? null,
    description:  props['description'] as string | null ?? null,
    createdAt:    neo4jDateToISO(props['created_at']) ?? '',
    updatedAt:    neo4jDateToISO(props['updated_at']),
    notes:        props['notes']       as string | null ?? null,
    ownerGroup:   null,
    supportGroup: null,
    dependencies: [],
    dependents:   [],
  }
}

export function mapCI(props: Props) {
  return mapBase(props)
}

export { runQuery, runQueryOne, getSession }
