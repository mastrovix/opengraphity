/**
 * THE STEP ACTIONS THAT WRITE THE GRAPH, for every path (wave 7 · B1).
 *
 * They were callbacks of the manual transition, tested through it; now they
 * are the handlers the process registers on the engine at import
 * (workflow/stepActions.ts), so a step «assign to the Network team» holds
 * when a rule, an escalation or an approval moves the ticket too. What they
 * write, and what they refuse, is tested here once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StepActionHandlers } from '@opengraphity/workflow'

type Call = { cypher: string; params: Record<string, unknown>; mode: 'read' | 'write' }
const calls: Call[] = []
const tx = (mode: 'read' | 'write') => ({
  run: vi.fn(async (cypher: string, params: Record<string, unknown> = {}) => { calls.push({ cypher, params, mode }); return { records: [] } }),
})
const mockSession = {
  executeRead:  vi.fn(async (fn: (t: unknown) => unknown) => fn(tx('read'))),
  executeWrite: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx('write'))),
  close:        vi.fn(async () => undefined),
}
const callOf = (m: string) => calls.find((c) => c.cypher.includes(m))

let registered: StepActionHandlers | null = null
vi.mock('@opengraphity/workflow', () => ({ registerStepActionHandlers: (h: StepActionHandlers) => { registered = h } }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => mockSession) }))
vi.mock('@opengraphity/events', () => ({ publish: vi.fn(async () => undefined) }))
vi.mock('../../lib/stepActionCreateEntity.js', () => ({ createEntityFromStepAction: vi.fn(async () => 'new-entity-id') }))
vi.mock('../../services/ticketAssignment.js', () => ({ assertAssignablePerson: vi.fn(async () => undefined) }))
vi.mock('../../lib/ticketFieldWrite.js', () => ({ writeTicketField: vi.fn(async () => undefined) }))
vi.mock('../../lib/stepApprovalRequest.js', () => ({ createStepApprovalRequest: vi.fn(async () => 'ap-1') }))
vi.mock('../../lib/stepFieldWrites.js', async (orig) => ({
  ...(await orig<object>()),
  stepFieldMetas: vi.fn(async () => new Map([
    ['impact', { name: 'impact', fieldType: 'enum', enumValues: ['low', 'high'], enumTypeName: null }],
  ])),
}))

await import('../stepActions.js')
const { getSession } = await import('@opengraphity/neo4j')
const { publish } = await import('@opengraphity/events')
const { createEntityFromStepAction } = await import('../../lib/stepActionCreateEntity.js')
const { assertAssignablePerson } = await import('../../services/ticketAssignment.js')
const { writeTicketField } = await import('../../lib/ticketFieldWrite.js')
const { createStepApprovalRequest } = await import('../../lib/stepApprovalRequest.js')

const actor = { tenantId: 't-1', userId: 'u-1', stepName: 'assigned' }
const incident = { id: 'e-1', type: 'incident' }
const h = () => registered!

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
})

describe('the step action handlers, registered at import', () => {
  it('are registered once the module is loaded, like the conditions', () => {
    expect(registered).not.toBeNull()
  })

  it('createEntity passes the source ticket so the new one is linked to it, and closes its session', async () => {
    await expect(h().createEntity(actor, 'problem', { title: 'x' }, incident)).resolves.toBe('new-entity-id')
    expect(createEntityFromStepAction).toHaveBeenCalledWith(mockSession, { tenantId: 't-1', userId: 'u-1' }, 'problem', { title: 'x' }, incident)
    expect(getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(mockSession.close).toHaveBeenCalledTimes(1)
  })

  it('assignTo a team replaces the team (no second team), scoped to the tenant, with the assignment history', async () => {
    await h().assignTo(actor, incident, 'team', 'team-7')
    expect(assertAssignablePerson).not.toHaveBeenCalled()
    const w = callOf('MATCH (t:Team {id: $targetId, tenant_id: $tenantId})')!
    expect(w.mode).toBe('write')
    expect(w.params).toMatchObject({ entityId: 'e-1', tenantId: 't-1', targetId: 'team-7' })
  })

  it('assignTo a person first checks the person can be assigned, then replaces the old assignee', async () => {
    await h().assignTo(actor, incident, 'user', 'u-5')
    expect(assertAssignablePerson).toHaveBeenCalledWith(mockSession, 'u-5', 't-1')
    expect(callOf('DELETE old')!.params).toMatchObject({ targetId: 'u-5', tenantId: 't-1' })
  })

  it('assignTo an unassignable person writes nothing, and the session is closed all the same', async () => {
    vi.mocked(assertAssignablePerson).mockRejectedValueOnce(new Error('inactive'))
    await expect(h().assignTo(actor, incident, 'user', 'u-dead')).rejects.toThrow('inactive')
    expect(callOf('DELETE old')).toBeUndefined()
    expect(mockSession.close).toHaveBeenCalledTimes(1)
  })

  it('updateField validates against today\'s metamodel (no templates at runtime), naming the step, before writing', async () => {
    await expect(h().updateField(actor, incident, 'impact', '{title}')).rejects.toThrow(/not a value of the field "impact"/)
    await expect(h().updateField(actor, incident, 'impact', '{title}')).rejects.toThrow(/update_field of step "assigned"/)
    expect(writeTicketField).not.toHaveBeenCalled()
    await h().updateField(actor, incident, 'impact', 'high')
    expect(writeTicketField).toHaveBeenCalledWith(mockSession, 't-1', 'incident', 'e-1', 'impact', 'high')
  })

  it('createApprovalRequest is the shared one (lib/stepApprovalRequest.ts), with the actor and the step', async () => {
    const params = { title: 'Approve me', approverRole: 'cab' }
    await expect(h().createApprovalRequest(actor, incident, params)).resolves.toBe('ap-1')
    expect(createStepApprovalRequest).toHaveBeenCalledWith(mockSession, actor, incident, params)
  })

  it('publishEvent stamps tenant and actor', async () => {
    await h().publishEvent(actor, 'custom.evt', { k: 1 })
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'custom.evt', tenant_id: 't-1', actor_id: 'u-1', payload: { k: 1 } }))
  })
})
