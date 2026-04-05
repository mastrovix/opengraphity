import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import neo4j from 'neo4j-driver'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'

const LOGS_ALLOWED_FIELDS = new Set(['message', 'level', 'module', 'timestamp'])

type LogsArgs = {
  level?:   string
  module?:  string
  search?:  string
  limit?:   number
  offset?:  number
  filters?: string
}

async function logs(
  _: unknown,
  { level, module, search, limit = 50, offset = 0, filters }: LogsArgs,
  ctx: GraphQLContext,
) {
  if (ctx.role !== 'admin') {
    throw new Error('Forbidden: logs are only accessible to admins')
  }

  const params: Record<string, unknown> = {
    tenantId: ctx.tenantId,
    level:  level  ?? null,
    module: module ?? null,
    search: search ?? null,
  }
  const advWhere = filters ? buildAdvancedWhere(filters, params, LOGS_ALLOWED_FIELDS, 'l') : ''

  const baseWhere = `
    WHERE l.tenant_id IN [$tenantId, 'system']
      AND ($level  IS NULL OR l.level  = $level)
      AND ($module IS NULL OR l.module = $module)
      AND ($search IS NULL OR toLower(l.message) CONTAINS toLower($search))
      ${advWhere ? `AND (${advWhere})` : ''}
  `

  const s1 = getSession(undefined, 'READ')
  const s2 = getSession(undefined, 'READ')
  try {
    const [dataResult, countResult] = await Promise.all([
      s1.executeRead((tx) =>
        tx.run(
          `MATCH (l:LogEntry)
           ${baseWhere}
           RETURN l
           ORDER BY l.timestamp DESC
           SKIP $offset LIMIT $limit`,
          { ...params, offset: neo4j.int(offset), limit: neo4j.int(limit) },
        ),
      ),
      s2.executeRead((tx) =>
        tx.run(
          `MATCH (l:LogEntry)
           ${baseWhere}
           RETURN count(l) AS total`,
          params,
        ),
      ),
    ])

    const entries = dataResult.records.map((r) => {
      const p = r.get('l').properties as Record<string, unknown>
      return {
        id:        p['id']        as string,
        timestamp: p['timestamp'] as string,
        level:     p['level']     as string,
        module:    (p['module']   ?? null) as string | null,
        message:   p['message']   as string,
        data:      (p['data']     ?? null) as string | null,
      }
    })

    const total = (countResult.records[0]?.get('total') as { toNumber(): number } | undefined)?.toNumber() ?? 0

    return { entries, total }
  } finally {
    await Promise.all([s1.close(), s2.close()])
  }
}

export const logsResolvers = {
  Query: { logs },
}
