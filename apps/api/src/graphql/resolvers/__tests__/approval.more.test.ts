/**
 * Approvals: the parts `approval.test.ts` does not reach — "my pending
 * approvals", the advanced filters of the list, and REJECTING a knowledge
 * base article.
 *
 * Why these behaviours matter:
 *  - "My pending approvals" must show only requests where the user is really
 *    an approver. `approvers` is stored as a JSON string and the query only
 *    prefilters with CONTAINS: user `u1` must not see a request addressed to
 *    `u10` (the B-29 defect).
 *  - Advanced filters are ANDed after the tenant condition; they can narrow
 *    the list, never widen it past the tenant.
 *  - Rejecting an article must really send it back to draft (the initial
 *    step of the tenant's workflow). If the workflow refuses, the mutation
 *    fails with CONFLICT instead of telling the author "sent back to draft"
 *    while the article stays in review (the M-15 defect, rejection side).
 *  - The author gets the article-specific notification, pointing at the
 *    article; a generic request gets the generic one, pointing at the request.
 *  - A request whose approver list is missing is not approvable by anybody.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const read = vi.fn()
const write = vi.fn()
const close = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeRead: (fn: (tx: unknown) => unknown) => fn({ run: read }),
    executeWrite: (fn: (tx: unknown) => unknown) => fn({ run: write }),
    close,
  })),
}))
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { getAvailableTransitions: vi.fn() } }))
// The pipeline of the transitions (wave 7 · B1): the article moves through it.
const transition = vi.fn()
vi.mock('../../../services/ticketTransition.js', () => ({ transitionTicket: (...a: unknown[]) => transition(...a) }))
const sendToUser = vi.fn()
vi.mock('@opengraphity/notifications', () => ({ sseManager: { sendToUser: (...a: unknown[]) => sendToUser(...a) } }))
const audit = vi.fn()
vi.mock('../../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))
vi.mock('../../../lib/systemText.js', () => ({ systemText: vi.fn(async (_t: string, k: string) => `text:${k}`) }))
vi.mock('../pendingTicketApprovals.js', () => ({ pendingTicketApprovals: vi.fn() }))
const getInitialStepName = vi.fn()
vi.mock('../../../lib/workflowHelpers.js', () => ({ getInitialStepName: (...a: unknown[]) => getInitialStepName(...a) }))

const { myPendingApprovals, approvalRequests, rejectRequest, approveRequest, cancelApprovalRequest, approvalResolvers } =
  await import('../approval.js')

const ctx = (userId = 'u1') => ({ tenantId: 't1', userId, userEmail: 'u@x', role: 'operator', permissions: new Set<string>() }) as never
const rec = (fields: Record<string, unknown>) => ({ get: (k: string) => fields[k] ?? null })
const row = (over: Record<string, unknown> = {}) => rec({
  id: 'a1', tenantId: 't1', entityType: 'change', entityId: 'c1', title: 'T', description: null,
  status: 'pending', requestedBy: 'u9', requestedAt: '2026-09-01', approvers: '["u1"]', approvedBy: '[]',
  rejectedBy: null, approvalType: 'any', dueDate: null, resolvedAt: null, resolutionNote: null, ...over,
})

async function codeOf(fn: () => Promise<unknown>): Promise<{ code: string; message: string; i18n: unknown }> {
  try { await fn(); return { code: 'NO_REFUSAL', message: '', i18n: null } } catch (e) {
    const g = e as GraphQLError
    return { code: String(g.extensions?.['code'] ?? 'THROWN'), message: g.message, i18n: g.extensions?.['i18n'] }
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  close.mockResolvedValue(undefined)
  read.mockResolvedValue({ records: [] })
  write.mockResolvedValue({ records: [row({ status: 'rejected' })] })
  getInitialStepName.mockResolvedValue('draft')
  transition.mockResolvedValue({ moved: true })
})

describe('myPendingApprovals', () => {
  it('keeps only requests where the user is an approver element by element', async () => {
    read.mockResolvedValueOnce({ records: [
      row({ id: 'mine', approvers: '["u1","u2"]' }),
      // Matches `CONTAINS "u1"` as a substring, but the approver is u10.
      row({ id: 'not-mine', approvers: '["u10"]' }),
      row({ id: 'no-list', approvers: null }),
    ] })
    const out = await myPendingApprovals(null, null, ctx('u1'))
    expect(out.map((a) => a.id)).toEqual(['mine'])
    expect(read.mock.calls[0]![1]).toEqual({ tenantId: 't1', userId: 'u1' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('maps a missing approvedBy list to an empty list, not a crash', async () => {
    read.mockResolvedValueOnce({ records: [row({ approvedBy: null })] })
    expect((await myPendingApprovals(null, null, ctx('u1')))[0]!.approvedBy).toEqual([])
  })
})

describe('approvalRequests — advanced filters', () => {
  it('ANDs the filter after the tenant condition', async () => {
    const filters = JSON.stringify({ rules: [{ field: 'status', operator: 'equals', value: 'pending', logic: 'AND' }] })
    await approvalRequests(null, { filters }, ctx())
    const cypher = String(read.mock.calls[0]![0])
    const where = cypher.slice(cypher.indexOf('WHERE'))
    expect(where).toMatch(/a\.tenant_id = \$tenantId AND \(/)
    expect(Object.values(read.mock.calls[0]![1] as Record<string, unknown>)).toContain('pending')
  })

  it('a filter on a field outside the allowlist is refused, not dropped', async () => {
    // A dropped rule would widen the list behind the user's back.
    const filters = JSON.stringify({ rules: [{ field: 'tenant_id', operator: 'equals', value: 'other', logic: 'AND' }] })
    await expect(approvalRequests(null, { filters }, ctx())).rejects.toThrow(/not allowed/)
    expect(read).not.toHaveBeenCalled()
  })

  it('without a total row the total is zero', async () => {
    const out = await approvalRequests(null, {}, ctx())
    expect(out).toEqual({ items: [], total: 0 })
  })
})

describe('approveRequest — a request without an approver list', () => {
  it('is not approvable by anybody', async () => {
    read.mockResolvedValueOnce({ records: [rec({ id: 'a1', status: 'pending', approvers: null, approvedBy: null, approvalType: 'any' })] })
    expect((await codeOf(() => approveRequest(null, { id: 'a1' }, ctx('u1')))).code).toBe('FORBIDDEN')
    expect(write).not.toHaveBeenCalled()
  })
})

describe('rejectRequest — a knowledge base article', () => {
  /** The pending request on an article, then the active workflow instance. */
  function articleUnderReview(instance: string | null = 'wi-1') {
    read
      .mockResolvedValueOnce({ records: [rec({ status: 'pending', approvers: '["u1"]', requestedBy: 'author', entityType: 'kb_article', entityId: 'kb-1' })] })
      .mockResolvedValueOnce({ records: instance ? [rec({ instanceId: instance })] : [] })
    write.mockResolvedValue({ records: [row({ entityType: 'kb_article', entityId: 'kb-1', status: 'rejected' })] })
  }

  it('sends the article back to the INITIAL step of the tenant workflow, with the reason', async () => {
    articleUnderReview()
    const out = await rejectRequest(null, { id: 'a1', note: 'sources missing' }, ctx('u1'))
    expect(out.status).toBe('rejected')
    expect(getInitialStepName).toHaveBeenCalledWith(expect.anything(), 't1', 'kb_article')
    expect(transition.mock.calls[0]![1]).toEqual({
      tenantId: 't1', instanceId: 'wi-1', toStep: 'draft', notes: 'sources missing',
      actor: { kind: 'person', userId: 'u1' }, triggerType: 'manual',
    })
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'kb_article.publication_rejected', 'KBArticle', 'kb-1')
  })

  it('the author is told the PUBLICATION was rejected, and the link opens the article', async () => {
    articleUnderReview()
    await rejectRequest(null, { id: 'a1', note: 'no' }, ctx('u1'))
    expect(sendToUser).toHaveBeenCalledWith('t1', 'author', expect.objectContaining({
      type: 'kb.publication_rejected',
      title: 'notification.kb.publication_rejected.title',
      title_fallback: 'text:approval.publicationRejected',
      entity_id: 'kb-1', entity_type: 'KBArticle', message: 'no', severity: 'error',
    }))
  })

  it('if the workflow refuses, the rejection fails with CONFLICT and nobody is told otherwise', async () => {
    articleUnderReview()
    transition.mockResolvedValue({ moved: false, refusal: { guard: 'workflow', final: true, code: 'CONFLICT', message: 'guard failed', i18n: { key: 'workflow.guard.x' } } })
    const r = await codeOf(() => rejectRequest(null, { id: 'a1', note: 'no' }, ctx('u1')))
    expect(r.code).toBe('CONFLICT')
    expect(r.message).toContain('could not go back to draft')
    expect(r.message).toContain('guard failed')
    // The engine's own translatable reason travels to the UI.
    expect(r.i18n).toEqual({ key: 'workflow.guard.x' })
    expect(sendToUser).not.toHaveBeenCalled()
  })

  it('a refusal without a translation key still says so, with the generic key', async () => {
    articleUnderReview()
    transition.mockResolvedValue({ moved: false, refusal: { guard: 'workflow', final: true, code: 'CONFLICT', message: 'The workflow refused the transition' } })
    const r = await codeOf(() => rejectRequest(null, { id: 'a1', note: 'no' }, ctx('u1')))
    expect(r.message).toContain('The workflow refused the transition')
    expect(r.i18n).toEqual({ key: 'errors.approval.transitionRefused' })
  })

  it('an article without an active workflow is still rejected and its author told', async () => {
    articleUnderReview(null)
    await rejectRequest(null, { id: 'a1', note: 'no' }, ctx('u1'))
    expect(transition).not.toHaveBeenCalled()
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'kb_article.publication_rejected', 'KBArticle', 'kb-1')
    expect(sendToUser).toHaveBeenCalledOnce()
  })
})

