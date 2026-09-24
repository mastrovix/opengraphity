import { GraphQLError } from 'graphql'
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import { workflowEngine } from '@opengraphity/workflow'
import { sseManager } from '@opengraphity/notifications'
import type { GraphQLContext } from '../../context.js'
import { buildAdvancedWhere } from '../../lib/filterBuilder.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { pendingTicketApprovals } from './pendingTicketApprovals.js'
import { systemText } from '../../lib/systemText.js'
import { hasPermission } from '../../lib/permissions.js'
import { askersOf } from '../../lib/ownApproval.js'
import type { Session } from 'neo4j-driver'
import { transitionTicket, type TicketTransitionOutcome } from '../../services/ticketTransition.js'

const approvalLog = logger.child({ module: 'approval' })

interface ApprovalRequest {
  id:             string
  tenantId:       string
  entityType:     string
  entityId:       string
  title:          string
  description:    string | null
  status:         string
  requestedBy:    string
  requestedAt:    string
  approvers:      string[]
  approvedBy:     string[]
  rejectedBy:     string | null
  approvalType:   string
  dueDate:        string | null
  resolvedAt:     string | null
  resolutionNote: string | null
}

/**
 * L'ESITO della transizione conta (revisione totale · M-15).
 *
 * Approvazione e rifiuto di un articolo chiamavano `workflowEngine.transition`
 * e buttavano via il risultato: se una guardia del workflow del cliente
 * rifiutava il passaggio, l'approvazione risultava comunque concessa, la
 * notifica diceva «pubblicato» e l'articolo restava in revisione. Il motore
 * non lancia, RESTITUISCE l'esito — chi lo ignora sta dicendo una cosa falsa.
 */
function assertTransitionApplied(outcome: TicketTransitionOutcome, what: string): void {
  if (outcome.moved) return
  const { refusal } = outcome
  throw new GraphQLError(
    `${what}: the knowledge base workflow refused the transition — ${refusal.message}`,
    {
      extensions: {
        code: 'CONFLICT',
        i18n: refusal.i18n ?? { key: 'errors.approval.transitionRefused' },
      },
    },
  )
}

function mapApproval(r: { get: (k: string) => unknown }): ApprovalRequest {
  return {
    id:             r.get('id')             as string,
    tenantId:       r.get('tenantId')       as string,
    entityType:     r.get('entityType')     as string,
    entityId:       r.get('entityId')       as string,
    title:          r.get('title')          as string,
    description:    r.get('description')    as string | null,
    status:         r.get('status')         as string,
    requestedBy:    r.get('requestedBy')    as string,
    requestedAt:    r.get('requestedAt')    as string,
    approvers:      JSON.parse((r.get('approvers') as string | null) ?? '[]') as string[],
    approvedBy:     JSON.parse((r.get('approvedBy') as string | null) ?? '[]') as string[],
    rejectedBy:     r.get('rejectedBy')     as string | null,
    approvalType:   r.get('approvalType')   as string,
    dueDate:        r.get('dueDate')        as string | null,
    resolvedAt:     r.get('resolvedAt')     as string | null,
    resolutionNote: r.get('resolutionNote') as string | null,
  }
}

function isApprovalSatisfied(req: ApprovalRequest): boolean {
  const { approvalType, approvers, approvedBy } = req
  if (approvalType === 'any')      return approvedBy.length >= 1
  if (approvalType === 'all')      return approvedBy.length >= approvers.length
  if (approvalType === 'majority') return approvedBy.length > approvers.length / 2
  return false
}

// ── Queries ───────────────────────────────────────────────────────────────────

