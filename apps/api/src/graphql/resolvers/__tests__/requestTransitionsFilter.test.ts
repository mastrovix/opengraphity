/**
 * IT-23 (revisione del 14 set 2026): il filtro «una richiesta con approvazione
 * non la salta» deve stare sul campo che la pagina della richiesta legge.
 */
import { describe, it, expect, vi } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('../ci-utils.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ci-utils.js')>()),
  withSession: vi.fn(async (fn: (s: unknown) => Promise<unknown>) => fn({ executeRead: async (f: (tx: unknown) => unknown) => f({ run: async () => ({ records: [{ get: () => 'wi-1' }] }) }) })),
}))
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { getAvailableTransitions: vi.fn(async () => [{ toStep: 'approval' }, { toStep: 'in_progress' }]) } }))
// The named-approval gate is tested on its own (lib/__tests__/ticketApprovalGate.test.ts): here it is open.
vi.mock('../../../lib/ticketApprovalGate.js', () => ({ transitionsOpenToApproval: vi.fn(async (_s: unknown, _t: string, _i: string, trs: unknown[]) => trs) }))
// Nobody approves what they asked for (lib/ownApproval.ts): here nobody asked.
vi.mock('../../../lib/ownApproval.js', () => ({ isOwnRequestApproval: vi.fn(async () => false) }))
vi.mock('../../../lib/requestApproval.js', () => ({ requestApprovalWouldBeSkipped: vi.fn(async (_s: unknown, _t: string, _i: string, to: string) => to === 'in_progress') }))

const { serviceRequestAvailableTransitionsField } = await import('../workflowQueries.js')
const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'a@x', role: 'operator', permissions: perms('operator') }

describe('ServiceRequest.availableTransitions', () => {
  it('non offre le transizioni che salterebbero l\'approvazione richiesta', async () => {
    const out = await serviceRequestAvailableTransitionsField({ id: 'sr-1' }, undefined, ctx)
    expect(out.map((t: { toStep: string }) => t.toStep)).toEqual(['approval'])
  })

  it('the requester does not see the approval of their own request (24 Sep 2026)', async () => {
    const { isOwnRequestApproval } = await import('../../../lib/ownApproval.js')
    vi.mocked(isOwnRequestApproval).mockImplementation(async (_s, _t, _i, to) => to === 'approval')
    const out = await serviceRequestAvailableTransitionsField({ id: 'sr-1' }, undefined, ctx)
    expect(out).toEqual([])
    expect(isOwnRequestApproval).toHaveBeenCalledWith(expect.anything(), 't1', 'wi-1', 'approval', 'u1')
  })
})
