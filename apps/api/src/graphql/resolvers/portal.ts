import { GraphQLError } from 'graphql'
import { v4 as uuidv4 } from 'uuid'
import type { Session } from 'neo4j-driver'
import { withSession } from './ci-utils.js'
import { ForbiddenError, ValidationError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { publishEvent } from '../../lib/publishEvent.js'
import { workflowEngine } from '@opengraphity/workflow'
import { validateStringLength } from '../../lib/validation.js'
import type { GraphQLContext } from '../../context.js'
import { toNumber } from '@opengraphity/neo4j'
import { getStepNamesByClass, TICKET_STATUS_CLASSES, type TicketStatusClass } from '../../lib/workflowHelpers.js'

/** Load allowed values for a system enum from Neo4j (cached per request). */
async function loadEnumValues(tenantId: string, enumName: string): Promise<Set<string>> {
  return withSession(async (session) => {
    const res = await session.executeRead((tx) =>
      tx.run(`
        MATCH (e:EnumTypeDefinition {name: $name, tenant_id: $tenantId})
        RETURN e.values AS values
      `, { name: enumName, tenantId }),
    )
    const values = res.records[0]?.get('values') as string[] | undefined
    return new Set(values ?? [])
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Read model of a portal ticket. Every portal ticket is an Incident node
 * created by `createTicket`, which always writes priority/category, so a node
 * missing one of them is corrupt data: fail loud (GraphQL error on that field)
 * instead of inventing 'medium'/'other' and hiding it. `type` is structural
 * (the portal only exposes Incidents), not read from the node.
 */
function requireProp(p: Record<string, unknown>, key: string): string {
  const v = p[key]
  if (typeof v !== 'string' || v === '') {
    throw new Error(`Incident ${String(p['id'])}: missing required property '${key}'`)
  }
  return v
}

function mapTicket(p: Record<string, unknown>) {
  return {
    id:           requireProp(p, 'id'),
    type:         'incident',
    title:        requireProp(p, 'title'),
    description:  (p['description']  ?? null)       as string | null,
    status:       requireProp(p, 'status'),
    priority:     requireProp(p, 'priority'),
    category:     requireProp(p, 'category'),
    createdAt:    requireProp(p, 'created_at'),
    updatedAt:    requireProp(p, 'updated_at'),
    assignedTeam: (p['assigned_team'] ?? null)      as string | null,
  }
}

// ── Query: myTickets ──────────────────────────────────────────────────────────

/**
 * `status` è una CLASSE (`open | in_progress | resolved | closed`), non il nome
 * di un passo: B0-3. Il portale mandava il nome `'open'`, che nessun workflow
 * definisce — la scheda «Aperti» era vuota su qualunque tenant. La traduzione
 * classe → nomi di passo viene dal workflow del tenant (`is_open`,
 * `is_initial`, `is_terminal`, `category`), quindi una rinomina dei passi non
 * la rompe, ed è la STESSA usata dal contatore della home: i due numeri
 * coincidono per costruzione.
 *
 * Fail-loud: una classe fuori vocabolario è un errore (nomina le classi
 * ammesse); una classe che nel workflow del tenant non ha nessun passo è un
 * errore che lo dice, invece di una lista vuota che il cliente leggerebbe come
 * «non ho ticket».
 */
async function resolveStatusClass(
  session: Session,
  tenantId: string,
  statusClass: string,
): Promise<string[]> {
  if (!(TICKET_STATUS_CLASSES as readonly string[]).includes(statusClass)) {
    throw new ValidationError(`status must be one of ${TICKET_STATUS_CLASSES.join(', ')} (it is a class, not a workflow step name). Got: ${JSON.stringify(statusClass)}`)
  }
  const byClass = await getStepNamesByClass(session, tenantId, 'incident')
  const names = byClass[statusClass as TicketStatusClass]
  if (names.length === 0) {
    throw new ValidationError(`The incident workflow of tenant "${tenantId}" declares no step in the "${statusClass}" class: the portal cannot list those tickets. Fix the workflow steps (is_open / is_terminal / category) in the designer.`)
  }
  return names
}

async function myTickets(
  _: unknown,
  { status, page = 1, pageSize = 20 }: { status?: string | null; page?: number; pageSize?: number },
  ctx: GraphQLContext,
) {
  const offset = (page - 1) * pageSize

  return withSession(async (session) => {
    const statuses = status ? await resolveStatusClass(session, ctx.tenantId, status) : null

    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {tenant_id: $tenantId, created_by: $userId})
        WHERE ($statuses IS NULL OR i.status IN $statuses)
        OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(t:Team)
        WITH i, t
        ORDER BY i.updated_at DESC
        SKIP toInteger($offset) LIMIT toInteger($limit)
        RETURN properties(i) AS props, t.name AS assignedTeam
      `, { tenantId: ctx.tenantId, userId: ctx.userId, statuses, offset, limit: pageSize }),
    )

    const countResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {tenant_id: $tenantId, created_by: $userId})
        WHERE ($statuses IS NULL OR i.status IN $statuses)
        RETURN count(i) AS total
      `, { tenantId: ctx.tenantId, userId: ctx.userId, statuses }),
    )

    const total = toNumber(countResult.records[0]?.get('total'))
    const items = result.records.map((r) => ({
      ...mapTicket(r.get('props') as Record<string, unknown>),
      assignedTeam: (r.get('assignedTeam') ?? null) as string | null,
    }))

    return { items, total }
  })
}

// ── Query: myTicket ───────────────────────────────────────────────────────────

async function myTicket(
  _: unknown,
  { id }: { id: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const ticketResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $id, tenant_id: $tenantId})
        OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(t:Team)
        RETURN properties(i) AS props, t.name AS assignedTeam
      `, { id, tenantId: ctx.tenantId }),
    )

    if (!ticketResult.records.length) throw new ForbiddenError('Ticket not found')

    const props = ticketResult.records[0].get('props') as Record<string, unknown>
    if (props['created_by'] !== ctx.userId) throw new ForbiddenError('Access denied')

    const ticket = {
      ...mapTicket(props),
      assignedTeam: (ticketResult.records[0].get('assignedTeam') ?? null) as string | null,
    }

    // Load public comments
    const commentsResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_ENTITY_COMMENT]->(c:EntityComment {is_internal: false})
        OPTIONAL MATCH (u:User {id: c.author_id, tenant_id: $tenantId})
        RETURN c.id AS id, c.body AS body, c.is_internal AS isInternal,
               c.author_id AS authorId, c.author_name AS authorName,
               c.author_email AS authorEmail,
               c.created_at AS createdAt, c.updated_at AS updatedAt
        ORDER BY c.created_at ASC
      `, { id, tenantId: ctx.tenantId }),
    )

    const comments = commentsResult.records.map((r) => ({
      id:          r.get('id')          as string,
      body:        r.get('body')        as string,
      isInternal:  false,
      authorId:    r.get('authorId')    as string,
      authorName:  (r.get('authorName')  ?? '') as string,
      authorEmail: (r.get('authorEmail') ?? '') as string,
      createdAt:   r.get('createdAt')   as string,
      updatedAt:   r.get('updatedAt')   as string,
    }))

    // Load attachments — the REST upload creates Attachment nodes keyed by
    // entity_type/entity_id properties, not a HAS_ATTACHMENT relationship
    const attachmentsResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (a:Attachment {tenant_id: $tenantId, entity_type: 'incident', entity_id: $id})
        RETURN a.id AS id, a.filename AS filename, a.mime_type AS mimeType,
               a.size_bytes AS sizeBytes, a.uploaded_by AS uploadedBy,
               a.uploaded_at AS uploadedAt, a.description AS description
        ORDER BY a.uploaded_at ASC
      `, { id, tenantId: ctx.tenantId }),
    )

    const attachments = attachmentsResult.records.map((r) => ({
      id:          r.get('id')          as string,
      filename:    r.get('filename')    as string,
      mimeType:    r.get('mimeType')    as string,
      sizeBytes:   toNumber(r.get('sizeBytes')),
      uploadedBy:  r.get('uploadedBy')  as string,
      uploadedAt:  r.get('uploadedAt')  as string,
      description: (r.get('description') ?? null) as string | null,
      downloadUrl: `/api/attachments/${r.get('id') as string}`,
    }))

    // Load workflow history
    const historyResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $id, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
              -[:STEP_HISTORY]->(exec:WorkflowStepExecution)
        RETURN exec.from_step AS fromStep, exec.step_name AS toStep,
               exec.entered_at AS triggeredAt, exec.triggered_by AS triggeredBy
        ORDER BY exec.entered_at ASC
      `, { id }),
    )

    const history = historyResult.records.map((r) => ({
      fromStep:    (r.get('fromStep')    ?? 'start') as string,
      toStep:      r.get('toStep')      as string,
      label:       null,
      triggeredAt: r.get('triggeredAt') as string,
      triggeredBy: (r.get('triggeredBy') ?? '') as string,
    }))

    return { ...ticket, comments, attachments, history }
  })
}

