import { v4 as uuidv4 } from 'uuid'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { publish } from '@opengraphity/events'
import type { DomainEvent, IncidentCreatedPayload, IncidentResolvedPayload } from '@opengraphity/types'
import type { GraphQLContext } from '../../context.js'

// ── Mapper ───────────────────────────────────────────────────────────────────

type Props = Record<string, unknown>

function mapIncident(props: Props) {
  return {
    id:              props['id']          as string,
    tenantId:        props['tenant_id']   as string,
    title:           props['title']       as string,
    description:     props['description'] as string | undefined,
    severity:        props['severity']    as string,
    status:          props['status']      as string,
    createdAt:       props['created_at']  as string,
    updatedAt:       props['updated_at']  as string,
    resolvedAt:      props['resolved_at'] as string | undefined,
    // Populated by field resolvers
    assignee:        null,
    affectedCIs:     [],
    causedByProblem: null,
  }
}

function mapCI(props: Props) {
  return {
    id:          props['id']          as string,
    tenantId:    props['tenant_id']   as string,
    name:        props['name']        as string,
    type:        props['type']        as string,
    status:      props['status']      as string,
    environment: props['environment'] as string,
    createdAt:   props['created_at']  as string,
    updatedAt:   props['updated_at']  as string,
    dependencies: [],
    dependents:   [],
  }
}

function mapUser(props: Props) {
  return {
    id:       props['id']        as string,
    tenantId: props['tenant_id'] as string,
    email:    props['email']     as string,
    name:     props['name']      as string,
    role:     props['role']      as string,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function withSession<T>(fn: (s: ReturnType<typeof getSession>) => Promise<T>): Promise<T> {
  const session = getSession()
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

// ── Query resolvers ──────────────────────────────────────────────────────────

async function incidents(
  _: unknown,
  args: { status?: string; severity?: string; limit?: number; offset?: number },
  ctx: GraphQLContext,
) {
  const { status, severity, limit = 20, offset = 0 } = args

  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {tenant_id: $tenantId})
      WHERE ($status IS NULL OR i.status = $status)
        AND ($severity IS NULL OR i.severity = $severity)
      WITH i ORDER BY i.created_at DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
      RETURN properties(i) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      tenantId: ctx.tenantId,
      status: status ?? null,
      severity: severity ?? null,
      offset,
      limit,
    })
    return rows.map((r) => mapIncident(r.props))
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
  const { input } = args
  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    const cypher = `
      CREATE (i:Incident {
        id:           $id,
        tenant_id:    $tenantId,
        title:        $title,
        description:  $description,
        severity:     $severity,
        status:       'open',
        created_at:   $now,
        updated_at:   $now
      })
      RETURN properties(i) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id,
      tenantId:    ctx.tenantId,
      title:       input.title,
      description: input.description ?? null,
      severity:    input.severity,
      now,
    })
    const row = rows[0]
    if (!row) throw new Error('Failed to create incident')
    return mapIncident(row.props)
  })

  // Link affected CIs
  if (input.affectedCIIds?.length) {
    await withSession(async (session) => {
      for (const ciId of input.affectedCIIds!) {
        await runQuery(session, `
          MATCH (i:Incident {id: $id, tenant_id: $tenantId})
          MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
          MERGE (i)-[:AFFECTED_BY]->(ci)
        `, { id, tenantId: ctx.tenantId, ciId })
      }
    })
  }

  // Publish domain event
  const event: DomainEvent<IncidentCreatedPayload> = {
    id:             uuidv4(),
    type:           'incident.created',
    tenant_id:      ctx.tenantId,
    timestamp:      now,
    correlation_id: uuidv4(),
    actor_id:       ctx.userId,
    payload: {
      id,
      title:           input.title,
      severity:        input.severity as IncidentCreatedPayload['severity'],
      affected_ci_ids: input.affectedCIIds ?? [],
    },
  }
  await publish(event)

  return created
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
    if (!row) throw new Error('Incident not found')
    return mapIncident(row.props)
  })
}

async function resolveIncident(
  _: unknown,
  args: { id: string; rootCause?: string },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()

  const resolved = await withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      SET i.status = 'resolved', i.resolved_at = $now, i.updated_at = $now
      RETURN properties(i) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id: args.id,
      tenantId: ctx.tenantId,
      now,
    })
    const row = rows[0]
    if (!row) throw new Error('Incident not found')
    return mapIncident(row.props)
  })

  const event: DomainEvent<IncidentResolvedPayload> = {
    id:             uuidv4(),
    type:           'incident.resolved',
    tenant_id:      ctx.tenantId,
    timestamp:      now,
    correlation_id: uuidv4(),
    actor_id:       ctx.userId,
    payload: { id: args.id, resolved_at: now },
  }
  await publish(event)

  return resolved
}

async function assignIncident(
  _: unknown,
  args: { id: string; userId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      MERGE (i)-[:ASSIGNED_TO]->(u)
      RETURN properties(i) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id:       args.id,
      tenantId: ctx.tenantId,
      userId:   args.userId,
    })
    const row = rows[0]
    if (!row) throw new Error('Incident or User not found')
    return mapIncident(row.props)
  })
}

// ── Field resolvers ──────────────────────────────────────────────────────────

async function incidentAssignee(
  parent: { id: string; tenantId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
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
  parent: { id: string; tenantId: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:AFFECTED_BY]->(ci:ConfigurationItem)
      RETURN properties(ci) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return rows.map((r) => mapCI(r.props))
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
  Mutation: { createIncident, updateIncident, resolveIncident, assignIncident },
  Incident: {
    assignee:        incidentAssignee,
    affectedCIs:     incidentAffectedCIs,
    causedByProblem: incidentCausedByProblem,
  },
}
