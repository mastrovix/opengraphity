import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'

export function labelToType(label: string): string {
  switch (label) {
    case 'Application':      return 'application'
    case 'Database':         return 'database'
    case 'DatabaseInstance': return 'database_instance'
    case 'Server':           return 'server'
    case 'Certificate':      return 'certificate'
    default:                 return 'application'
  }
}

export type Props = Record<string, unknown>

export async function withSession<T>(fn: (s: ReturnType<typeof getSession>) => Promise<T>, write = false): Promise<T> {
  const session = getSession(undefined, write ? 'WRITE' : 'READ')
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

export function mapBase(props: Props) {
  return {
    id:          props['id']          as string,
    name:        (props['name']       ?? '') as string,
    type:        (props['type']       ?? null) as string | null,
    status:      props['status']      as string | null ?? null,
    environment: props['environment'] as string | null ?? null,
    description: props['description'] as string | null ?? null,
    createdAt:   props['created_at']  as string,
    updatedAt:   props['updated_at']  as string | null ?? null,
    notes:       props['notes']       as string | null ?? null,
    ownerGroup:  null,
    supportGroup: null,
    dependencies: [],
    dependents:   [],
  }
}

export function mapCI(props: Props) {
  return mapBase(props)
}

export { runQuery, runQueryOne, getSession }
