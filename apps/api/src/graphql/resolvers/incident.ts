import { GraphQLError } from 'graphql'
import type { GraphQLResolveInfo } from 'graphql'
import { v4 as uuidv4 } from 'uuid'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import { mapCI, ciTypeFromLabels, withSession } from './ci-utils.js'
import { mapUser, mapTeam, mapIncident } from '../../lib/mappers.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { getScalarFields } from '../../lib/schemaFields.js'
import type { GraphQLContext } from '../../context.js'
import * as incidentService from '../../services/incidentService.js'
export type { IncidentEventPayload } from '../../services/incidentService.js'

// ── Mapper ───────────────────────────────────────────────────────────────────

type Props = Record<string, unknown>

// ── Query resolvers ──────────────────────────────────────────────────────────

async function incidents(
  _: unknown,
  args: { status?: string; severity?: string; limit?: number; offset?: number; filters?: string },
  ctx: GraphQLContext,
  info: GraphQLResolveInfo,
) {
  const { status, severity, limit = 50, offset = 0, filters } = args

  return withSession(async (session) => {
    const params: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      status:   status   ?? null,
      severity: severity ?? null,
      offset,
      limit,
    }
    const allowedFields = getScalarFields(info.schema, 'Incident')
    const advWhere = filters ? buildAdvancedWhere(filters, params, allowedFields, 'i') : ''
    const whereClause = `
      WHERE ($status   IS NULL OR i.status   = $status)
        AND ($severity IS NULL OR i.severity = $severity)
        ${advWhere ? `AND (${advWhere})` : ''}
    `
    const itemRows = await runQuery<{ props: Props; uProps: Props | null; tProps: Props | null; cis: Array<{ props: Props; label: string }> }>(session, `
      MATCH (i:Incident {tenant_id: $tenantId})
      ${whereClause}
      OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(u:User)
      OPTIONAL MATCH (i)-[:ASSIGNED_TO_TEAM]->(t:Team)
      WITH i, u, t ORDER BY i.created_at DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
      OPTIONAL MATCH (i)-[:AFFECTED_BY]->(ci)
      WITH i, u, t, collect(DISTINCT {props: properties(ci), label: labels(ci)[0]}) AS cis
      RETURN properties(i) AS props, properties(u) AS uProps, properties(t) AS tProps, cis
    `, params)
    const countRows = await runQuery<{ total: number }>(session, `
      MATCH (i:Incident {tenant_id: $tenantId})
      ${whereClause}
      RETURN count(i) AS total
    `, params)
    return {
      items: itemRows.map((r) => {
        const base = mapIncident(r.props) as ReturnType<typeof mapIncident> & { _prefetched: boolean }
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

async function incident(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      RETURN properties(i) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: args.id,
      tenantId: ctx.tenantId,
    })
    return row ? mapIncident(row.props) : null
  })
}

// ── Mutation resolvers ───────────────────────────────────────────────────────

async function createIncident(
  _: unknown,
  args: { input: { title: string; description?: string; severity: string; affectedCIIds?: string[] } },
  ctx: GraphQLContext,
) {
  return incidentService.createIncident(args.input, ctx)
}

async function updateIncident(
  _: unknown,
  args: { id: string; input: { title?: string; description?: string; severity?: string; status?: string } },
  ctx: GraphQLContext,
) {
  const { id, input } = args
  const now = new Date().toISOString()

  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      SET i += {
        title:       coalesce($title, i.title),
        description: coalesce($description, i.description),
        severity:    coalesce($severity, i.severity),
        status:      coalesce($status, i.status),
        updated_at:  $now
      }
      RETURN properties(i) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id,
      tenantId:    ctx.tenantId,
      title:       input.title       ?? null,
      description: input.description ?? null,
      severity:    input.severity    ?? null,
      status:      input.status      ?? null,
      now,
    })
    const row = rows[0]
    if (!row) throw new GraphQLError('Incident not found')
    return mapIncident(row.props)
  }, true)
}

async function resolveIncident(
  _: unknown,
  args: { id: string; rootCause?: string },
  ctx: GraphQLContext,
) {
  return incidentService.resolveIncident(args.id, ctx, args.rootCause)
}

async function assignIncidentToTeam(
  _: unknown,
  args: { id: string; teamId: string },
  ctx: GraphQLContext,
) {
  return incidentService.assignIncidentToTeam(args.id, args.teamId, ctx)
}

async function assignIncidentToUser(
  _: unknown,
  args: { id: string; userId: string | null },
  ctx: GraphQLContext,
) {
  return incidentService.assignIncidentToUser(args.id, args.userId, ctx)
}

