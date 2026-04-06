import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { GraphQLResolveInfo } from 'graphql'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { mapUser } from '../../lib/mappers.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { getScalarFields } from '../../lib/schemaFields.js'
import * as requestService from '../../services/requestService.js'
import { audit } from '../../lib/audit.js'
import { validateRequiredFields } from '../../lib/validateRequiredFields.js'

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


// ── Query resolvers ──────────────────────────────────────────────────────────

async function serviceRequests(
  _: unknown,
  args: { status?: string; priority?: string; limit?: number; offset?: number; filters?: string },
  ctx: GraphQLContext,
  info: GraphQLResolveInfo,
) {
  const { status, priority, limit = 20, offset = 0, filters } = args
  return withSession(async (session) => {
    const params: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      status:   status   ?? null,
      priority: priority ?? null,
      offset,
      limit,
    }
    const allowedFields = getScalarFields(info.schema, 'ServiceRequest')
    const advWhere = filters ? buildAdvancedWhere(filters, params, allowedFields, 'r') : ''
    const cypher = `
      MATCH (r:ServiceRequest {tenant_id: $tenantId})
      WHERE ($status   IS NULL OR r.status   = $status)
        AND ($priority IS NULL OR r.priority = $priority)
        ${advWhere}
      WITH r ORDER BY r.created_at DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
      RETURN properties(r) as props
    `
    const rows = await runQuery<{ props: Props }>(session, cypher, params)
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
  return withSession(async (session) => {
    await validateRequiredFields(session, {
      entityType:  'service_request',
      fieldValues: args.input as Record<string, unknown>,
      tenantId:    ctx.tenantId,
    })
    const result = await requestService.createRequest(args.input, ctx)
    void audit(ctx, 'request.created', 'ServiceRequest', result.id as string)
    return result
  })
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
    void audit(ctx, 'request.updated', 'ServiceRequest', id)
    return mapRequest(row.props)
  }, true)
}

async function completeServiceRequest(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
) {
  const result = await requestService.completeRequest(args.id, ctx)
  void audit(ctx, 'request.resolved', 'ServiceRequest', args.id)
  return result
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
