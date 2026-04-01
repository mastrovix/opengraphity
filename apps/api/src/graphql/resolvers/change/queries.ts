import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { GraphQLResolveInfo } from 'graphql'
import { withSession, mapCI, ciTypeFromLabels } from '../ci-utils.js'
import type { GraphQLContext } from '../../../context.js'
import { mapChange, mapChangeTask, mapUser, mapTeam, type Props } from './mappers.js'
import { buildAdvancedWhere } from '../../../lib/filterBuilder.js'
import { getScalarFields } from '../../../lib/schemaFields.js'

export async function changes(
  _: unknown,
  args: { status?: string; type?: string; priority?: string; search?: string; limit?: number; offset?: number; filters?: string },
  ctx: GraphQLContext,
  info: GraphQLResolveInfo,
) {
  const { status, type, priority, search, limit = 50, offset = 0, filters } = args
  return withSession(async (session) => {
    const params: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      status:   status   ?? null,
      type:     type     ?? null,
      priority: priority ?? null,
      search:   search   ?? null,
      offset,
      limit,
    }
    const allowedFields = getScalarFields(info.schema, 'Change')
    const advWhere = filters ? buildAdvancedWhere(filters, params, allowedFields, 'c') : ''
    const whereClause = `
      WHERE ($status   IS NULL OR c.status   = $status)
        AND ($type     IS NULL OR c.type     = $type)
        AND ($priority IS NULL OR c.priority = $priority)
        AND ($search   IS NULL OR toLower(c.title) CONTAINS toLower($search))
        ${advWhere ? `AND (${advWhere})` : ''}
    `
    const itemRows = await runQuery<{ props: Props; uProps: Props | null; tProps: Props | null; cis: Array<{ props: Props; label: string }> }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})
      ${whereClause}
      OPTIONAL MATCH (c)-[:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (c)-[:ASSIGNED_TO_TEAM]->(t:Team)
      WITH c, u, t ORDER BY c.created_at DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
      OPTIONAL MATCH (c)-[:AFFECTS]->(ci)
      WITH c, u, t, collect(DISTINCT {props: properties(ci), label: labels(ci)[0]}) AS cis
      RETURN properties(c) AS props, properties(u) AS uProps, properties(t) AS tProps, cis
    `, params)
    const countRows = await runQuery<{ total: number }>(session, `
      MATCH (c:Change {tenant_id: $tenantId})
      ${whereClause}
      RETURN count(c) AS total
    `, params)
    return {
      items: itemRows.map((r) => {
        const base = mapChange(r.props) as ReturnType<typeof mapChange> & { _prefetched: boolean }
        base.assignee     = r.uProps ? mapUser(r.uProps) as unknown as null : null
        base.assignedTeam = r.tProps ? mapTeam(r.tProps) as unknown as null : null
        base.affectedCIs  = r.cis
          .filter((c) => c.props && c.props['id'])
          .map((c) => {
            const t = ciTypeFromLabels([c.label])
            c.props['type'] = t
            const ci = mapCI(c.props) as Record<string, unknown>
            ci['ciType']     = t
            ci['__typename'] = c.label || 'Application'
            return ci
          }) as unknown as []
        base._prefetched = true
        return base
      }),
      total: (countRows[0]?.total as unknown as { toNumber(): number })?.toNumber?.() ?? Number(countRows[0]?.total ?? 0),
    }
  })
}

export async function change(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      RETURN properties(c) as props
    `, { id: args.id, tenantId: ctx.tenantId })
    return row ? mapChange(row.props) : null
  })
}

export async function changeTasksQuery(
  _: unknown,
  args: { changeId: string; taskType?: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const filter = args.taskType ? 'AND t.task_type = $taskType' : ''
    const r = await session.executeRead((tx) => tx.run(`
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})-[:HAS_CHANGE_TASK]->(t:ChangeTask)
      WHERE true ${filter}
      OPTIONAL MATCH (t)-[:ASSESSES]->(ci)
      OPTIONAL MATCH (t)-[:ASSIGNED_TO_TEAM]->(team:Team)
      OPTIONAL MATCH (t)-[:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (t)-[:VALIDATION_ASSIGNED_TO_TEAM]->(vt:Team)
      OPTIONAL MATCH (t)-[:VALIDATION_ASSIGNED_TO]->(vu:User)
      RETURN properties(t) AS tProps, properties(ci) AS ciProps,
             properties(team) AS teamProps, properties(u) AS uProps,
             properties(vt) AS vtProps, properties(vu) AS vuProps
      ORDER BY t.task_type ASC, t.order ASC
    `, { changeId: args.changeId, tenantId: ctx.tenantId, taskType: args.taskType ?? null }))
    return r.records.map((rec) => mapChangeTask(
      rec.get('tProps') as Props,
      rec.get('ciProps') as Props | null,
      rec.get('teamProps') as Props | null,
      rec.get('uProps') as Props | null,
      rec.get('vtProps') as Props | null,
      rec.get('vuProps') as Props | null,
    ))
  })
}