// ── Query: myTicketStats ──────────────────────────────────────────────────────

async function myTicketStats(
  _: unknown,
  __: unknown,
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    // STESSA classificazione della scheda del portale (B0-3): `open` qui e
    // «Aperti» là sono lo stesso insieme di passi, quindi lo stesso numero.
    // `resolved` resta «risolti o chiusi», come prima.
    const byClass = await getStepNamesByClass(session, ctx.tenantId, 'incident')
    const inClass = (cls: TicketStatusClass, status: string) => byClass[cls].includes(status)

    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {tenant_id: $tenantId, created_by: $userId})
        RETURN i.status AS status, count(i) AS cnt
      `, { tenantId: ctx.tenantId, userId: ctx.userId }),
    )

    let open = 0, inProgress = 0, resolved = 0, total = 0
    const unclassified: string[] = []
    for (const r of result.records) {
      const status = r.get('status') as string
      const cnt    = toNumber(r.get('cnt'))
      total += cnt
      const isOpen     = inClass('open', status)
      const isProgress = inClass('in_progress', status)
      const isDone     = inClass('resolved', status) || inClass('closed', status)
      if (isOpen)     open       += cnt
      if (isProgress) inProgress += cnt
      if (isDone)     resolved   += cnt
      if (!isOpen && !isProgress && !isDone) unclassified.push(`${status} (${cnt})`)
    }

    // Fail-loud: un ticket in un passo che nessuna definizione attiva del
    // tenant classifica non finirebbe in nessun contatore e sparirebbe dalla
    // home restando nel totale — lo stesso silenzio della scheda «Aperti»
    // vuota (B0-3), solo spostato di un numero.
    if (unclassified.length) {
      throw new ValidationError(
        `Tenant "${ctx.tenantId}": ${unclassified.length} stati dei ticket non appartengono a nessuna classe del workflow incident attivo ` +
        `[${unclassified.join(', ')}]: i contatori del portale non li conterebbero. ` +
        `Sistema i passi (is_open / is_terminal / category) o riallinea gli Incident nel designer.`,
      )
    }

    return { open, inProgress, resolved, total }
  })
}

// ── Mutation: createTicket ────────────────────────────────────────────────────

async function createTicket(
  _: unknown,
  { title, description, priority, category }: {
    title: string; description?: string; priority?: string | null; category: string
  },
  ctx: GraphQLContext,
) {
  validateStringLength(title, 'title', 1, 500)
  validateStringLength(description, 'description', 0, 10000)

  // No defaults: a missing or unknown priority is a client bug, not "medium".
  if (!priority) throw new ValidationError('priority is required')
  if (!category) throw new ValidationError('category is required')

  const [allowedCategories, allowedPriorities] = await Promise.all([
    loadEnumValues(ctx.tenantId, 'category'),
    loadEnumValues(ctx.tenantId, 'priority'),
  ])
  if (allowedCategories.size > 0 && !allowedCategories.has(category)) throw new ValidationError(`Invalid category: ${category}`)
  if (allowedPriorities.size > 0 && !allowedPriorities.has(priority)) throw new ValidationError(`Invalid priority: ${priority}`)

  const id  = uuidv4()
  const now = new Date().toISOString()

  const ticket = await withSession(async (session) => {
    const { getInitialStepName } = await import('../../lib/workflowHelpers.js')
    const initialStatus = await getInitialStepName(session, ctx.tenantId, 'incident')
    const rows = await session.executeWrite((tx) =>
      tx.run(`
        CREATE (i:Incident {
          id:          $id,
          tenant_id:   $tenantId,
          title:       $title,
          description: $description,
          severity:    $priority,
          priority:    $priority,
          status:      $status,
          category:    $category,
          created_by:  $userId,
          created_at:  $now,
          updated_at:  $now
        })
        RETURN properties(i) AS props
      `, { id, tenantId: ctx.tenantId, title, description: description ?? null, priority, category, userId: ctx.userId, now, status: initialStatus }),
    )
    const props = rows.records[0]?.get('props') as Record<string, unknown> | undefined
    if (!props) throw new GraphQLError('Failed to create ticket', { extensions: { code: 'INTERNAL_SERVER_ERROR' } })
    return mapTicket(props)
  }, true)

  // Attach workflow instance. A ticket without its workflow instance is the
  // known "workflowInstance: null" corruption — fail the mutation instead of
  // returning a half-created ticket. (The Incident node stays but is visibly
  // broken via the GraphQL error, not silently missing its workflow.)
  await withSession(async (session) => {
    await workflowEngine.createInstance(session, ctx.tenantId, id, 'incident')
  }, true)

  // Publish domain event + outbound webhooks — a failure here loses
  // notifications/webhooks for the new ticket; surface it.
  await publishEvent('portal.ticket.created', ctx.tenantId, ctx.userId, { ticketId: id, title, category, priority, userId: ctx.userId }, now)

  void audit(ctx, 'portal.ticket.created', 'Incident', id)

  return ticket
}

// ── Mutation: addTicketComment ────────────────────────────────────────────────

async function addTicketComment(
  _: unknown,
  { ticketId, body }: { ticketId: string; body: string },
  ctx: GraphQLContext,
) {
  validateStringLength(body, 'body', 1, 10000)

  return withSession(async (session) => {
    const check = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $ticketId, tenant_id: $tenantId})
        RETURN i.created_by AS createdBy
      `, { ticketId, tenantId: ctx.tenantId }),
    )

    if (!check.records.length) throw new ForbiddenError('Ticket not found')
    if (check.records[0].get('createdBy') !== ctx.userId) throw new ForbiddenError('Access denied')

    const commentId = uuidv4()
    const now       = new Date().toISOString()

    const userResult = await session.executeRead((tx) =>
      tx.run(`MATCH (u:User {id: $userId, tenant_id: $tenantId}) RETURN u.name AS name, u.email AS email`, { userId: ctx.userId, tenantId: ctx.tenantId }),
    )
    const authorName  = (userResult.records[0]?.get('name')  ?? ctx.userEmail) as string
    const authorEmail = (userResult.records[0]?.get('email') ?? ctx.userEmail) as string

    await session.executeWrite((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $ticketId, tenant_id: $tenantId})
        CREATE (c:EntityComment {
          id:           $commentId,
          tenant_id:    $tenantId,
          body:         $body,
          is_internal:  false,
          author_id:    $authorId,
          author_name:  $authorName,
          author_email: $authorEmail,
          created_at:   $now,
          updated_at:   $now
        })
        CREATE (i)-[:HAS_ENTITY_COMMENT]->(c)
        SET i.updated_at = $now
      `, { ticketId, tenantId: ctx.tenantId, commentId, body, authorId: ctx.userId, authorName, authorEmail, now }),
    )

    void audit(ctx, 'portal.comment.added', 'Incident', ticketId)

    return {
      id:          commentId,
      body,
      isInternal:  false,
      authorId:    ctx.userId,
      authorName,
      authorEmail,
      createdAt:   now,
      updatedAt:   now,
    }
  }, true)
}

// ── Mutation: reopenTicket ────────────────────────────────────────────────────

/**
 * Reopening is a workflow transition, never a bare `SET i.status`: the engine
 * moves WorkflowInstance.current_step and syncs Incident.status in the same
 * transaction, records the step history and keeps SLA/auto-close consistent.
 * The target step is one the workflow actually allows from the current step
 * (manual TRANSITIONS_TO), chosen among the open steps: an "in progress"-like
 * active step first, then any open step. No such transition → ValidationError.
 */
async function reopenTicket(
  _: unknown,
  { ticketId }: { ticketId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const check = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $ticketId, tenant_id: $tenantId})
        OPTIONAL MATCH (i)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
        RETURN i.created_by AS createdBy, i.status AS status, wi.id AS instanceId
      `, { ticketId, tenantId: ctx.tenantId }),
    )

    if (!check.records.length) throw new ForbiddenError('Ticket not found')

    const r          = check.records[0]
    const createdBy  = r.get('createdBy')  as string
    const status     = r.get('status')     as string
    const instanceId = r.get('instanceId') as string | null

    if (createdBy !== ctx.userId) throw new ForbiddenError('Access denied')
    if (!instanceId) throw new ValidationError(`Ticket ${ticketId} has no workflow instance and cannot be reopened`)

    const { getWorkflowSteps } = await import('../../lib/workflowHelpers.js')
    const steps = await getWorkflowSteps(session, ctx.tenantId, 'incident')
    const resolvedStep = steps.find((s) => s.category === 'resolved')
    if (!resolvedStep || status !== resolvedStep.name) {
      throw new GraphQLError('Only resolved tickets can be reopened', { extensions: { code: 'CONFLICT' } })
    }

    // Candidate targets = manual transitions out of the current step whose
    // destination is an open step (never terminal/closed).
    const stepByName = new Map(steps.map((s) => [s.name, s]))
    const available  = await workflowEngine.getAvailableTransitions(session, instanceId, ctx.tenantId)
    const openTargets = available
      .map((t) => stepByName.get(t.toStep))
      .filter((s): s is NonNullable<typeof s> => !!s && s.isOpen)
    const reopenTo =
      openTargets.find((s) => s.category === 'active' && !s.isInitial) ??
      openTargets.find((s) => s.category === 'active') ??
      openTargets[0]
    if (!reopenTo) {
      throw new ValidationError(
        `The incident workflow defines no transition from "${status}" back to an open step: reopening is not allowed`,
      )
    }

    const result = await workflowEngine.transition(
      session,
      { instanceId, toStepName: reopenTo.name, triggeredBy: ctx.userId, triggerType: 'manual', notes: 'Riaperto dal portale', tenantId: ctx.tenantId },
      { userId: ctx.userId, entityData: {} },
    )
    if (!result.success) {
      throw new ValidationError(`Reopen failed: ${result.error ?? 'transition rejected by the workflow'}`)
    }

    void audit(ctx, 'portal.ticket.reopened', 'Incident', ticketId, { fromStep: status, toStep: reopenTo.name })

    const updated = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $ticketId, tenant_id: $tenantId})
        RETURN properties(i) AS props
      `, { ticketId, tenantId: ctx.tenantId }),
    )
    const props = updated.records[0]?.get('props') as Record<string, unknown> | undefined
    if (!props) throw new Error(`Incident ${ticketId} vanished after reopen transition`)
    return mapTicket(props)
  }, true)
}

// ── Resolver map ──────────────────────────────────────────────────────────────

export const portalResolvers = {
  Query: {
    myTickets,
    myTicket,
    myTicketStats,
  },
  Mutation: {
    createTicket,
    addTicketComment,
    reopenTicket,
  },
}
