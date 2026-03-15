import { withSession, mapCI, runQuery, runQueryOne } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import type { Props } from './ci-utils.js'

const WHERE = `
  WHERE ($type IS NULL OR n.type = $type)
    AND ($environment IS NULL OR n.environment = $environment)
    AND ($status IS NULL OR n.status = $status)
    AND ($search IS NULL OR toLower(n.name) CONTAINS toLower($search))
`

async function allCIs(_: unknown, args: { limit?: number; offset?: number; type?: string; environment?: string; status?: string; search?: string }, ctx: GraphQLContext) {
  const limit = args.limit ?? 50
  const offset = args.offset ?? 0
  const params = { tenantId: ctx.tenantId, type: args.type ?? null, environment: args.environment ?? null, status: args.status ?? null, search: args.search ?? null, limit, offset }
  return withSession(async (session) => {
    const items = await runQuery<{ props: Props }>(session,
      `MATCH (n:ConfigurationItem {tenant_id: $tenantId})
       ${WHERE}
       RETURN properties(n) AS props ORDER BY n.name ASC SKIP $offset LIMIT $limit`,
      params
    )
    const countResult = await runQuery<{ total: unknown }>(session,
      `MATCH (n:ConfigurationItem {tenant_id: $tenantId})
       ${WHERE}
       RETURN count(n) AS total`,
      params
    )
    const total = (countResult[0]?.total as { toNumber(): number })?.toNumber?.() ?? Number(countResult[0]?.total ?? 0)
    return { items: items.map((r) => mapCI(r.props)), total }
  })
}

async function ciById(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session,
      `MATCH (n:ConfigurationItem {id: $id, tenant_id: $tenantId}) RETURN properties(n) AS props`,
      { id: args.id, tenantId: ctx.tenantId }
    )
    return row ? mapCI(row.props) : null
  })
}

export const ciResolvers = {
  Query: { allCIs, ciById },
}