export async function approvalRequests(
  _: unknown,
  args: { page?: number; pageSize?: number; filters?: string; sortField?: string; sortDirection?: string },
  ctx: GraphQLContext,
): Promise<{ items: ApprovalRequest[]; total: number }> {
  const page     = Math.max(1, args.page     ?? 1)
  const pageSize = Math.min(100, Math.max(1, args.pageSize ?? 50))
  const skip     = (page - 1) * pageSize

  const conditions: string[] = ['a.tenant_id = $tenantId']
  const params: Record<string, unknown> = { tenantId: ctx.tenantId, skip, limit: pageSize }

  // Advanced filters
  const allowed = new Set(['title', 'status', 'entityType', 'entity_type', 'requestedAt', 'requested_at', 'requestedBy', 'requested_by'])
  const advWhere = args.filters ? buildAdvancedWhere(args.filters, params, allowed, 'a') : ''
  if (advWhere) conditions.push(`(${advWhere})`)

  const where = conditions.join(' AND ')

  // Sort
  const sortMap: Record<string, string> = { title: 'a.title', status: 'a.status', entityType: 'a.entity_type', requestedAt: 'a.requested_at' }
  const orderBy = sortMap[args.sortField ?? ''] ?? 'a.requested_at'
  const orderDir = args.sortDirection === 'asc' ? 'ASC' : 'DESC'

  const session = getSession(undefined, 'READ')
  try {
    const dataRes = await session.executeRead((tx) => tx.run(`
      // tenant-ok(where-scopato): il WHERE interpolato parte da a.tenant_id = $tenantId (conditions, riga 71)
      MATCH (a:ApprovalRequest)
      WHERE ${where}
      RETURN a.id             AS id,
             a.tenant_id      AS tenantId,
             a.entity_type    AS entityType,
             a.entity_id      AS entityId,
             a.title          AS title,
             a.description    AS description,
             a.status         AS status,
             a.requested_by   AS requestedBy,
             a.requested_at   AS requestedAt,
             a.approvers      AS approvers,
             a.approved_by    AS approvedBy,
             a.rejected_by    AS rejectedBy,
             a.approval_type  AS approvalType,
             a.due_date       AS dueDate,
             a.resolved_at    AS resolvedAt,
             a.resolution_note AS resolutionNote
      ORDER BY ${orderBy} ${orderDir}
      SKIP toInteger($skip) LIMIT toInteger($limit)
    `, params))

    const countRes = await session.executeRead((tx) => tx.run(`
      // tenant-ok(where-scopato): stesso $where della query di pagina, tenant per primo (conditions, riga 71)
      MATCH (a:ApprovalRequest)
      WHERE ${where}
      RETURN count(a) AS total
    `, params))

    const rawTotal = countRes.records[0]?.get('total')
    const total = rawTotal != null && typeof (rawTotal as { toNumber(): number }).toNumber === 'function'
      ? (rawTotal as { toNumber(): number }).toNumber()
      : Number(rawTotal ?? 0)

    return { items: dataRes.records.map(mapApproval), total }
  } finally {
    await session.close()
  }
}

