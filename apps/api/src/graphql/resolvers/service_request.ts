import { NotFoundError, ValidationError } from '../../lib/errors.js'
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
import { requireRole } from '../../lib/requireRole.js'
import { v4 as uuidv4 } from 'uuid'

type Props = Record<string, unknown>

function mapRequest(props: Props) {
  return {
    id:          props['id']           as string,
    number:      (props['number'] ?? '') as string,
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
  args: { status?: string; priority?: string; limit?: number; offset?: number; filters?: string; sortField?: string; sortDirection?: string },
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
    const sortMap: Record<string, string> = { title: 'r.title', status: 'r.status', priority: 'r.priority', createdAt: 'r.created_at' }
    const orderBy = sortMap[args.sortField ?? ''] ?? 'r.created_at'
    const orderDir = args.sortDirection === 'asc' ? 'ASC' : 'DESC'
    const cypher = `
      MATCH (r:ServiceRequest {tenant_id: $tenantId})
      WHERE ($status   IS NULL OR r.status   = $status)
        AND ($priority IS NULL OR r.priority = $priority)
        ${advWhere}
      WITH r ORDER BY ${orderBy} ${orderDir}
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
  args: { input: { title: string; description?: string; priority: string; dueDate?: string; catalogItemId?: string } },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await validateRequiredFields(session, {
      entityType:  'service_request',
      fieldValues: args.input as Record<string, unknown>,
      tenantId:    ctx.tenantId,
    })
    // A request opened from a catalog item inherits its approval requirement.
    let requiresApproval = false
    if (args.input.catalogItemId) {
      const item = await runQueryOne<{ requiresApproval: boolean }>(session,
        'MATCH (ci:ServiceCatalogItem {id: $id, tenant_id: $tenantId}) RETURN ci.requires_approval AS requiresApproval',
        { id: args.input.catalogItemId, tenantId: ctx.tenantId })
      if (!item) throw new NotFoundError('ServiceCatalogItem', args.input.catalogItemId)
      requiresApproval = item.requiresApproval ?? false
    }
    const result = await requestService.createRequest({ ...args.input, requiresApproval }, ctx)
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
    if (!row) throw new NotFoundError('ServiceRequest')
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

// ── Service Catalog ───────────────────────────────────────────────────────────

function mapCatalogItem(props: Props) {
  return {
    id:               props['id'] as string,
    name:             props['name'] as string,
    description:      (props['description'] ?? null) as string | null,
    category:         (props['category'] ?? null) as string | null,
    requiresApproval: (props['requires_approval'] ?? false) as boolean,
    active:           (props['active'] ?? true) as boolean,
    createdAt:        props['created_at'] as string,
  }
}

async function serviceCatalogItems(_: unknown, args: { activeOnly?: boolean }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (ci:ServiceCatalogItem {tenant_id: $tenantId})
      ${args.activeOnly ? 'WHERE ci.active = true' : ''}
      RETURN properties(ci) AS props ORDER BY ci.category, ci.name
    `, { tenantId: ctx.tenantId })
    return rows.map((r) => mapCatalogItem(r.props))
  })
}

async function createServiceCatalogItem(_: unknown, args: { input: { name: string; description?: string; category?: string; requiresApproval?: boolean } }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const id = uuidv4(); const now = new Date().toISOString()
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (ci:ServiceCatalogItem {
        id: $id, tenant_id: $tenantId, name: $name, description: $description,
        category: $category, requires_approval: $requiresApproval, active: true, created_at: $now
      })
      RETURN properties(ci) AS props
    `, { id, tenantId: ctx.tenantId, name: args.input.name, description: args.input.description ?? null,
         category: args.input.category ?? null, requiresApproval: args.input.requiresApproval ?? false, now })
    void audit(ctx, 'service_catalog_item.created', 'ServiceCatalogItem', id)
    return mapCatalogItem(rows[0]!.props)
  }, true)
}

async function updateServiceCatalogItem(
  _: unknown,
  args: { id: string; input: { name?: string; description?: string; category?: string; requiresApproval?: boolean; active?: boolean } },
  ctx: GraphQLContext,
) {
  requireRole(ctx, 'admin')
  const { input } = args
  // Build a SET map with only the provided fields — undefined must not
  // overwrite existing values with null.
  const sets: Record<string, unknown> = {}
  if (input.name !== undefined)             sets['name']              = input.name
  if (input.description !== undefined)      sets['description']       = input.description
  if (input.category !== undefined)         sets['category']          = input.category
  if (input.requiresApproval !== undefined) sets['requires_approval'] = input.requiresApproval
  if (input.active !== undefined)           sets['active']            = input.active
  if (Object.keys(sets).length === 0) {
    throw new ValidationError('updateServiceCatalogItem: nessun campo da aggiornare')
  }
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (ci:ServiceCatalogItem {id: $id, tenant_id: $tenantId})
      SET ci += $sets
      RETURN properties(ci) AS props
    `, { id: args.id, tenantId: ctx.tenantId, sets })
    if (!rows[0]) throw new NotFoundError('ServiceCatalogItem', args.id)
    void audit(ctx, 'service_catalog_item.updated', 'ServiceCatalogItem', args.id)
    return mapCatalogItem(rows[0].props)
  }, true)
}

// ── Export ───────────────────────────────────────────────────────────────────

export const serviceRequestResolvers = {
  Query:    { serviceRequests, serviceRequest, serviceCatalogItems },
  Mutation: { createServiceRequest, updateServiceRequest, completeServiceRequest, createServiceCatalogItem, updateServiceCatalogItem },
  ServiceRequest: {
    requestedBy: requestRequestedBy,
    assignee:    requestAssignee,
  },
}
