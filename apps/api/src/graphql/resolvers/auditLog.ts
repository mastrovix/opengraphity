import { GraphQLError } from 'graphql'
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { logger } from '../../lib/logger.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'

interface AuditEntry {
  id:         string
  userId:     string
  userEmail:  string
  action:     string
  entityType: string
  entityId:   string
  details:    string | null
  ipAddress:  string | null
  createdAt:  string
}

function mapAuditEntry(r: { get: (k: string) => unknown }): AuditEntry {
  return {
    id:         r.get('id')         as string,
    userId:     r.get('userId')     as string,
    userEmail:  r.get('userEmail')  as string,
    action:     r.get('action')     as string,
    entityType: r.get('entityType') as string,
    entityId:   r.get('entityId')   as string,
    details:    r.get('details')    as string | null,
    ipAddress:  r.get('ipAddress')  as string | null,
    createdAt:  r.get('createdAt')  as string,
  }
}

export async function auditLog(
  _: unknown,
  args: {
    page?: number
    pageSize?: number
    filters?: string
    sortField?: string
    sortDirection?: string
  },
  ctx: GraphQLContext,
): Promise<{ items: AuditEntry[]; total: number }> {
  if (ctx.role !== 'admin') {
    throw new GraphQLError('Forbidden: admin role required', { extensions: { code: 'FORBIDDEN' } })
  }

  const page     = Math.max(1, args.page     ?? 1)
  const pageSize = Math.min(100, Math.max(1, args.pageSize ?? 50))
  const skip     = (page - 1) * pageSize

  const conditions: string[] = ['a.tenant_id = $tenantId']
  const params: Record<string, unknown> = { tenantId: ctx.tenantId, skip, limit: pageSize }

  // Advanced filters from FilterBuilder
  const allowed = new Set(['action', 'entityType', 'entity_type', 'userEmail', 'user_email', 'createdAt', 'created_at'])
  const advWhere = args.filters ? buildAdvancedWhere(args.filters, params, allowed, 'a') : ''
  if (advWhere) conditions.push(`(${advWhere})`)

  const where = conditions.join(' AND ')

  logger.debug(
    { tenantId: ctx.tenantId, page, pageSize, skip, where },
    '[auditLog] query params',
  )

  const session = getSession(undefined, 'READ')
  try {
    const dataRes = await session.executeRead((tx) =>
      tx.run(`
        MATCH (a:AuditEntry)
        WHERE ${where}
        RETURN a.id         AS id,
               a.user_id    AS userId,
               a.user_email AS userEmail,
               a.action     AS action,
               a.entity_type AS entityType,
               a.entity_id  AS entityId,
               a.details    AS details,
               a.ip_address AS ipAddress,
               a.created_at AS createdAt
        ORDER BY ${(() => { const m: Record<string, string> = { action: 'a.action', entityType: 'a.entity_type', userEmail: 'a.user_email', createdAt: 'a.created_at' }; return m[args.sortField ?? ''] ?? 'a.created_at' })()} ${args.sortDirection === 'asc' ? 'ASC' : 'DESC'}
        SKIP toInteger($skip) LIMIT toInteger($limit)
      `, params),
    )

    logger.debug({ count: dataRes.records.length, tenantId: ctx.tenantId }, '[auditLog] data rows returned')

    const countRes = await session.executeRead((tx) =>
      tx.run(`
        MATCH (a:AuditEntry)
        WHERE ${where}
        RETURN count(a) AS total
      `, params),
    )

    const rawTotal = countRes.records[0]?.get('total')
    const total = rawTotal != null && typeof (rawTotal as { toNumber(): number }).toNumber === 'function'
      ? (rawTotal as { toNumber(): number }).toNumber()
      : Number(rawTotal ?? 0)

    return {
      items: dataRes.records.map(mapAuditEntry),
      total,
    }
  } finally {
    await session.close()
  }
}