export async function myPendingApprovals(
  _: unknown,
  __: unknown,
  ctx: GraphQLContext,
): Promise<ApprovalRequest[]> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) => tx.run(`
      MATCH (a:ApprovalRequest)
      WHERE a.tenant_id = $tenantId
        AND a.status = 'pending'
        AND a.approvers CONTAINS $userId
      RETURN a.id             AS id,
             a.tenant_id      AS tenantId,
             a.entity_type    AS entityType,
             a.entity_id      AS entityId,
             a.title          AS title,
             a.description    AS description,
             a.status         AS status,
             a.requested_by   AS requestedBy,
             a.requested_at   AS requestedAt,
             a.approvers      AS approvers,
             a.approved_by    AS approvedBy,
             a.rejected_by    AS rejectedBy,
             a.approval_type  AS approvalType,
             a.due_date       AS dueDate,
             a.resolved_at    AS resolvedAt,
             a.resolution_note AS resolutionNote
      ORDER BY a.requested_at DESC
    `, { tenantId: ctx.tenantId, userId: ctx.userId }))
    /**
     * Il `CONTAINS` della query è solo un PREFILTRO (revisione totale · B-29):
     * `approvers` è una stringa JSON, quindi il confronto per sottostringa
     * faceva vedere a un utente le approvazioni di un altro il cui id
     * contenesse il suo (id non-UUID da import o script). L'appartenenza si
     * decide sull'elenco vero, elemento per elemento.
     */
    // What I asked for myself is not waiting for MY approval (24 Sep 2026).
    return res.records.map(mapApproval).filter((a) => a.approvers.includes(ctx.userId) && a.requestedBy !== ctx.userId)
  } finally {
    await session.close()
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function createApprovalRequest(
  _: unknown,
  args: {
    entityType:    string
    entityId:      string
    title:         string
    description?:  string
    approvers:     string[]
    approvalType?: string
    dueDate?:      string
  },
  ctx: GraphQLContext,
): Promise<ApprovalRequest> {
  const id           = uuidv4()
  const now          = new Date().toISOString()
  const approvalType = args.approvalType ?? 'any'

  const session = getSession(undefined, 'WRITE')
  try {
    const res = await session.executeWrite((tx) => tx.run(`
      CREATE (a:ApprovalRequest {
        id:             $id,
        tenant_id:      $tenantId,
        entity_type:    $entityType,
        entity_id:      $entityId,
        title:          $title,
        description:    $description,
        status:         'pending',
        requested_by:   $requestedBy,
        requested_at:   $requestedAt,
        approvers:      $approvers,
        approved_by:    '[]',
        rejected_by:    null,
        approval_type:  $approvalType,
        due_date:       $dueDate,
        resolved_at:    null,
        resolution_note: null
      })
      RETURN a.id             AS id,
             a.tenant_id      AS tenantId,
             a.entity_type    AS entityType,
             a.entity_id      AS entityId,
             a.title          AS title,
             a.description    AS description,
             a.status         AS status,
             a.requested_by   AS requestedBy,
             a.requested_at   AS requestedAt,
             a.approvers      AS approvers,
             a.approved_by    AS approvedBy,
             a.rejected_by    AS rejectedBy,
             a.approval_type  AS approvalType,
             a.due_date       AS dueDate,
             a.resolved_at    AS resolvedAt,
             a.resolution_note AS resolutionNote
    `, {
      id,
      tenantId:     ctx.tenantId,
      entityType:   args.entityType,
      entityId:     args.entityId,
      title:        args.title,
      description:  args.description ?? null,
      requestedBy:  ctx.userId,
      requestedAt:  now,
      approvers:    JSON.stringify(args.approvers),
      approvalType,
      dueDate:      args.dueDate ?? null,
    }))

    const created = mapApproval(res.records[0])
    void audit(ctx, 'approval.created', 'ApprovalRequest', id, { entityType: args.entityType, entityId: args.entityId })

    // Notify each approver via SSE
    for (const approverId of args.approvers) {
      sseManager.sendToUser(ctx.tenantId, approverId, {
        id:          uuidv4(),
        type:        'approval.requested',
        // Il titolo è una chiave del web; il ripiego nella lingua del cliente.
        title:          'notification.approval.requested.title',
        title_fallback: await systemText(ctx.tenantId, 'approval.requested'),
        message:     args.title,
        severity:    'info',
        entity_id:   id,
        entity_type: 'ApprovalRequest',
        timestamp:   now,
        read:        false,
      })
    }

    return created
  } finally {
    await session.close()
  }
}

/**
 * A decided request moves its ticket (owner's decision, review of 23 Sep
 * 2026): approved → the one way forward, rejected → the one step of category
 * `failed`. Through the pipeline of the transitions (wave 7 · B1) as the
 * outcome of an approval: the required fields and every other gate still
 * apply, but not the approver's write permission on the type — the decision
 * is what moves the ticket. When there is no single way, or the move is
 * refused, the decision stands and a person moves the ticket — the gate is
 * open for an approval, and a rejection still lets it be closed. A refusal
 * leaves its note on the ticket; an error is written in the log, never
 * swallowed.
 */
async function moveTicketAfterDecision(
  session: Session, ctx: GraphQLContext, approvalId: string, entityType: string, entityId: string,
  decision: 'approved' | 'rejected', note: string | undefined,
): Promise<void> {
  const { APPROVAL_GATED_TICKETS, decidedTarget } = await import('../../lib/ticketApprovalGate.js')
  if (!APPROVAL_GATED_TICKETS.includes(entityType)) return
  const res = await session.executeRead((tx) => tx.run(`
    MATCH (a:ApprovalRequest {id: $approvalId, tenant_id: $tenantId})
    MATCH (wi:WorkflowInstance {tenant_id: $tenantId, entity_id: $entityId})-[:CURRENT_STEP]->(cur:WorkflowStep)
    WHERE wi.status = 'active'
    RETURN wi.id AS instanceId, cur.name AS current, a.step_name AS stepName
  `, { approvalId, tenantId: ctx.tenantId, entityId }))
  const row = res.records[0]
  // A request without a step (written before the gate) or whose ticket has already left the step moves nothing.
  if (!row || !row.get('stepName') || row.get('stepName') !== row.get('current')) return
  const instanceId = row.get('instanceId') as string
  const { getWorkflowSteps } = await import('../../lib/workflowHelpers.js')
  const steps = await getWorkflowSteps(session, ctx.tenantId, entityType)
  const available = (await workflowEngine.getAvailableTransitions(session, instanceId, ctx.tenantId)).map((t) => t.toStep)
  const target = decidedTarget(decision, available, steps)
  if (!target) {
    approvalLog.info({ tenantId: ctx.tenantId, entityId, approvalId, decision, available }, 'Approval decided: no single way out of the step, a person moves the ticket')
    return
  }
  try {
    const outcome = await transitionTicket(session, {
      tenantId: ctx.tenantId, instanceId, toStep: target, notes: note ?? null,
      actor: { kind: 'system', path: 'approval', userId: ctx.userId },
      triggerType: 'manual',
    })
    if (!outcome.moved) {
      approvalLog.info({ tenantId: ctx.tenantId, entityId, approvalId, decision, target, guard: outcome.refusal.guard }, 'Approval decided, but the move was refused: a person moves the ticket')
    }
  } catch (err) {
    approvalLog.error({ err, tenantId: ctx.tenantId, entityId, approvalId, decision, target }, 'Approval decided, but the ticket could not be moved: a person moves it')
  }
}

/**
 * The decision is given back when the article could not follow it (review of
 * 23 Sep 2026). The status is committed in its own transaction before the
 * workflow move; when the move was refused (no published step, a guard of the
 * customer) the request stayed «approved» or «rejected» with the article
 * still in review — and could never be decided again. It goes back to what it
 * was: pending, with the approvals given before.
 */
async function giveBackDecision(session: Session, tenantId: string, id: string, approvedBy: readonly string[]): Promise<void> {
  await session.executeWrite((tx) => tx.run(`
    MATCH (a:ApprovalRequest {id: $id, tenant_id: $tenantId})
    SET a.status = 'pending', a.approved_by = $approvedBy, a.rejected_by = null,
        a.resolved_at = null, a.resolution_note = null
  `, { id, tenantId, approvedBy: JSON.stringify(approvedBy) }))
}

export async function approveRequest(
  _: unknown,
  args: { id: string; note?: string },
  ctx: GraphQLContext,
): Promise<ApprovalRequest> {
  const session = getSession(undefined, 'WRITE')
  try {
    // Load current state
    const loadRes = await session.executeRead((tx) => tx.run(`
      MATCH (a:ApprovalRequest {id: $id, tenant_id: $tenantId})
      RETURN a.id AS id, a.status AS status, a.approvers AS approvers,
             a.approved_by AS approvedBy, a.approval_type AS approvalType,
             a.requested_by AS requestedBy,
             a.entity_type AS entityType, a.entity_id AS entityId
    `, { id: args.id, tenantId: ctx.tenantId }))

    if (!loadRes.records.length) {
      throw new GraphQLError('ApprovalRequest not found', { extensions: { code: 'NOT_FOUND' } })
    }

    const rec        = loadRes.records[0]
    const status     = rec.get('status') as string
    if (status !== 'pending') {
      throw new GraphQLError(`Cannot approve a request with status '${status}'`, { extensions: { code: 'BAD_REQUEST' } })
    }

    const approvers    = JSON.parse((rec.get('approvers')  as string | null) ?? '[]') as string[]
    const approvedBy   = JSON.parse((rec.get('approvedBy') as string | null) ?? '[]') as string[]
    const approvalType = rec.get('approvalType') as string
    const requestedBy  = rec.get('requestedBy')  as string
    const entityType   = rec.get('entityType')   as string
    const entityId     = rec.get('entityId')     as string

    // Nobody approves what they asked for (24 Sep 2026): checked before the
    // list of approvers, which older requests may still name them in.
    if ((await askersOf(session, ctx.tenantId, entityType, entityId, requestedBy)).has(ctx.userId)) {
      throw new GraphQLError('You asked for this: another member of the approving group decides', {
        extensions: { code: 'FORBIDDEN', i18n: { key: entityType === 'kb_article' ? 'errors.approval.ownArticle' : 'errors.approval.ownRequest' } },
      })
    }
    if (!approvers.includes(ctx.userId)) {
      throw new GraphQLError('You are not an approver for this request', { extensions: { code: 'FORBIDDEN' } })
    }
    if (approvedBy.includes(ctx.userId)) {
      throw new GraphQLError('You have already approved this request', { extensions: { code: 'BAD_REQUEST' } })
    }

    const newApprovedBy = [...approvedBy, ctx.userId]
    const tempReq = { ...rec, approvedBy: newApprovedBy, approvers, approvalType } as unknown as ApprovalRequest
    Object.assign(tempReq, { approvedBy: newApprovedBy, approvers, approvalType })
    const nowReq: ApprovalRequest = {
      id: args.id, tenantId: ctx.tenantId, entityType: '', entityId: '',
      title: '', description: null, status: 'pending', requestedBy, requestedAt: '',
      approvers, approvedBy: newApprovedBy, rejectedBy: null, approvalType,
      dueDate: null, resolvedAt: null, resolutionNote: null,
    }
    const satisfied = isApprovalSatisfied(nowReq)
    const newStatus = satisfied ? 'approved' : 'pending'
    const resolvedAt = satisfied ? new Date().toISOString() : null

    const updateRes = await session.executeWrite((tx) => tx.run(`
      MATCH (a:ApprovalRequest {id: $id, tenant_id: $tenantId})
      SET a.approved_by     = $approvedBy,
          a.status          = $status,
          a.resolved_at     = $resolvedAt,
          a.resolution_note = $note
      RETURN a.id             AS id,
             a.tenant_id      AS tenantId,
             a.entity_type    AS entityType,
             a.entity_id      AS entityId,
             a.title          AS title,
             a.description    AS description,
             a.status         AS status,
             a.requested_by   AS requestedBy,
             a.requested_at   AS requestedAt,
             a.approvers      AS approvers,
             a.approved_by    AS approvedBy,
             a.rejected_by    AS rejectedBy,
             a.approval_type  AS approvalType,
             a.due_date       AS dueDate,
             a.resolved_at    AS resolvedAt,
             a.resolution_note AS resolutionNote
    `, {
      id:          args.id,
      tenantId:    ctx.tenantId,
      approvedBy:  JSON.stringify(newApprovedBy),
      status:      newStatus,
      resolvedAt,
      note:        args.note ?? null,
    }))

    const updated = mapApproval(updateRes.records[0])

    if (satisfied) {
      const nowSse = new Date().toISOString()

      if (entityType === 'kb_article') {
        // ── KB Article: approval granted → fire the forward workflow
        //    transition from the current step (the "publish" step is named by
        //    the workflow definition, not by this resolver).
        const wiRes = await session.executeRead((tx) =>
          tx.run(
            `MATCH (a:KBArticle {id: $entityId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
             WHERE wi.status = 'active'
             RETURN wi.id AS instanceId`,
            { entityId, tenantId: ctx.tenantId },
          ),
        )
        if (wiRes.records.length > 0) {
          const instanceId = wiRes.records[0].get('instanceId') as string
          /**
           * L'articolo approvato va nel passo PUBBLICATO, riconosciuto dalla
           * sua categoria (revisione totale · B-30). Prima si prendeva «la
           * prima transizione manuale che non torna all'iniziale»: in un
           * workflow del cliente con un arco «revisione → archiviato» davanti
           * a «→ pubblicato», l'approvazione ARCHIVIAVA l'articolo. Se nessun
           * passo raggiungibile è di categoria «published» non si inventa una
           * strada: si dice che il workflow non ne ha una.
           */
          const { getWorkflowSteps } = await import('../../lib/workflowHelpers.js')
          const steps = await getWorkflowSteps(session, ctx.tenantId, 'kb_article')
          const publishedSteps = new Set(steps.filter((st) => st.category === 'published').map((st) => st.name))
          const transitions = await workflowEngine.getAvailableTransitions(session, instanceId)
          const forward = transitions.find((t) => publishedSteps.has(t.toStep))
          if (!forward) {
            await giveBackDecision(session, ctx.tenantId, args.id, approvedBy)
            throw new GraphQLError(
              'The knowledge base workflow has no transition to a published step from here: the approval cannot publish the article',
              { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.approval.noPublishedStep' } } },
            )
          }
          // The approver, in person: a refusal is the error on their screen.
          const applied = await transitionTicket(session, {
            tenantId: ctx.tenantId, instanceId, toStep: forward.toStep,
            actor: { kind: 'person', userId: ctx.userId }, triggerType: 'manual',
          })
          // M-15: se il workflow rifiuta, l'articolo NON è pubblicato — e non
          // si manda la notifica «pubblicato» né si lascia l'approvazione
          // concessa: la mutation fallisce e la transazione dell'approvazione
          // resta indietro, che è la cosa vera.
          try {
            assertTransitionApplied(applied, 'The article was approved but could not be published')
          } catch (err) {
            await giveBackDecision(session, ctx.tenantId, args.id, approvedBy)
            throw err
          }
        }
        sseManager.sendToUser(ctx.tenantId, requestedBy, {
          id:          uuidv4(),
          type:        'kb.published',
          title:          'notification.kb.published.title',
          title_fallback: await systemText(ctx.tenantId, 'approval.kbPublished'),
          message:     await systemText(ctx.tenantId, 'approval.kbPublishedMessage'),
          severity:    'success',
          entity_id:   entityId,
          entity_type: 'KBArticle',
          timestamp:   nowSse,
          read:        false,
        })
      } else {
        // The approver decides: the ticket leaves the step (lib/ticketApprovalGate.ts).
        await moveTicketAfterDecision(session, ctx, args.id, entityType, entityId, 'approved', args.note)
        sseManager.sendToUser(ctx.tenantId, requestedBy, {
          id:          uuidv4(),
          type:        'approval.approved',
          title:          'notification.approval.approved.title',
          title_fallback: await systemText(ctx.tenantId, 'approval.approved'),
          message:     await systemText(ctx.tenantId, 'approval.approvedMessage'),
          severity:    'success',
          entity_id:   args.id,
          entity_type: 'ApprovalRequest',
          timestamp:   nowSse,
          read:        false,
        })
      }
    }

    void audit(ctx, 'approval.approved', 'ApprovalRequest', args.id)
    return updated
  } finally {
    await session.close()
  }
}

export async function rejectRequest(
  _: unknown,
  args: { id: string; note: string },
  ctx: GraphQLContext,
): Promise<ApprovalRequest> {
  const session = getSession(undefined, 'WRITE')
  try {
    const loadRes = await session.executeRead((tx) => tx.run(`
      MATCH (a:ApprovalRequest {id: $id, tenant_id: $tenantId})
      RETURN a.status AS status, a.approvers AS approvers, a.requested_by AS requestedBy,
             a.entity_type AS entityType, a.entity_id AS entityId, a.approved_by AS approvedBy
    `, { id: args.id, tenantId: ctx.tenantId }))

    if (!loadRes.records.length) {
      throw new GraphQLError('ApprovalRequest not found', { extensions: { code: 'NOT_FOUND' } })
    }

    const status      = loadRes.records[0].get('status')     as string
    const approvers   = JSON.parse((loadRes.records[0].get('approvers') as string | null) ?? '[]') as string[]
    const requestedBy = loadRes.records[0].get('requestedBy') as string
    const entityType  = loadRes.records[0].get('entityType')  as string
    const entityId    = loadRes.records[0].get('entityId')    as string
    const approvedBefore = JSON.parse((loadRes.records[0].get('approvedBy') as string | null) ?? '[]') as string[]

    if (status !== 'pending') {
      throw new GraphQLError(`Cannot reject a request with status '${status}'`, { extensions: { code: 'BAD_REQUEST' } })
    }
    if (!approvers.includes(ctx.userId)) {
      throw new GraphQLError('You are not an approver for this request', { extensions: { code: 'FORBIDDEN' } })
    }

    const now = new Date().toISOString()
    const updateRes = await session.executeWrite((tx) => tx.run(`
      MATCH (a:ApprovalRequest {id: $id, tenant_id: $tenantId})
      SET a.status          = 'rejected',
          a.rejected_by     = $rejectedBy,
          a.resolved_at     = $resolvedAt,
          a.resolution_note = $note
      RETURN a.id             AS id,
             a.tenant_id      AS tenantId,
             a.entity_type    AS entityType,
             a.entity_id      AS entityId,
             a.title          AS title,
             a.description    AS description,
             a.status         AS status,
             a.requested_by   AS requestedBy,
             a.requested_at   AS requestedAt,
             a.approvers      AS approvers,
             a.approved_by    AS approvedBy,
             a.rejected_by    AS rejectedBy,
             a.approval_type  AS approvalType,
             a.due_date       AS dueDate,
             a.resolved_at    AS resolvedAt,
             a.resolution_note AS resolutionNote
    `, { id: args.id, tenantId: ctx.tenantId, rejectedBy: ctx.userId, resolvedAt: now, note: args.note }))

    const updated = mapApproval(updateRes.records[0])

    if (entityType === 'kb_article') {
      // ── KB Article: transition workflow back to 'draft' ───────────────────
      const wiRes = await session.executeRead((tx) =>
        tx.run(
          `MATCH (a:KBArticle {id: $entityId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance)
           WHERE wi.status = 'active'
           RETURN wi.id AS instanceId`,
          { entityId, tenantId: ctx.tenantId },
        ),
      )
      if (wiRes.records.length > 0) {
        const instanceId = wiRes.records[0].get('instanceId') as string
        const { getInitialStepName } = await import('../../lib/workflowHelpers.js')
        const initialStep = await getInitialStepName(session, ctx.tenantId, 'kb_article')
        const applied = await transitionTicket(session, {
          tenantId: ctx.tenantId, instanceId, toStep: initialStep, notes: args.note,
          actor: { kind: 'person', userId: ctx.userId }, triggerType: 'manual',
        })
        // M-15: lo stesso sul rifiuto — «rimandato in bozza» deve essere vero;
        // and the rejection is given back when it is not (review of 23 Sep 2026).
        try {
          assertTransitionApplied(applied, 'The publication was rejected but the article could not go back to draft')
        } catch (err) {
          await giveBackDecision(session, ctx.tenantId, args.id, approvedBefore)
          throw err
        }
      }
      void audit(ctx, 'kb_article.publication_rejected', 'KBArticle', entityId)
    } else {
      await moveTicketAfterDecision(session, ctx, args.id, entityType, entityId, 'rejected', args.note)
    }

    sseManager.sendToUser(ctx.tenantId, requestedBy, {
      id:          uuidv4(),
      type:        entityType === 'kb_article' ? 'kb.publication_rejected' : 'approval.rejected',
      title:          entityType === 'kb_article' ? 'notification.kb.publication_rejected.title' : 'notification.approval.rejected.title',
      title_fallback: await systemText(ctx.tenantId, entityType === 'kb_article' ? 'approval.publicationRejected' : 'approval.requestRejected'),
      message:     args.note,
      severity:    'error',
      entity_id:   entityType === 'kb_article' ? entityId : args.id,
      entity_type: entityType === 'kb_article' ? 'KBArticle' : 'ApprovalRequest',
      timestamp:   now,
      read:        false,
    })

    void audit(ctx, 'approval.rejected', 'ApprovalRequest', args.id)
    return updated
  } finally {
    await session.close()
  }
}

export async function cancelApprovalRequest(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
): Promise<ApprovalRequest> {
  const session = getSession(undefined, 'WRITE')
  try {
    const loadRes = await session.executeRead((tx) => tx.run(`
      MATCH (a:ApprovalRequest {id: $id, tenant_id: $tenantId})
      RETURN a.status AS status, a.requested_by AS requestedBy
    `, { id: args.id, tenantId: ctx.tenantId }))

    if (!loadRes.records.length) {
      throw new GraphQLError('ApprovalRequest not found', { extensions: { code: 'NOT_FOUND' } })
    }

    const status      = loadRes.records[0].get('status')      as string
    const requestedBy = loadRes.records[0].get('requestedBy') as string

    if (status !== 'pending') {
      throw new GraphQLError(`Cannot cancel a request with status '${status}'`, { extensions: { code: 'BAD_REQUEST' } })
    }
    if (requestedBy !== ctx.userId && !hasPermission(ctx, 'approval.override')) {
      throw new GraphQLError('Only the requester, or someone who can decide for any team, can cancel', { extensions: { code: 'FORBIDDEN' } })
    }

    const updateRes = await session.executeWrite((tx) => tx.run(`
      MATCH (a:ApprovalRequest {id: $id, tenant_id: $tenantId})
      SET a.status = 'cancelled'
      RETURN a.id             AS id,
             a.tenant_id      AS tenantId,
             a.entity_type    AS entityType,
             a.entity_id      AS entityId,
             a.title          AS title,
             a.description    AS description,
             a.status         AS status,
             a.requested_by   AS requestedBy,
             a.requested_at   AS requestedAt,
             a.approvers      AS approvers,
             a.approved_by    AS approvedBy,
             a.rejected_by    AS rejectedBy,
             a.approval_type  AS approvalType,
             a.due_date       AS dueDate,
             a.resolved_at    AS resolvedAt,
             a.resolution_note AS resolutionNote
    `, { id: args.id, tenantId: ctx.tenantId }))

    const updated = mapApproval(updateRes.records[0])
    void audit(ctx, 'approval.cancelled', 'ApprovalRequest', args.id)
    return updated
  } finally {
    await session.close()
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export const approvalResolvers = {
  Query: {
    approvalRequests,
    myPendingApprovals,
    pendingTicketApprovals,
  },
  Mutation: {
    createApprovalRequest,
    approveRequest,
    rejectRequest,
    cancelApprovalRequest,
  },
}

logger.debug('[approval] resolver module loaded')