describe('rejectRequest — a generic request', () => {
  it('notifies the generic rejection and points at the request', async () => {
    read.mockResolvedValueOnce({ records: [rec({ status: 'pending', approvers: '["u1"]', requestedBy: 'u9', entityType: 'change', entityId: 'c1' })] })
    await rejectRequest(null, { id: 'a1', note: 'too risky' }, ctx('u1'))
    expect(transition).not.toHaveBeenCalled()
    expect(sendToUser).toHaveBeenCalledWith('t1', 'u9', expect.objectContaining({
      type: 'approval.rejected', entity_id: 'a1', entity_type: 'ApprovalRequest', title_fallback: 'text:approval.requestRejected',
    }))
  })

  it('a request without an approver list cannot be rejected by anybody', async () => {
    read.mockResolvedValueOnce({ records: [rec({ status: 'pending', approvers: null, requestedBy: 'u9', entityType: 'change', entityId: 'c1' })] })
    expect((await codeOf(() => rejectRequest(null, { id: 'a1', note: 'x' }, ctx('u1')))).code).toBe('FORBIDDEN')
    expect(write).not.toHaveBeenCalled()
  })
})

describe('cancelApprovalRequest', () => {
  it('a request of another tenant (or none) is NOT_FOUND', async () => {
    expect((await codeOf(() => cancelApprovalRequest(null, { id: 'ghost' }, ctx('u1')))).code).toBe('NOT_FOUND')
    expect(read.mock.calls[0]![1]).toEqual({ id: 'ghost', tenantId: 't1' })
    expect(write).not.toHaveBeenCalled()
  })
})

describe('the exported resolver map', () => {
  it('exposes every query and mutation the schema declares', () => {
    expect(Object.keys(approvalResolvers.Query).sort()).toEqual(['approvalRequests', 'myPendingApprovals', 'pendingTicketApprovals'])
    expect(Object.keys(approvalResolvers.Mutation).sort()).toEqual(['approveRequest', 'cancelApprovalRequest', 'createApprovalRequest', 'rejectRequest'])
  })
})
