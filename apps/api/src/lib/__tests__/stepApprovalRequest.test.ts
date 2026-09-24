/**
 * THE APPROVAL REQUEST A STEP CREATES (wave 7 · B1): who approves, and what
 * happens when nobody can. It was a callback of the manual transition; now
 * every path that enters the step creates it (workflow/stepActions.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLError } from 'graphql'

type Rec = { get: (k: string) => unknown }
type Call = { cypher: string; params: Record<string, unknown>; mode: 'read' | 'write' }
const calls: Call[] = []
let script: Array<{ match: string; ids: string[] }> = []
const tx = (mode: 'read' | 'write') => ({
  run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => {
    calls.push({ cypher, params, mode })
    const hit = script.find((s) => cypher.includes(s.match))
    return { records: (hit?.ids ?? []).map((id): Rec => ({ get: (k: string) => (k === 'id' ? id : null) })) }
  }),
})
const session = {
  executeRead:  vi.fn(async (fn: (t: unknown) => unknown) => fn(tx('read'))),
  executeWrite: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx('write'))),
}
const callOf = (m: string) => calls.find((c) => c.cypher.includes(m))
const on = (match: string, ...ids: string[]) => { script.push({ match, ids }) }

vi.mock('@opengraphity/notifications', () => ({ sseManager: { sendToUser: vi.fn() } }))
vi.mock('../systemText.js', () => ({ systemText: vi.fn(async () => 'Approval requested') }))

const { createStepApprovalRequest } = await import('../stepApprovalRequest.js')
const { sseManager } = await import('@opengraphity/notifications')

const actor = { tenantId: 't-1', userId: 'u-1', stepName: 'budget_approval' }
const incident = { id: 'e-1', type: 'incident' }
const create = (params: Record<string, unknown>) =>
  createStepApprovalRequest(session as never, actor, incident, { title: 'T', ...params } as never)
const caught = async (p: Promise<unknown>): Promise<GraphQLError> => {
  try { await p } catch (e) { return e as GraphQLError }
  throw new Error('expected a refusal')
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  script = []
})

describe('createStepApprovalRequest', () => {
  it('with no approver source defaults to the active admins, holds the step being entered, and notifies each approver', async () => {
    on('role: $role', 'adm-1', 'adm-2')
    const id = await create({ title: 'Approve me' })
    const read = callOf('role: $role')!
    expect(read.params).toEqual({ tenantId: 't-1', role: 'admin' })
    expect(read.cypher).toContain('coalesce(u.active, true)')
    const w = callOf('CREATE (ap:ApprovalRequest')!
    expect(w.mode).toBe('write')
    expect(w.params).toMatchObject({
      id, tenantId: 't-1', entityType: 'incident', entityId: 'e-1', stepName: 'budget_approval',
      approvers: JSON.stringify(['adm-1', 'adm-2']), approvalType: 'any', requestedBy: 'u-1', title: 'Approve me',
    })
    expect(sseManager.sendToUser).toHaveBeenCalledTimes(2)
    expect(vi.mocked(sseManager.sendToUser).mock.calls[0]).toEqual(['t-1', 'adm-1', expect.objectContaining({ entity_id: id, title_fallback: 'Approval requested', message: 'Approve me' })])
  })

  it('named people and team members are merged without repetition; the role is not used', async () => {
    on('u.id IN $ids', 'p-1', 'p-2')
    on('t.id IN $ids', 'p-2', 'p-3')
    await create({ approverRole: 'manager', approverUserIds: ['p-1', 'p-2'], approverTeamIds: ['tm-1'], approvalType: 'all' })
    expect(callOf('role: $role')).toBeUndefined()
    expect(callOf('CREATE (ap:ApprovalRequest')!.params).toMatchObject({ approvers: JSON.stringify(['p-1', 'p-2', 'p-3']), approvalType: 'all' })
  })

  it('no approver found: refused naming the role that has nobody, and nothing is created', async () => {
    const e = await caught(create({ approverRole: 'cab' }))
    expect(e.extensions['code']).toBe('NO_APPROVER')
    expect(e.extensions['i18n']).toEqual({ key: 'errors.workflow.noApprover', params: { role: 'cab' } })
    expect(callOf('CREATE (ap:ApprovalRequest')).toBeUndefined()
    expect(sseManager.sendToUser).not.toHaveBeenCalled()
  })

  it('no approver found: without a role the message names the default admin role', async () => {
    const e = await caught(create({}))
    expect(e.message).toContain('no user with role "admin"')
  })

  it('no approver found among named people/teams: a different message, fixed in a different place', async () => {
    const e = await caught(create({ approverTeamIds: ['tm-empty'] }))
    expect(e.extensions['i18n']).toEqual({ key: 'errors.workflow.noApproverTarget', params: {} })
    expect(e.message).toContain('users: 0, teams: 1')
    const e2 = await caught(create({ approverUserIds: ['ghost'] }))
    expect(e2.message).toContain('users: 1, teams: 0')
  })
})
