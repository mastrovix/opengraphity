/**
 * THE APPROVER DECIDES (owner's decision, review of 23 Sep 2026).
 *
 * What these tests pin:
 *  - a pending or rejected request of the step the ticket is in holds it;
 *    an approved or withdrawn one, a request of another step, one written
 *    before `step_name` existed, or a change, hold nothing;
 *  - closing or cancelling (a terminal step) is never held;
 *  - a decision moves the ticket only when there is ONE way to go;
 *  - leaving the step withdraws what is still pending there;
 *  - the transitions offered are the ones the mutation accepts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const rows = vi.hoisted(() => ({ one: null as Record<string, unknown> | null, many: [] as Array<Record<string, unknown>> }))
const calls: Array<{ cypher: string; params: Record<string, unknown> }> = []
vi.mock('@opengraphity/neo4j', () => ({
  runQueryOne: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => { calls.push({ cypher, params }); return rows.one }),
  runQuery:    vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => { calls.push({ cypher, params }); return rows.many }),
}))
vi.mock('../logger.js', () => ({ logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }))

const { ticketApprovalRefusal, withdrawApprovalsOfStep, decidedTarget, transitionsOpenToApproval } = await import('../ticketApprovalGate.js')

const S = {} as never
const held = (over: Record<string, unknown> = {}) => ({ approvalId: 'ap-1', status: 'pending', stepName: 'budget_approval', entityType: 'service_request', targetTerminal: false, ...over })

beforeEach(() => { calls.length = 0; rows.one = null; rows.many = [] })

describe('ticketApprovalRefusal', () => {
  it('a PENDING request of the current step holds a move forward, and names itself', async () => {
    rows.one = held()
    await expect(ticketApprovalRefusal(S, 't1', 'wi-1', 'in_progress')).resolves.toEqual({ status: 'pending', approvalId: 'ap-1', stepName: 'budget_approval' })
    expect(calls[0]!.params).toEqual({ instanceId: 'wi-1', tenantId: 't1', toStep: 'in_progress' })
    // The request of the step the ticket IS in, the latest one, in the tenant.
    expect(calls[0]!.cypher).toContain('ApprovalRequest {tenant_id: $tenantId, entity_id: wi.entity_id, step_name: cur.name}')
    expect(calls[0]!.cypher).toContain('ORDER BY a.requested_at DESC')
  })

  it('a REJECTED one holds too', async () => {
    rows.one = held({ status: 'rejected' })
    await expect(ticketApprovalRefusal(S, 't1', 'wi-1', 'in_progress')).resolves.toMatchObject({ status: 'rejected' })
  })

  it('closing or cancelling is never held: a terminal step skips nothing', async () => {
    rows.one = held({ targetTerminal: true })
    await expect(ticketApprovalRefusal(S, 't1', 'wi-1', 'cancelled')).resolves.toBeNull()
  })

  it('approved, withdrawn, none, or a change: nothing is held', async () => {
    for (const r of [held({ status: 'approved' }), held({ status: 'cancelled' }), held({ approvalId: null, status: null }), held({ entityType: 'change' }), null]) {
      rows.one = r
      await expect(ticketApprovalRefusal(S, 't1', 'wi-1', 'in_progress')).resolves.toBeNull()
    }
  })
})

describe('decidedTarget', () => {
  const steps = [
    { name: 'budget_approval', isTerminal: false, category: 'waiting', purpose: 'approval' },
    { name: 'in_progress',     isTerminal: false, category: 'active',  purpose: null },
    { name: 'second_opinion',  isTerminal: false, category: 'waiting', purpose: 'approval' },
    { name: 'rejected',        isTerminal: true,  category: 'failed',  purpose: null },
    { name: 'cancelled',       isTerminal: true,  category: 'closed',  purpose: null },
  ]

  it('approved: the one way forward — not another approval, not a closure', () => {
    expect(decidedTarget('approved', ['in_progress', 'second_opinion', 'rejected', 'cancelled'], steps)).toBe('in_progress')
  })

  it('rejected: the one step of category failed', () => {
    expect(decidedTarget('rejected', ['in_progress', 'rejected', 'cancelled'], steps)).toBe('rejected')
  })

  it('two ways, or none, or a step the workflow does not know: a person chooses', () => {
    const two = [...steps, { name: 'fast_track', isTerminal: false, category: 'active', purpose: null }]
    expect(decidedTarget('approved', ['in_progress', 'fast_track'], two)).toBeNull()
    expect(decidedTarget('rejected', ['in_progress', 'cancelled'], steps)).toBeNull()
    expect(decidedTarget('approved', ['ghost'], steps)).toBeNull()
  })
})

describe('withdrawApprovalsOfStep', () => {
  it('withdraws only what is still pending in that step, of that ticket, and counts it', async () => {
    rows.many = [{ id: 'ap-1' }, { id: 'ap-2' }]
    await expect(withdrawApprovalsOfStep(S, 't1', 'req-1', 'budget_approval', '2026-09-23T10:00:00Z')).resolves.toBe(2)
    expect(calls[0]!.cypher).toContain("ApprovalRequest {tenant_id: $tenantId, entity_id: $entityId, step_name: $stepName, status: 'pending'}")
    expect(calls[0]!.cypher).toContain("SET a.status = 'cancelled'")
    expect(calls[0]!.params).toEqual({ tenantId: 't1', entityId: 'req-1', stepName: 'budget_approval', at: '2026-09-23T10:00:00Z' })
  })
})

describe('transitionsOpenToApproval', () => {
  const trs = [{ toStep: 'in_progress' }, { toStep: 'cancelled' }]

  it('offers only what the approval does not hold', async () => {
    const { runQueryOne } = await import('@opengraphity/neo4j')
    vi.mocked(runQueryOne).mockImplementation(async (_s, _c, p) => (p as { toStep: string }).toStep === 'in_progress' ? held() : held({ targetTerminal: true }))
    await expect(transitionsOpenToApproval(S, 't1', 'wi-1', trs, false)).resolves.toEqual([{ toStep: 'cancelled' }])
  })

  it('approval.override sees them all, without asking', async () => {
    const { runQueryOne } = await import('@opengraphity/neo4j')
    vi.mocked(runQueryOne).mockClear()
    await expect(transitionsOpenToApproval(S, 't1', 'wi-1', trs, true)).resolves.toEqual(trs)
    expect(runQueryOne).not.toHaveBeenCalled()
  })
})
