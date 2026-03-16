import { withSession, mapCertificate, labelToType, mapCI, CI_FIELD_RESOLVERS, runQuery, runQueryOne } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import type { Props } from './ci-utils.js'

const WHERE = `
  WHERE ($environment IS NULL OR n.environment = $environment)
    AND ($status IS NULL OR n.status = $status)
    AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))
`

async function certificates(_: unknown, args: { limit?: number; offset?: number; environment?: string; status?: string; search?: string }, ctx: GraphQLContext) {
  const limit = args.limit ?? 50
  const offset = args.offset ?? 0
  const params = { tenantId: ctx.tenantId, environment: args.environment ?? null, status: args.status ?? null, search: args.search ?? null, limit, offset }
  return withSession(async (session) => {
    const items = await runQuery<{ props: Props }>(session,
      `MATCH (n:Certificate {tenant_id: $tenantId})
       ${WHERE}
       RETURN properties(n) AS props ORDER BY n.name ASC SKIP toInteger($offset) LIMIT toInteger($limit)`,
      params
    )
    const countResult = await runQuery<{ total: unknown }>(session,
      `MATCH (n:Certificate {tenant_id: $tenantId})
       ${WHERE}
       RETURN count(n) AS total`,
      params
    )
    const total = (countResult[0]?.total as { toNumber(): number })?.toNumber?.() ?? Number(countResult[0]?.total ?? 0)
    return { items: items.map((r) => mapCertificate(r.props)), total }
  })
}

async function certificate(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session,
      `MATCH (n:Certificate {id: $id, tenant_id: $tenantId}) RETURN properties(n) AS props`,
      { id: args.id, tenantId: ctx.tenantId }
    )
    return row ? mapCertificate(row.props) : null
  })
}

const { dependencies: _deps, dependents: _depts, ...CERT_FIELD_RESOLVERS } = CI_FIELD_RESOLVERS

async function certificateDependencies(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props; label: string; relation: string }>(session,
      `MATCH (n:Certificate {id: $id})-[r:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE]->(d)
       WHERE d.tenant_id = $tenantId
       RETURN properties(d) AS props, labels(d)[0] AS label, type(r) AS relation
       ORDER BY d.name`,
      { id: parent.id, tenantId: ctx.tenantId }
    )
    return rows.map((r) => { r.props['type'] = labelToType(r.label); return { ci: mapCI(r.props), relation: r.relation } })
  })
}

async function certificateDependents(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props; label: string; relation: string }>(session,
      `MATCH (n:Certificate {id: $id})<-[r:DEPENDS_ON|HOSTED_ON|INSTALLED_ON|USES_CERTIFICATE]-(d)
       WHERE d.tenant_id = $tenantId
       RETURN properties(d) AS props, labels(d)[0] AS label, type(r) AS relation
       ORDER BY d.name`,
      { id: parent.id, tenantId: ctx.tenantId }
    )
    return rows.map((r) => { r.props['type'] = labelToType(r.label); return { ci: mapCI(r.props), relation: r.relation } })
  })
}

export const certificateResolvers = {
  Query: { certificates, certificate },
  Certificate: {
    ...CERT_FIELD_RESOLVERS,
    dependencies: certificateDependencies,
    dependents:   certificateDependents,
  },
}