async function addAffectedCI(
  _: unknown,
  args: { incidentId: string; ciId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      WHERE (ci:Application OR ci:Database OR ci:DatabaseInstance OR ci:Server OR ci:Certificate)
      MERGE (i)-[:AFFECTED_BY]->(ci)
      SET i.updated_at = $now
    `, { incidentId: args.incidentId, ciId: args.ciId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    const r = await session.executeRead((tx) => tx.run(
      `MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props`,
      { id: args.incidentId, tenantId: ctx.tenantId },
    ))
    const row = r.records[0]
    if (!row) throw new GraphQLError('Incident not found')
    return mapIncident(row.get('props') as Props)
  }, true)
}

async function removeAffectedCI(
  _: unknown,
  args: { incidentId: string; ciId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await session.executeWrite((tx) => tx.run(`
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
            -[r:AFFECTED_BY]->(ci {id: $ciId, tenant_id: $tenantId})
      DELETE r
      SET i.updated_at = $now
    `, { incidentId: args.incidentId, ciId: args.ciId, tenantId: ctx.tenantId, now: new Date().toISOString() }))
    const r = await session.executeRead((tx) => tx.run(
      `MATCH (i:Incident {id: $id, tenant_id: $tenantId}) RETURN properties(i) AS props`,
      { id: args.incidentId, tenantId: ctx.tenantId },
    ))
    const row = r.records[0]
    if (!row) throw new GraphQLError('Incident not found')
    return mapIncident(row.get('props') as Props)
  }, true)
}

async function addIncidentComment(
  _: unknown,
  args: { id: string; text: string },
  ctx: GraphQLContext,
) {
  const commentId = uuidv4()
  const now       = new Date().toISOString()

  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      CREATE (c:Comment {
        id:         $commentId,
        tenant_id:  $tenantId,
        text:       $text,
        author_id:  $userId,
        created_at: $now,
        updated_at: $now
      })
      CREATE (i)-[:HAS_COMMENT]->(c)
      RETURN properties(c) AS cProps, properties(u) AS uProps
    `
    const rows = await runQuery<{ cProps: Props; uProps: Props }>(session, cypher, {
      id: args.id, tenantId: ctx.tenantId, userId: ctx.userId, commentId, text: args.text, now,
    })
    const row = rows[0]
    if (!row) throw new GraphQLError('Incident not found')
    return {
      id:        row.cProps['id']         as string,
      text:      row.cProps['text']       as string,
      createdAt: row.cProps['created_at'] as string,
      updatedAt: row.cProps['updated_at'] as string,
      author:    mapUser(row.uProps),
    }
  }, true)
}

// ── Field resolvers ──────────────────────────────────────────────────────────

async function incidentAssignedTeam(
  parent: { id: string; tenantId: string; assignedTeam?: unknown; _prefetched?: boolean },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (parent._prefetched) return parent.assignedTeam ?? null
  return withSession(async (session) => {
    const result = await session.executeRead((tx) => tx.run(`
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:ASSIGNED_TO_TEAM]->(t:Team)
      RETURN t
    `, { id: parent.id, tenantId: ctx.tenantId }))
    if (!result.records.length) return null
    const t = result.records[0]!.get('t').properties as Props
    return mapTeam(t)
  })
}

async function incidentAssignee(
  parent: { id: string; tenantId: string; assignee?: unknown; _prefetched?: boolean },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (parent._prefetched) return parent.assignee ?? null
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:ASSIGNED_TO]->(u:User)
      RETURN properties(u) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return row ? mapUser(row.props) : null
  })
}

async function incidentAffectedCIs(
  parent: { id: string; tenantId: string; _prefetched?: boolean },
  _: unknown,
  ctx: GraphQLContext,
) {
  if (parent._prefetched) return (parent as unknown as { affectedCIs: unknown[] }).affectedCIs
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:AFFECTED_BY]->(ci)
      WHERE ci.tenant_id = $tenantId
      RETURN properties(ci) as props, labels(ci)[0] AS label
    `
    const rows = await runQuery<{ props: Props; label: string }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return rows.map((r) => {
      const t = ciTypeFromLabels([r.label])
      r.props['type'] = t
      const ci = mapCI(r.props) as Record<string, unknown>
      ci['ciType']     = t
      ci['__typename'] = r.label || 'Application'
      return ci
    })
  })
}

async function incidentComments(
  parent: { id: string; tenantId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_COMMENT]->(c:Comment)
      OPTIONAL MATCH (u:User {id: c.author_id, tenant_id: $tenantId})
      RETURN properties(c) AS cProps, properties(u) AS uProps
      ORDER BY c.created_at ASC
    `
    const rows = await runQuery<{ cProps: Props; uProps: Props | null }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return rows.map((r) => ({
      id:        r.cProps['id']         as string,
      text:      r.cProps['text']       as string,
      createdAt: r.cProps['created_at'] as string,
      updatedAt: r.cProps['updated_at'] as string,
      author:    r.uProps ? mapUser(r.uProps) : null,
    }))
  })
}

async function incidentCausedByProblem(
  parent: { id: string; tenantId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:CAUSED_BY]->(p:Problem)
      RETURN properties(p) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    if (!row) return null
    const p = row.props
    return {
      id: p['id'], tenantId: p['tenant_id'], title: p['title'],
      description: p['description'], status: p['status'], impact: p['impact'],
      rootCause: p['root_cause'], workaround: p['workaround'],
      createdAt: p['created_at'], updatedAt: p['updated_at'], resolvedAt: p['resolved_at'],
      relatedIncidents: [], resolvedByChange: null,
    }
  })
}

// ── Export ───────────────────────────────────────────────────────────────────

export const incidentResolvers = {
  Query: { incidents, incident },
  Mutation: { createIncident, updateIncident, resolveIncident, assignIncidentToTeam, assignIncidentToUser, addIncidentComment, addAffectedCI, removeAffectedCI },
  Incident: {
    assignee:        incidentAssignee,
    assignedTeam:    incidentAssignedTeam,
    affectedCIs:     incidentAffectedCIs,
    causedByProblem: incidentCausedByProblem,
    comments:        incidentComments,
  },
}
