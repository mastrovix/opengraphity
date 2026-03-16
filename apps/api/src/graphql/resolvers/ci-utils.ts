import type { GraphQLContext } from '../../context.js'
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
    name:        props['name']        as string,
    type:        props['type']        as string,
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

export function mapApplication(props: Props) {
  return {
    ...mapBase(props),
    type:    'application',
    url:     props['url']     as string | null ?? null,
  }
}

export function mapDatabase(props: Props) {
  return {
    ...mapBase(props),
    type:   'database',
    port:   props['port'] != null ? String(props['port']) : null,
    instanceType: (props['instance_type'] ?? props['vendor'] ?? null) as string | null,
  }
}

export function mapDatabaseInstance(props: Props) {
  return {
    ...mapBase(props),
    type:         'database_instance',
    ipAddress:    props['ip_address'] as string | null ?? null,
    port:         props['port'] != null ? String(props['port']) : null,
    instanceType: (props['instance_type'] ?? props['vendor'] ?? null) as string | null,
    version:      props["db_version"] as string | null ?? null,
  }
}

export function mapServer(props: Props) {
  return {
    ...mapBase(props),
    type:      'server',
    ipAddress: props['ip_address'] as string | null ?? null,
    location:  props['location']   as string | null ?? null,
    vendor:    props['vendor']     as string | null ?? null,
    os:      props['os_version'] as string | null ?? null,
    version: props['version']   as string | null ?? null,
  }
}

export function mapCertificate(props: Props) {
  return {
    ...mapBase(props),
    type:            'certificate',
    serialNumber:    props['serial_number']    as string | null ?? null,
    expiresAt:       props['expires_at']       as string | null ?? null,
    certificateType: props['certificate_type'] as string | null ?? null,
  }
}

export function mapCI(props: Props) {
  const type = props['type'] as string
  switch (type) {
    case 'application':        return mapApplication(props)
    case 'database':           return mapDatabase(props)
    case 'database_instance':  return mapDatabaseInstance(props)
    case 'server':             return mapServer(props)
    case 'certificate':        return mapCertificate(props)
    default:                   return mapApplication(props)
  }
}

export async function resolveOwnerGroup(parent: { id: string }, _: unknown, _ctx: GraphQLContext) {
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session,
      `MATCH (n {id: $id})-[:OWNED_BY]->(t:Team)
       RETURN properties(t) AS props`,
      { id: parent.id }
    )
    if (!row) return null
    const p = row.props
    return {
      id: p['id'] as string,
      tenantId: p['tenant_id'] as string,
      name: p['name'] as string,
      description: p['description'] as string | null ?? null,
      type: p['type'] as string | null ?? null,
      createdAt: p['created_at'] as string,
    }
  })
}

export async function resolveSupportGroup(parent: { id: string }, _: unknown, _ctx: GraphQLContext) {
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session,
      `MATCH (n {id: $id})-[:SUPPORTED_BY]->(t:Team)
       RETURN properties(t) AS props`,
      { id: parent.id }
    )
    if (!row) return null
    const p = row.props
    return {
      id: p['id'] as string,
      tenantId: p['tenant_id'] as string,
      name: p['name'] as string,
      description: p['description'] as string | null ?? null,
      type: p['type'] as string | null ?? null,
      createdAt: p['created_at'] as string,
    }
  })
}

export async function resolveDependencies(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props; label: string; relation: string }>(session,
      `MATCH (n {id: $id})-[r:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE]->(d)
       WHERE d.tenant_id = $tenantId
       RETURN properties(d) AS props, labels(d)[0] AS label, type(r) AS relation
       ORDER BY d.name`,
      { id: parent.id, tenantId: ctx.tenantId }
    )
    return rows.map((r) => {
      r.props['type'] = labelToType(r.label)
      return { ci: mapCI(r.props), relation: r.relation }
    })
  })
}

export async function resolveDependents(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props; label: string; relation: string }>(session,
      `MATCH (n {id: $id})<-[r:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE]-(d)
       WHERE d.tenant_id = $tenantId
       RETURN properties(d) AS props, labels(d)[0] AS label, type(r) AS relation
       ORDER BY d.name`,
      { id: parent.id, tenantId: ctx.tenantId }
    )
    return rows.map((r) => {
      r.props['type'] = labelToType(r.label)
      return { ci: mapCI(r.props), relation: r.relation }
    })
  })
}

export const CI_FIELD_RESOLVERS = {
  ownerGroup:   resolveOwnerGroup,
  supportGroup: resolveSupportGroup,
  dependencies: resolveDependencies,
  dependents:   resolveDependents,
}

export { runQuery, runQueryOne, getSession }
