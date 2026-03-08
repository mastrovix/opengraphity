import { v4 as uuidv4 } from 'uuid'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { publish } from '@opengraphity/events'
import type { DomainEvent } from '@opengraphity/types'
import type { GraphQLContext } from '../../context.js'

type Props = Record<string, unknown>

function mapRequest(props: Props) {
  return {
    id:          props['id']           as string,
    tenantId:    props['tenant_id']    as string,
    title:       props['title']        as string,
    description: props['description']  as string | undefined,
    status:      props['status']       as string,
    priority:    props['priority']     as string,
    dueDate:     props['due_date']     as string | undefined,
    completedAt: props['completed_at'] as string | undefined,
    createdAt:   props['created_at']   as string,
    updatedAt:   props['updated_at']   as string,
    requestedBy: null,
    assignee:    null,
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

async function withSession<T>(fn: (s: ReturnType<typeof getSession>) => Promise<T>, write = false): Promise<T> {
  const session = getSession(undefined, write ? 'WRITE' : 'READ')
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

// ── Query resolvers ──────────────────────────────────────────────────────────

async function serviceRequests(
  _: unknown,
  args: { status?: string; priority?: string; limit?: number; offset?: number },
  ctx: GraphQLContext,
) {
  const { status, priority, limit = 20, offset = 0 } = args
  return withSession(async (session) => {
    const cypher = `
      MATCH (r:ServiceRequest {tenant_id: $tenantId})
      WHERE ($status   IS NULL OR r.status   = $status)
        AND ($priority IS NULL OR r.priority = $priority)
      WITH r ORDER BY r.created_at DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
      RETURN properties(r) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      tenantId: ctx.tenantId,
      status:   status   ?? null,
      priority: priority ?? null,
      offset,
      limit,
    })
    return rows.map((r) => mapRequest(r.props))
  })
}

async function serviceRequest(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})
      RETURN properties(r) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: args.id, tenantId: ctx.tenantId,
    })
    return row ? mapRequest(row.props) : null
  })
}

// ── Mutation resolvers ───────────────────────────────────────────────────────

async function createServiceRequest(
  _: unknown,
  args: { input: { title: string; description?: string; priority: string; dueDate?: string } },
  ctx: GraphQLContext,
) {
  const { input } = args
  const id  = uuidv4()
  const now = new Date().toISOString()

  const created = await withSession(async (session) => {
    // Create the node
    const createCypher = `
      CREATE (r:ServiceRequest {
        id:          $id,
        tenant_id:   $tenantId,
        title:       $title,
        description: $description,
        status:      'open',
        priority:    $priority,
        due_date:    $dueDate,
        created_at:  $now,
        updated_at:  $now
      })
      RETURN properties(r) as props
    `
    const rows = await runQuery<{ props: Props }>(session, createCypher, {
      id,
      tenantId:    ctx.tenantId,
      title:       input.title,
      description: input.description ?? null,
      priority:    input.priority,
      dueDate:     input.dueDate     ?? null,
      now,
    })
    const row = rows[0]
    if (!row) throw new Error('Failed to create service request')

    // Link to requester if the User node exists
    await runQuery(session, `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      FOREACH (_ IN CASE WHEN u IS NOT NULL THEN [1] ELSE [] END |
        MERGE (r)-[:REQUESTED_BY]->(u)
      )
    `, { id, tenantId: ctx.tenantId, userId: ctx.userId })

    return mapRequest(row.props)
  }, true)

  const event: DomainEvent<{ id: string; title: string; priority: string }> = {
    id:             uuidv4(),
    type:           'request.created',
    tenant_id:      ctx.tenantId,
    timestamp:      now,
    correlation_id: uuidv4(),
    actor_id:       ctx.userId,
    payload:        { id, title: input.title, priority: input.priority },
  }
  await publish(event)

  return created
}

async function updateServiceRequest(
  _: unknown,
  args: { id: string; input: { title?: string; description?: string; priority?: string; dueDate?: string } },
  ctx: GraphQLContext,
) {
  const { id, input } = args
  const now = new Date().toISOString()

  return withSession(async (session) => {
    const cypher = `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})
      SET r += {
        title:       coalesce($title,       r.title),
        description: coalesce($description, r.description),
        priority:    coalesce($priority,    r.priority),
        due_date:    coalesce($dueDate,     r.due_date),
        updated_at:  $now
      }
      RETURN properties(r) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id,
      tenantId:    ctx.tenantId,
      title:       input.title       ?? null,
      description: input.description ?? null,
      priority:    input.priority    ?? null,
      dueDate:     input.dueDate     ?? null,
      now,
    })
    const row = rows[0]
    if (!row) throw new Error('ServiceRequest not found')
    return mapRequest(row.props)
  }, true)
}

async function completeServiceRequest(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  const now = new Date().toISOString()

  const completed = await withSession(async (session) => {
    const cypher = `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})
      SET r.status       = 'completed',
          r.completed_at = $now,
          r.updated_at   = $now
      RETURN properties(r) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, {
      id: args.id, tenantId: ctx.tenantId, now,
    })
    const row = rows[0]
    if (!row) throw new Error('ServiceRequest not found')
    return mapRequest(row.props)
  }, true)

  const event: DomainEvent<{ id: string; completed_at: string }> = {
    id:             uuidv4(),
    type:           'request.completed',
    tenant_id:      ctx.tenantId,
    timestamp:      now,
    correlation_id: uuidv4(),
    actor_id:       ctx.userId,
    payload:        { id: args.id, completed_at: now },
  }
  await publish(event)

  return completed
}

// ── Field resolvers ──────────────────────────────────────────────────────────

async function requestRequestedBy(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})-[:REQUESTED_BY]->(u:User)
      RETURN properties(u) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return row ? mapUser(row.props) : null
  })
}

async function requestAssignee(
  parent: { id: string },
  _: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const cypher = `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})-[:ASSIGNED_TO]->(u:User)
      RETURN properties(u) as props
    `
    const row = await runQueryOne<{ props: Props }>(session, cypher, {
      id: parent.id, tenantId: ctx.tenantId,
    })
    return row ? mapUser(row.props) : null
  })
}

// ── Export ───────────────────────────────────────────────────────────────────

export const serviceRequestResolvers = {
  Query:    { serviceRequests, serviceRequest },
  Mutation: { createServiceRequest, updateServiceRequest, completeServiceRequest },
  ServiceRequest: {
    requestedBy: requestRequestedBy,
    assignee:    requestAssignee,
  },
}
