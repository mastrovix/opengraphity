import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { requestCustomFieldDefs } from './ticketCustomFields.js'
import { customFieldValueMap, type CustomFieldInput } from '../../lib/ticketCustomFields.js'
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
import { isPortalOnly, requirePermission } from '../../lib/permissions.js'
import { v4 as uuidv4 } from 'uuid'

type Props = Record<string, unknown>

// Mapper unico in requestService (la copia locale perdeva catalogItemId e
// requiresApproval: dichiarati nello schema ma sempre null in lettura).
import { mapRequest } from '../../services/requestService.js'
import { assertMayAcknowledgeNoSla } from '../../lib/slaAcknowledgement.js'
import { ticketSlaStatusResolver } from './ticketSlaStatus.js'
import { publishTicketUpdated } from '../../lib/ticketUpdated.js'
import { assertDomainValue } from '../../lib/domainMatrix.js'
import { listPage } from '../../lib/listLimit.js'
import { setTicketUser } from '../../services/ticketAssignment.js'
import { roleHasPermission } from '../../lib/roles.js'


// ── Query resolvers ──────────────────────────────────────────────────────────

async function serviceRequests(
  _: unknown,
  args: { status?: string; priority?: string; limit?: number; offset?: number; filters?: string; sortField?: string; sortDirection?: string },
  ctx: GraphQLContext,
  info: GraphQLResolveInfo,
) {
  const { status, priority, filters } = args
  const { limit, offset } = listPage(args, 20)
  return withSession(async (session) => {
    const params: Record<string, unknown> = {
      tenantId: ctx.tenantId,
      status:   status   ?? null,
      priority: priority ?? null,
      offset,
      limit,
    }
    // I campi del cliente si filtrano come quelli del prodotto (ondata 4).
    const allowedFields = new Set([...getScalarFields(info.schema, 'ServiceRequest'), ...(await requestCustomFieldDefs(ctx, 'service_request')).map((d) => d.name)])
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
  args: { input: { title: string; description?: string; priority?: string | null; dueDate?: string; catalogItemId?: string; acknowledgeNoSla?: boolean | null; customFields?: CustomFieldInput[] | null } },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    await validateRequiredFields(session, {
      entityType:  'service_request',
      // Le regole di obbligatorietà valgono anche sui campi del cliente (ondata 4).
      fieldValues: { ...(args.input as Record<string, unknown>), ...customFieldValueMap(args.input.customFields) },
      tenantId:    ctx.tenantId,
    })
    // A request opened from a catalog item inherits its approval requirement
    // and its PRIORITY (verifica «Cosa resta cablato», ondata 1: il portale
    // mandava `medium` scritto nel codice). Un operatore può indicarne
    // un'altra; l'utente del portale no — la priorità la decide la voce.
    let requiresApproval = false
    let category: string | null = null
    let priority = args.input.priority ?? null
    if (args.input.catalogItemId) {
      const item = await runQueryOne<{ requiresApproval: boolean; priority: string | null; name: string; category: string | null }>(session,
        'MATCH (ci:ServiceCatalogItem {id: $id, tenant_id: $tenantId}) RETURN ci.requires_approval AS requiresApproval, ci.priority AS priority, ci.name AS name, ci.category AS category',
        { id: args.input.catalogItemId, tenantId: ctx.tenantId })
      if (!item) throw new NotFoundError('ServiceCatalogItem', args.input.catalogItemId)
      requiresApproval = item.requiresApproval ?? false
      // La categoria della richiesta è quella della voce (ondata 2): le policy SLA per categoria la usano.
      category = item.category ?? null
      if (isPortalOnly(ctx) && priority !== null && priority !== item.priority) {
        throw new ValidationError(
          'The priority of a request from the catalog is set by the catalog item, not by the requester.',
          { key: 'errors.serviceRequest.priorityFromCatalog' },
        )
      }
      if (priority === null) {
        if (!item.priority) {
          throw new ValidationError(
            `The catalog item "${item.name}" has no priority, so a request cannot be opened from it. An administrator sets it in Admin → Service catalog.`,
            { key: 'errors.serviceRequest.catalogItemWithoutPriority', params: { item: item.name } },
          )
        }
        priority = item.priority
      }
    }
    if (priority === null || priority.trim() === '') {
      throw new ValidationError('priority is required for a request that does not come from the catalog', { key: 'errors.serviceRequest.priorityRequired' })
    }
    await assertDomainValue(ctx.tenantId, 'priority', priority)
    assertMayAcknowledgeNoSla(ctx, args.input.acknowledgeNoSla)
    // Dal portale i campi del cliente passano sempre dal controllo (ondata 4): un
    // campo obbligatorio offerto all'utente finale va compilato.
    const customFields = isPortalOnly(ctx) ? (args.input.customFields ?? []) : args.input.customFields
    const result = await requestService.createRequest({ ...args.input, customFields, priority, requiresApproval, ...(category ? { category } : {}) }, ctx, isPortalOnly(ctx) ? 'portal' : 'agent')
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

  // La priorità si valida contro il Dizionario del cliente, come alla creazione
  // (revisione del 14 set 2026 · IT-13: qui passava qualunque stringa).
  if (input.priority != null) await assertDomainValue(ctx.tenantId, 'priority', input.priority)

  return withSession(async (session) => {
    const before = await runQuery<{ props: Props }>(session,
      'MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId}) RETURN properties(r) AS props',
      { id, tenantId: ctx.tenantId })
    if (!before[0]) throw new NotFoundError('ServiceRequest')
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
    await publishTicketUpdated(ctx, 'service_request', id, before[0].props, row.props)
    return mapRequest(row.props)
  }, true)
}

/**
 * Giro nel browser del 14 set 2026 (#41): una richiesta non si poteva
 * assegnare a nessuno. Le richieste non hanno un gruppo assegnatario, quindi
 * non vale la regola «prima il gruppo» di incident e problem: si assegna a chi
 * ha il permesso `ticket.assignable` (ondata 7: prima «admin o operator»), e una
 * richiesta conclusa non si riassegna. `userId` null toglie l'assegnatario.
 */

async function assignServiceRequestToUser(
  _: unknown,
  args: { id: string; userId: string | null },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const check = await runQueryOne<{ completedAt: string | null; assigneeRole: string | null; assigneeFound: boolean }>(session, `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (u:User {id: $userId, tenant_id: $tenantId})
      RETURN r.completed_at AS completedAt, u.role AS assigneeRole, u IS NOT NULL AS assigneeFound
    `, { id: args.id, userId: args.userId, tenantId: ctx.tenantId })
    if (!check) throw new NotFoundError('ServiceRequest', args.id)
    if (check.completedAt) {
      throw new ValidationError('A concluded request cannot be reassigned', { key: 'errors.request.assignConcluded' })
    }
    if (args.userId) {
      if (!check.assigneeFound) throw new NotFoundError('User', args.userId)
      if (!(await roleHasPermission(ctx.tenantId, check.assigneeRole ?? '', 'ticket.assignable'))) {
        throw new ValidationError('The selected user cannot receive tickets: their role lacks the "receive tickets" permission', { key: 'errors.request.assigneeCannotWork' })
      }
    }
    await setTicketUser(session, 'ServiceRequest', args.id, args.userId, ctx.tenantId)
    void audit(ctx, 'request.assigned', 'ServiceRequest', args.id)
    const row = await runQueryOne<{ props: Props }>(session,
      'MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId}) RETURN properties(r) AS props',
      { id: args.id, tenantId: ctx.tenantId })
    if (!row) throw new NotFoundError('ServiceRequest', args.id)
    return mapRequest(row.props)
  }, true)
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
    legacyCategory:   (props['legacy_category'] ?? null) as string | null,
    requiresApproval: (props['requires_approval'] ?? false) as boolean,
    priority:         (props['priority'] ?? null) as string | null,
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

async function createServiceCatalogItem(_: unknown, args: { input: { name: string; description?: string; category?: string; requiresApproval?: boolean; priority: string } }, ctx: GraphQLContext) {
  requirePermission(ctx, 'config.catalog')
  const priority = await assertDomainValue(ctx.tenantId, 'priority', args.input.priority)
  // La categoria è un valore del Dizionario (ondata 2), non più testo libero: la eredita la richiesta.
  const category = args.input.category == null || args.input.category === '' ? null : await assertDomainValue(ctx.tenantId, 'category', args.input.category)
  const id = uuidv4(); const now = new Date().toISOString()
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (ci:ServiceCatalogItem {
        id: $id, tenant_id: $tenantId, name: $name, description: $description,
        category: $category, requires_approval: $requiresApproval, priority: $priority, active: true, created_at: $now
      })
      RETURN properties(ci) AS props
    `, { id, tenantId: ctx.tenantId, name: args.input.name, description: args.input.description ?? null,
         category, requiresApproval: args.input.requiresApproval ?? false, priority, now })
    void audit(ctx, 'service_catalog_item.created', 'ServiceCatalogItem', id)
    return mapCatalogItem(rows[0]!.props)
  }, true)
}

async function updateServiceCatalogItem(
  _: unknown,
  args: { id: string; input: { name?: string; description?: string; category?: string; requiresApproval?: boolean; priority?: string | null; active?: boolean } },
  ctx: GraphQLContext,
) {
  requirePermission(ctx, 'config.catalog')
  const { input } = args
  // Build a SET map with only the provided fields — undefined must not
  // overwrite existing values with null.
  const sets: Record<string, unknown> = {}
  if (input.name !== undefined)             sets['name']              = input.name
  if (input.description !== undefined)      sets['description']       = input.description
  if (input.category !== undefined) {
    sets['category'] = input.category == null || input.category === '' ? null : await assertDomainValue(ctx.tenantId, 'category', input.category)
    // Scegliere una categoria del Dizionario chiude la vecchia scritta a mano.
    sets['legacy_category'] = null
  }
  if (input.requiresApproval !== undefined) sets['requires_approval'] = input.requiresApproval
  if (input.active !== undefined)           sets['active']            = input.active
  // La priorità si cambia, non si toglie: senza, dalla voce non nasce nessuna richiesta.
  if (input.priority !== undefined) {
    if (input.priority === null || input.priority.trim() === '') {
      throw new ValidationError('A catalog item must have a priority.', { key: 'errors.serviceRequest.catalogItemPriorityRequired' })
    }
    sets['priority'] = await assertDomainValue(ctx.tenantId, 'priority', input.priority)
  }
  if (Object.keys(sets).length === 0) {
    throw new ValidationError('updateServiceCatalogItem: no field to update', { key: 'errors.nothingToUpdate' })
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
  Mutation: { createServiceRequest, updateServiceRequest, assignServiceRequestToUser, createServiceCatalogItem, updateServiceCatalogItem },
  ServiceRequest: {
    requestedBy: requestRequestedBy,
    assignee:    requestAssignee,
    slaStatus:   ticketSlaStatusResolver('ServiceRequest'),
  },
}
