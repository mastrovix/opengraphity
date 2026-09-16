import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { requestCustomFieldDefs } from './ticketCustomFields.js'
import { customFieldValueMap, type CustomFieldInput } from '../../lib/ticketCustomFields.js'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { GraphQLResolveInfo } from 'graphql'
import type { GraphQLContext } from '../../context.js'
import { withSession, mapCI, ciTypeFromLabels } from './ci-utils.js'
import { TICKET_CI_RELATIONSHIP } from '@opengraphity/types'
import { ciLabelPredicateForTenant } from '../../lib/ciLabelsForTenant.js'
import { assertCIsLinkable } from '../../lib/ticketCIExclusions.js'
import { mapUser } from '../../lib/mappers.js'
import type { Session } from 'neo4j-driver'
import { buildAdvancedWhere, type RelationFieldDef } from '../../lib/filterBuilder.js'
import {
  FORM_REFERENCE_LABELS, FORM_REFERENCE_REL_TYPES, FORM_REFERENCE_SEARCH_PROPS, isFormReferenceType,
} from '@opengraphity/types'
import { formFields } from '../../lib/catalogForm.js'
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
import { serviceRequestFormAnswers } from './catalogForm.js'
import { ticketSlaStatusResolver } from './ticketSlaStatus.js'
import { publishTicketUpdated } from '../../lib/ticketUpdated.js'
import { assertDomainValue } from '../../lib/domainMatrix.js'
import { listPage } from '../../lib/listLimit.js'
import { setTicketUser } from '../../services/ticketAssignment.js'
import { roleHasPermission } from '../../lib/roles.js'
import { orderByOrThrow } from '../../lib/sortField.js'


// ── Query resolvers ──────────────────────────────────────────────────────────

/**
 * Le colonne su cui l'elenco delle richieste ordina. `number` c'è perché la
 * colonna del web è ordinabile (revisione totale · B-9): mancava, e il clic
 * mostrava la freccia senza cambiare l'ordine. Il test
 * `sortWhitelists.test.ts` confronta questa mappa con le colonne del web.
 */
