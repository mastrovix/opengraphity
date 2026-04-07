import { v4 as uuidv4 } from 'uuid'
import { withSession } from './ci-utils.js'
import { ForbiddenError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { publishEvent } from '../../lib/publishEvent.js'
import { workflowEngine } from '@opengraphity/workflow'
import { validateStringLength } from '../../lib/validation.js'
import type { GraphQLContext } from '../../context.js'

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

function toInt(v: unknown): number {
  if (v == null) return 0
  if (typeof (v as { toNumber(): number }).toNumber === 'function') {
    return (v as { toNumber(): number }).toNumber()
  }
  return Number(v)
}

function mapTicket(p: Record<string, unknown>) {
  return {
    id:           p['id']            as string,
    type:         (p['type']         ?? 'incident') as string,
    title:        p['title']         as string,
    description:  (p['description']  ?? null)       as string | null,
    status:       p['status']        as string,
    priority:     (p['priority']     ?? 'medium')   as string,
    category:     (p['category']     ?? 'other')    as string,
    createdAt:    p['created_at']    as string,
    updatedAt:    p['updated_at']    as string,
    assignedTeam: (p['assigned_team'] ?? null)      as string | null,
  }
}

// ── Query: myTickets ──────────────────────────────────────────────────────────

async function myTickets(
  _: unknown,
  { status, page = 1, pageSize = 20 }: { status?: string | null; page?: number; pageSize?: number },
  ctx: GraphQLContext,
) {
  const offset = (page - 1) * pageSize

  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {tenant_id: $tenantId, created_by: $userId})
        WHERE ($status IS NULL OR i.status = $status)
        OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(t:Team)
        WITH i, t
        ORDER BY i.updated_at DESC
        SKIP toInteger($offset) LIMIT toInteger($limit)
        RETURN properties(i) AS props, t.name AS assignedTeam
      `, { tenantId: ctx.tenantId, userId: ctx.userId, status: status ?? null, offset, limit: pageSize }),
    )

    const countResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {tenant_id: $tenantId, created_by: $userId})
        WHERE ($status IS NULL OR i.status = $status)
        RETURN count(i) AS total
      `, { tenantId: ctx.tenantId, userId: ctx.userId, status: status ?? null }),
    )

    const total = toInt(countResult.records[0]?.get('total'))
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
        MATCH (i:Incident {id: $id})-[:HAS_ENTITY_COMMENT]->(c:EntityComment {is_internal: false})
        OPTIONAL MATCH (u:User {id: c.author_id})
        RETURN c.id AS id, c.body AS body, c.is_internal AS isInternal,
               c.author_id AS authorId, c.author_name AS authorName,
               c.author_email AS authorEmail,
               c.created_at AS createdAt, c.updated_at AS updatedAt
        ORDER BY c.created_at ASC
      `, { id }),
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

    // Load attachments
    const attachmentsResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $id})-[:HAS_ATTACHMENT]->(a:Attachment)
        RETURN a.id AS id, a.filename AS filename, a.mime_type AS mimeType,
               a.size_bytes AS sizeBytes, a.uploaded_by AS uploadedBy,
               a.uploaded_at AS uploadedAt, a.description AS description,
               a.download_url AS downloadUrl
        ORDER BY a.uploaded_at ASC
      `, { id }),
    )

    const attachments = attachmentsResult.records.map((r) => ({
      id:          r.get('id')          as string,
      filename:    r.get('filename')    as string,
      mimeType:    r.get('mimeType')    as string,
      sizeBytes:   toInt(r.get('sizeBytes')),
      uploadedBy:  r.get('uploadedBy')  as string,
      uploadedAt:  r.get('uploadedAt')  as string,
      description: (r.get('description') ?? null) as string | null,
      downloadUrl: (r.get('downloadUrl') ?? '') as string,
    }))

    // Load workflow history
    const historyResult = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $id})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
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
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {tenant_id: $tenantId, created_by: $userId})
        RETURN i.status AS status, count(i) AS cnt
      `, { tenantId: ctx.tenantId, userId: ctx.userId }),
    )

    let open = 0, inProgress = 0, resolved = 0, total = 0
    for (const r of result.records) {
      const status = r.get('status') as string
      const cnt    = toInt(r.get('cnt'))
      total += cnt
      if (status === 'new' || status === 'open' || status === 'assigned') open += cnt
      else if (status === 'in_progress' || status === 'escalated' || status === 'pending') inProgress += cnt
      else if (status === 'resolved') resolved += cnt
    }

    return { open, inProgress, resolved, total }
  })
}

// ── Mutation: createTicket ────────────────────────────────────────────────────

async function createTicket(
  _: unknown,
  { title, description, priority = 'medium', category }: {
    title: string; description?: string; priority?: string; category: string
  },
  ctx: GraphQLContext,
) {
  validateStringLength(title, 'title', 1, 500)
  validateStringLength(description, 'description', 0, 10000)

  const [allowedCategories, allowedPriorities] = await Promise.all([
    loadEnumValues(ctx.tenantId, 'category'),
    loadEnumValues(ctx.tenantId, 'priority'),
  ])
  if (allowedCategories.size > 0 && !allowedCategories.has(category)) throw new Error(`Invalid category: ${category}`)
  if (allowedPriorities.size > 0 && !allowedPriorities.has(priority)) priority = 'medium'

  const id  = uuidv4()
  const now = new Date().toISOString()

  const ticket = await withSession(async (session) => {
    const rows = await session.executeWrite((tx) =>
      tx.run(`
        CREATE (i:Incident {
          id:          $id,
          tenant_id:   $tenantId,
          title:       $title,
          description: $description,
          severity:    $priority,
          priority:    $priority,
          status:      'new',
          category:    $category,
          created_by:  $userId,
          created_at:  $now,
          updated_at:  $now
        })
        RETURN properties(i) AS props
      `, { id, tenantId: ctx.tenantId, title, description: description ?? null, priority, category, userId: ctx.userId, now }),
    )
    const props = rows.records[0]?.get('props') as Record<string, unknown> | undefined
    if (!props) throw new Error('Failed to create ticket')
    return mapTicket(props)
  }, true)

  // Attach workflow instance
  await withSession(async (session) => {
    await workflowEngine.createInstance(session, ctx.tenantId, id, 'incident')
  }, true).catch(() => { /* non-fatal if no default workflow */ })

  // Publish domain event + outbound webhooks
  await publishEvent('portal.ticket.created', ctx.tenantId, ctx.userId, { ticketId: id, title, category, priority, userId: ctx.userId }, now)
    .catch(() => { /* non-fatal */ })

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
      tx.run(`MATCH (u:User {id: $userId}) RETURN u.name AS name, u.email AS email`, { userId: ctx.userId }),
    )
    const authorName  = (userResult.records[0]?.get('name')  ?? ctx.userEmail) as string
    const authorEmail = (userResult.records[0]?.get('email') ?? ctx.userEmail) as string

    await session.executeWrite((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $ticketId, tenant_id: $tenantId})
        CREATE (c:EntityComment {
          id:           $commentId,
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

async function reopenTicket(
  _: unknown,
  { ticketId }: { ticketId: string },
  ctx: GraphQLContext,
) {
  return withSession(async (session) => {
    const check = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $ticketId, tenant_id: $tenantId})
        RETURN i.created_by AS createdBy, i.status AS status, properties(i) AS props
      `, { ticketId, tenantId: ctx.tenantId }),
    )

    if (!check.records.length) throw new ForbiddenError('Ticket not found')

    const r          = check.records[0]
    const createdBy  = r.get('createdBy') as string
    const status     = r.get('status')    as string

    if (createdBy !== ctx.userId) throw new ForbiddenError('Access denied')
    if (status !== 'resolved')    throw new Error('Only resolved tickets can be reopened')

    const now = new Date().toISOString()

    const updated = await session.executeWrite((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $ticketId, tenant_id: $tenantId})
        SET i.status = 'in_progress', i.updated_at = $now
        RETURN properties(i) AS props
      `, { ticketId, tenantId: ctx.tenantId, now }),
    )

    void audit(ctx, 'portal.ticket.reopened', 'Incident', ticketId)

    const props = updated.records[0]?.get('props') as Record<string, unknown>
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
