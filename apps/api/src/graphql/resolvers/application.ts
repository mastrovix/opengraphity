import { withSession, mapApplication, CI_FIELD_RESOLVERS, runQuery, runQueryOne } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import type { Props } from './ci-utils.js'

const WHERE = `
  WHERE ($environment IS NULL OR n.environment = $environment)
    AND ($status IS NULL OR n.status = $status)
    AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))
`

async function applications(_: unknown, args: { limit?: number; offset?: number; environment?: string; status?: string; search?: string }, ctx: GraphQLContext) {
  const limit = args.limit ?? 50
  const offset = args.offset ?? 0
  const params = { tenantId: ctx.tenantId, environment: args.environment ?? null, status: args.status ?? null, search: args.search ?? null, limit, offset }
  return withSession(async (session) => {
    const items = await runQuery<{ props: Props }>(session,
      `MATCH (n:Application {tenant_id: $tenantId})
       ${WHERE}
       RETURN properties(n) AS props ORDER BY n.name ASC SKIP toInteger($offset) LIMIT toInteger($limit)`,
      params
    )
    const countResult = await runQuery<{ total: unknown }>(session,
      `MATCH (n:Application {tenant_id: $tenantId})
       ${WHERE}
       RETURN count(n) AS total`,
      params
    )
    const total = (countResult[0]?.total as { toNumber(): number })?.toNumber?.() ?? Number(countResult[0]?.total ?? 0)
    return { items: items.map((r) => mapApplication(r.props)), total }
  })
}

async function application(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session,
      `MATCH (n:Application {id: $id, tenant_id: $tenantId}) RETURN properties(n) AS props`,
      { id: args.id, tenantId: ctx.tenantId }
    )
    return row ? mapApplication(row.props) : null
  })
}

export const applicationResolvers = {
  Query: { applications, application },
  Application: CI_FIELD_RESOLVERS,
}
