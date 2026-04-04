import { GraphQLError } from 'graphql'
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import { sseManager } from '@opengraphity/notifications'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'

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
  args: { status?: string; entityType?: string; page?: number; pageSize?: number },
  ctx: GraphQLContext,
): Promise<{ items: ApprovalRequest[]; total: number }> {
  const page     = Math.max(1, args.page     ?? 1)
  const pageSize = Math.min(100, Math.max(1, args.pageSize ?? 50))
  const skip     = (page - 1) * pageSize

  const conditions: string[] = ['a.tenant_id = $tenantId']
  const params: Record<string, unknown> = { tenantId: ctx.tenantId, skip, limit: pageSize }

  if (args.status)     { conditions.push('a.status = $status');           params['status']     = args.status }
  if (args.entityType) { conditions.push('a.entity_type = $entityType'); params['entityType'] = args.entityType }

  const where = conditions.join(' AND ')

  const session = getSession(undefined, 'READ')
  try {
    const dataRes = await session.executeRead((tx) => tx.run(`
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
      ORDER BY a.requested_at DESC
      SKIP toInteger($skip) LIMIT toInteger($limit)
    `, params))

    const countRes = await session.executeRead((tx) => tx.run(`
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
    return res.records.map(mapApproval)
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
        title:       'Approvazione richiesta',
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
             a.requested_by AS requestedBy
    `, { id: args.id, tenantId: ctx.tenantId }))

    if (!loadRes.records.length) {
      throw new GraphQLError('ApprovalRequest not found', { extensions: { code: 'NOT_FOUND' } })
    }

    const rec        = loadRes.records[0]
    const status     = rec.get('status') as string
    if (status !== 'pending') {
      throw new GraphQLError(`Cannot approve a request with status '${status}'`, { extensions: { code: 'BAD_REQUEST' } })
    }

    const approvers   = JSON.parse((rec.get('approvers')  as string | null) ?? '[]') as string[]
    const approvedBy  = JSON.parse((rec.get('approvedBy') as string | null) ?? '[]') as string[]
    const approvalType = rec.get('approvalType') as string
    const requestedBy  = rec.get('requestedBy')  as string

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
    void audit(ctx, 'approval.approved', 'ApprovalRequest', args.id)

    if (satisfied) {
      sseManager.sendToUser(ctx.tenantId, requestedBy, {
        id:          uuidv4(),
        type:        'approval.approved',
        title:       'Richiesta approvata',
        message:     `La richiesta è stata approvata`,
        severity:    'success',
        entity_id:   args.id,
        entity_type: 'ApprovalRequest',
        timestamp:   new Date().toISOString(),
        read:        false,
      })
    }

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
      RETURN a.status AS status, a.approvers AS approvers, a.requested_by AS requestedBy
    `, { id: args.id, tenantId: ctx.tenantId }))

    if (!loadRes.records.length) {
      throw new GraphQLError('ApprovalRequest not found', { extensions: { code: 'NOT_FOUND' } })
    }

    const status     = loadRes.records[0].get('status')     as string
    const approvers  = JSON.parse((loadRes.records[0].get('approvers') as string | null) ?? '[]') as string[]
    const requestedBy = loadRes.records[0].get('requestedBy') as string

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
    void audit(ctx, 'approval.rejected', 'ApprovalRequest', args.id)

    sseManager.sendToUser(ctx.tenantId, requestedBy, {
      id:          uuidv4(),
      type:        'approval.rejected',
      title:       'Richiesta rifiutata',
      message:     args.note,
      severity:    'error',
      entity_id:   args.id,
      entity_type: 'ApprovalRequest',
      timestamp:   now,
      read:        false,
    })

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
    if (requestedBy !== ctx.userId && ctx.role !== 'admin') {
      throw new GraphQLError('Only the requester or an admin can cancel', { extensions: { code: 'FORBIDDEN' } })
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
  },
  Mutation: {
    createApprovalRequest,
    approveRequest,
    rejectRequest,
    cancelApprovalRequest,
  },
}

logger.debug('[approval] resolver module loaded')
