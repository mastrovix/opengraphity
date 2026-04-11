import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../../context.js'
import { buildAdvancedWhere } from '../../../lib/filterBuilder.js'
import { type Props, mapCategory, mapEntry, toInt } from './helpers.js'

export async function changeCatalogCategories(_: unknown, __: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    type Row = { props: Props; cnt: unknown }
    const rows = await runQuery<Row>(session, `
      MATCH (c:ChangeCatalogCategory {tenant_id: $tenantId})
      OPTIONAL MATCH (c)<-[:BELONGS_TO_CATEGORY]-(e:StandardChangeCatalogEntry {tenant_id: $tenantId, enabled: true})
      RETURN properties(c) AS props, count(e) AS cnt
      ORDER BY props.order ASC, props.name ASC
    `, { tenantId: ctx.tenantId })
    return rows.map((r) => mapCategory(r.props, toInt(r.cnt)))
  } finally {
    await session.close()
  }
}

export async function changeCatalogCategory(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const session = getSession()
  try {
    type Row = { props: Props; cnt: unknown }
    const row = await runQueryOne<Row>(session, `
      MATCH (c:ChangeCatalogCategory {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (c)<-[:BELONGS_TO_CATEGORY]-(e:StandardChangeCatalogEntry {tenant_id: $tenantId, enabled: true})
      RETURN properties(c) AS props, count(e) AS cnt
    `, { id: args.id, tenantId: ctx.tenantId })
    return row ? mapCategory(row.props, toInt(row.cnt)) : null
  } finally {
    await session.close()
  }
}

export async function standardChangeCatalog(
  _: unknown,
  args: { categoryId?: string; search?: string; filters?: string; sortField?: string; sortDirection?: string },
  ctx: GraphQLContext,
) {
  const session = getSession()
  try {
    const params: Record<string, unknown> = { tenantId: ctx.tenantId }
    const conditions: string[] = ['e.tenant_id = $tenantId']

    if (args.categoryId) {
      conditions.push('e.category_id = $categoryId')
      params['categoryId'] = args.categoryId
    }
    if (args.search) {
      conditions.push('(toLower(e.name) CONTAINS toLower($search) OR toLower(e.description) CONTAINS toLower($search))')
      params['search'] = args.search
    }
    if (args.filters) {
      const allowedFields = new Set(['name', 'risk_level', 'impact', 'default_priority', 'enabled', 'category_id', 'requires_downtime'])
      const filterClause = buildAdvancedWhere(args.filters, params, allowedFields, 'e')
      if (filterClause) {
        conditions.push(filterClause)
      }
    }

    const sortMap: Record<string, string> = {
      name: 'e.name', riskLevel: 'e.risk_level', impact: 'e.impact',
      usageCount: 'e.usage_count', createdAt: 'e.created_at', updatedAt: 'e.updated_at',
    }
    const orderBy = sortMap[args.sortField ?? ''] ?? 'e.name'
    const orderDir = args.sortDirection === 'desc' ? 'DESC' : 'ASC'

    type Row = { props: Props }
    const rows = await runQuery<Row>(session, `
      MATCH (e:StandardChangeCatalogEntry)
      WHERE ${conditions.join(' AND ')}
      RETURN properties(e) AS props
      ORDER BY ${orderBy} ${orderDir}
    `, params)
    return rows.map((r) => mapEntry(r.props))
  } finally {
    await session.close()
  }
}

export async function standardChangeCatalogEntry(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const session = getSession()
  try {
    type Row = { props: Props }
    const row = await runQueryOne<Row>(session, `
      MATCH (e:StandardChangeCatalogEntry {id: $id, tenant_id: $tenantId})
      RETURN properties(e) AS props
    `, { id: args.id, tenantId: ctx.tenantId })
    return row ? mapEntry(row.props) : null
  } finally {
    await session.close()
  }
}