export const REQUEST_SORT_WHITELIST: Record<string, string> = {
  number:    'r.number',
  title:     'r.title',
  status:    'r.status',
  priority:  'r.priority',
  createdAt: 'r.created_at',
}

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
    /**
     * I campi del cliente si filtrano come quelli del prodotto (ondata 4), e
     * dai moduli del catalogo (ondata 1) vale anche per i campi della LIBRERIA:
     * una risposta a un modulo e una proprieta del ticket, quindi filtrabile.
     * E la ragione per cui le risposte non sono un documento JSON — se la lista
     * dei campi ammessi non le conoscesse, quella ragione sarebbe sulla carta.
     */
    const libreria = await formFields(session, ctx.tenantId)
    const allowedFields = new Set([
      ...getScalarFields(info.schema, 'ServiceRequest'),
      ...(await requestCustomFieldDefs(ctx, 'service_request')).map((d) => d.name),
      ...libreria.map((d) => d.name),
    ])
    /**
     * I campi di RIFERIMENTO (ondata 2) non sono proprietà: sono relazioni.
     * Il costruttore di filtri sa già interrogarle, e con `relProps` distingue
     * due campi che usano lo stesso tipo di relazione (`rel.field`). Si filtra
     * per NOME del nodo puntato — «assegnato a Mario Rossi» — che è ciò che una
     * persona cerca, non un identificativo.
     */
    const relationFields: Record<string, RelationFieldDef> = {}
    for (const campo of libreria) {
      if (!isFormReferenceType(campo.fieldType)) continue
      const relType = FORM_REFERENCE_REL_TYPES[campo.fieldType]
      const targetLabel = FORM_REFERENCE_LABELS[campo.fieldType]
      const searchProp = FORM_REFERENCE_SEARCH_PROPS[campo.fieldType]
      if (!relType || !targetLabel || !searchProp) continue
      relationFields[campo.name] = { relType, targetLabel, searchProp, relProps: { field: campo.name } }
    }
    const advWhere = filters ? buildAdvancedWhere(filters, params, allowedFields, 'r', relationFields) : ''
    // A-22: un campo non ordinabile è un errore, non un ordine diverso in silenzio.
    const orderBy = orderByOrThrow(REQUEST_SORT_WHITELIST, args.sortField, args.sortDirection ?? 'desc', 'r.created_at DESC', 'serviceRequests(sortField)')
    // Revisione totale · B-1: `advWhere` è un'espressione nuda e va unita con
    // AND — interpolata così com'era rendeva il Cypher invalido, quindi QUALUNQUE
    // filtro della pagina Richieste faceva fallire l'elenco (riprodotto su c-test).
    const whereClause = `
      WHERE ($status   IS NULL OR r.status   = $status)
        AND ($priority IS NULL OR r.priority = $priority)
        ${advWhere ? `AND (${advWhere})` : ''}
    `
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (r:ServiceRequest {tenant_id: $tenantId})
      ${whereClause}
      WITH r ORDER BY ${orderBy}
      SKIP toInteger($offset) LIMIT toInteger($limit)
      RETURN properties(r) as props
    `, params)
    // B-32: quante sono in tutto, come per incident e problem: senza `total` la
    // pagina si fermava alle prime 20 senza dirlo.
    const countRows = await runQuery<{ total: unknown }>(session, `
      MATCH (r:ServiceRequest {tenant_id: $tenantId})
      ${whereClause}
      RETURN count(r) AS total
    `, params)
    return { items: rows.map((r) => mapRequest(r.props)), total: Number(countRows[0]?.total ?? 0) }
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
    // L'iter della voce (moduli del catalogo, ondata 3): lo decide la voce, non chi apre la richiesta.
    let workflowDefinitionId: string | null = null
    let priority = args.input.priority ?? null
    if (args.input.catalogItemId) {
      const item = await runQueryOne<{ requiresApproval: boolean; priority: string | null; name: string; category: string | null; workflowDefinitionId: string | null }>(session,
        `MATCH (ci:ServiceCatalogItem {id: $id, tenant_id: $tenantId})
         RETURN ci.requires_approval AS requiresApproval, ci.priority AS priority, ci.name AS name,
                ci.category AS category, ci.workflow_definition_id AS workflowDefinitionId`,
        { id: args.input.catalogItemId, tenantId: ctx.tenantId })
      if (!item) throw new NotFoundError('ServiceCatalogItem', args.input.catalogItemId)
      requiresApproval = item.requiresApproval ?? false
      workflowDefinitionId = item.workflowDefinitionId ?? null
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
    const result = await requestService.createRequest({
      ...args.input, customFields, priority, requiresApproval,
      ...(category ? { category } : {}),
      // L'iter della voce: chi apre la richiesta non lo sceglie.
      ...(workflowDefinitionId ? { workflowDefinitionId } : {}),
    }, ctx, isPortalOnly(ctx) ? 'portal' : 'agent')
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
      // Descrizione e data attesa si possono SVUOTARE (revisione totale ·
      // B-17): con «coalesce» null e assente erano la stessa cosa, quindi una
      // data sbagliata non si poteva togliere più. Il titolo no: una richiesta
      // senza titolo non si riconosce in nessun elenco.
      SET r += {
        title:       coalesce($title,       r.title),
        description: CASE WHEN $descriptionGiven THEN $description ELSE r.description END,
        priority:    coalesce($priority,    r.priority),
        due_date:    CASE WHEN $dueDateGiven     THEN $dueDate     ELSE r.due_date    END,
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
      // B-17: «presente nell'input» distingue il vuoto dall'assenza.
      descriptionGiven: Object.prototype.hasOwnProperty.call(input, 'description'),
      dueDateGiven:     Object.prototype.hasOwnProperty.call(input, 'dueDate'),
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
    // L'iter di questa voce (moduli del catalogo, ondata 3): null = per categoria.
    workflowDefinitionId: (props['workflow_definition_id'] ?? null) as string | null,
    // Il nome lo risolve il field resolver `ServiceCatalogItem.workflowDefinitionName`.
  }
}

/**
 * La definizione indicata da una voce deve esistere, essere ATTIVA, essere del
 * tipo `service_request` e avere un passo iniziale. Un iter scelto e poi
 * disattivato (o senza passo iniziale) farebbe fallire la creazione di ogni
 * richiesta di quella voce, e il messaggio arriverebbe a chi apre il ticket
 * invece che a chi ha configurato.
 */
async function assertWorkflowDefinition(session: Session, tenantId: string, definitionId: string): Promise<void> {
  const rows = await runQuery<{ name: string; entityType: string; iniziali: number }>(session, `
    MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId, active: true})
    OPTIONAL MATCH (wd)-[:HAS_STEP]->(s:WorkflowStep)
      WHERE coalesce(s.is_initial, s.type = 'start')
    RETURN wd.name AS name, wd.entity_type AS entityType, count(s) AS iniziali
    LIMIT 1`, { definitionId, tenantId })
  const row = rows[0]
  if (!row) {
    throw new ValidationError('That workflow does not exist here, or it is not active.',
      { key: 'errors.serviceCatalog.workflowNotFound', params: {} })
  }
  if (row.entityType !== 'service_request') {
    throw new ValidationError(`The workflow "${row.name}" is for ${row.entityType}, not for service requests.`,
      { key: 'errors.serviceCatalog.workflowWrongType', params: { name: row.name, entityType: row.entityType } })
  }
  if (Number(row.iniziali) === 0) {
    throw new ValidationError(`The workflow "${row.name}" has no initial step: mark one in the designer before using it here.`,
      { key: 'errors.serviceCatalog.workflowNoInitialStep', params: { name: row.name } })
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

async function createServiceCatalogItem(_: unknown, args: { input: { name: string; description?: string; category?: string; requiresApproval?: boolean; priority: string; workflowDefinitionId?: string | null } }, ctx: GraphQLContext) {
  requirePermission(ctx, 'config.catalog')
  const priority = await assertDomainValue(ctx.tenantId, 'priority', args.input.priority)
  // La categoria è un valore del Dizionario (ondata 2), non più testo libero: la eredita la richiesta.
  const category = args.input.category == null || args.input.category === '' ? null : await assertDomainValue(ctx.tenantId, 'category', args.input.category)
  const id = uuidv4(); const now = new Date().toISOString()
  return withSession(async (session) => {
    if (args.input.workflowDefinitionId) await assertWorkflowDefinition(session, ctx.tenantId, args.input.workflowDefinitionId)
    const rows = await runQuery<{ props: Props }>(session, `
      CREATE (ci:ServiceCatalogItem {
        id: $id, tenant_id: $tenantId, name: $name, description: $description,
        category: $category, requires_approval: $requiresApproval, priority: $priority, active: true, created_at: $now,
        workflow_definition_id: $workflowDefinitionId
      })
      RETURN properties(ci) AS props
    `, { id, tenantId: ctx.tenantId, name: args.input.name, description: args.input.description ?? null,
         category, requiresApproval: args.input.requiresApproval ?? false, priority, now,
         workflowDefinitionId: args.input.workflowDefinitionId ?? null })
    void audit(ctx, 'service_catalog_item.created', 'ServiceCatalogItem', id)
    return mapCatalogItem(rows[0]!.props)
  }, true)
}

async function updateServiceCatalogItem(
  _: unknown,
  args: { id: string; input: { name?: string; description?: string; category?: string; requiresApproval?: boolean; priority?: string | null; active?: boolean; workflowDefinitionId?: string | null } },
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
  /**
   * L'iter della voce (ondata 3). `null` esplicito lo TOGLIE e riporta alla
   * scelta per categoria: è una scelta, non un valore mancante, e va distinta
   * da «non l'ho mandato» (undefined).
   */
  if (input.workflowDefinitionId !== undefined) {
    sets['workflow_definition_id'] = input.workflowDefinitionId === null || input.workflowDefinitionId === ''
      ? null
      : input.workflowDefinitionId
  }
  /**
   * La validazione dell'iter serve ANCHE qui, non solo alla creazione della
   * voce: provando dal browser ho assegnato un workflow SPENTO e la modifica
   * l'ha accettato — da quel momento ogni richiesta di quella voce sarebbe
   * fallita, e il messaggio sarebbe arrivato a chi apre il ticket invece che a
   * chi ha configurato.
   */
  const iterDaValidare = sets['workflow_definition_id']
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
    if (typeof iterDaValidare === 'string') await assertWorkflowDefinition(session, ctx.tenantId, iterDaValidare)
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

// ── CI della richiesta (revisione del 15 set 2026 · CM-8) ─────────────────────
//
// Le richieste non si collegavano a nessun CI («richiesta di accesso al server
// X» non poteva dire quale server). Il collegamento è `CONCERNS_CI`, e i tipi
// di CI esclusi per le richieste non si collegano, come per gli altri ticket.

const REQUEST_CI = TICKET_CI_RELATIONSHIP.service_request

async function requestAffectedCIs(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props; label: string }>(session, `
      MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId})-[:${REQUEST_CI}]->(ci)
      WHERE ci.tenant_id = $tenantId
      RETURN properties(ci) AS props, head([l IN labels(ci) WHERE l <> 'ConfigurationItem']) AS label
      ORDER BY ci.name
    `, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => {
      const t = ciTypeFromLabels(ctx.tenantId, [r.label])
      r.props['type'] = t
      const ci = mapCI(r.props) as Record<string, unknown>
      ci['ciType']     = t
      ci['__typename'] = r.label
      return ci
    })
  })
}

async function addCIToServiceRequest(_: unknown, args: { requestId: string; ciId: string }, ctx: GraphQLContext) {
  await assertCIsLinkable(ctx.tenantId, 'service_request', [args.ciId])
  const ciPredicate = await ciLabelPredicateForTenant('ci', ctx.tenantId)
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props; linked: unknown }>(session, `
      MATCH (r:ServiceRequest {id: $requestId, tenant_id: $tenantId})
      MATCH (ci {id: $ciId, tenant_id: $tenantId})
      WHERE ${ciPredicate}
      MERGE (r)-[l:${REQUEST_CI}]->(ci)
      SET r.updated_at = $now
      RETURN properties(r) AS props, count(l) AS linked
    `, { requestId: args.requestId, ciId: args.ciId, tenantId: ctx.tenantId, now: new Date().toISOString() })
    // Righe CONTATE (C-2): una richiesta o un CI che non esistono in questo
    // tenant non scrivono niente, e va detto.
    if (!row || Number(row.linked) === 0) {
      throw new ValidationError(`CI ${args.ciId} not linked to the request: the request or the CI does not exist in this tenant`, { key: 'errors.ciLink.request', params: { ci: args.ciId } })
    }
    void audit(ctx, 'request.ci_added', 'ServiceRequest', args.requestId, { ciId: args.ciId })
    return mapRequest(row.props)
  }, true)
}

async function removeCIFromServiceRequest(_: unknown, args: { requestId: string; ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const row = await runQueryOne<{ props: Props; removed: unknown }>(session, `
      MATCH (r:ServiceRequest {id: $requestId, tenant_id: $tenantId})
      OPTIONAL MATCH (r)-[l:${REQUEST_CI}]->(ci {id: $ciId, tenant_id: $tenantId})
      WITH r, collect(l) AS links
      FOREACH (x IN links | DELETE x)
      SET r.updated_at = CASE WHEN size(links) > 0 THEN $now ELSE r.updated_at END
      RETURN properties(r) AS props, size(links) AS removed
    `, { requestId: args.requestId, ciId: args.ciId, tenantId: ctx.tenantId, now: new Date().toISOString() })
    if (!row) throw new NotFoundError('ServiceRequest', args.requestId)
    if (Number(row.removed) === 0) throw new NotFoundError('CIRelationship', `${args.requestId} → ${args.ciId}`)
    void audit(ctx, 'request.ci_removed', 'ServiceRequest', args.requestId, { ciId: args.ciId })
    return mapRequest(row.props)
  }, true)
}

// ── Export ───────────────────────────────────────────────────────────────────

export const serviceRequestResolvers = {
  Query:    { serviceRequests, serviceRequest, serviceCatalogItems },
  Mutation: { createServiceRequest, updateServiceRequest, assignServiceRequestToUser, createServiceCatalogItem, updateServiceCatalogItem, addCIToServiceRequest, removeCIFromServiceRequest },
  ServiceCatalogItem: {
    /**
     * Il nome dell'iter scelto, risolto qui e non nella lettura della voce:
     * serve solo a chi mostra la voce, e una join su ogni elenco di catalogo la
     * pagherebbero anche il portale e la creazione di una richiesta.
     */
    workflowDefinitionName: async (parent: { workflowDefinitionId?: string | null }, _a: unknown, ctx: GraphQLContext) => {
      if (!parent.workflowDefinitionId) return null
      return withSession(async (session) => {
        const rows = await runQuery<{ name: string }>(session, `
          MATCH (wd:WorkflowDefinition {id: $definitionId, tenant_id: $tenantId})
          RETURN wd.name AS name LIMIT 1`, { definitionId: parent.workflowDefinitionId, tenantId: ctx.tenantId })
        return rows[0]?.name ?? null
      })
    },
  },

  ServiceRequest: {
    affectedCIs: requestAffectedCIs,
    // Le risposte al modulo della voce di catalogo (moduli del catalogo, ondata 1).
    formAnswers: serviceRequestFormAnswers,
    requestedBy: requestRequestedBy,
    assignee:    requestAssignee,
    slaStatus:   ticketSlaStatusResolver('ServiceRequest'),
  },
}
