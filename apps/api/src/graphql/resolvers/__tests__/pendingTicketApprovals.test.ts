/**
 * La pagina Approvazioni elenca anche ciò che si decide nel ticket.
 * Giro del 14 set 2026: CHG00000002 con due approvazioni pendenti e
 * REQ00000002 in approvazione non comparivano, e il badge contava solo gli
 * articoli KB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const runs: Array<{ q: string; p: Record<string, unknown> }> = []
let righe: Record<string, Array<Record<string, unknown>>> = {}
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async (fn: (tx: { run: (q: string, p: Record<string, unknown>) => unknown }) => unknown) => fn({
      run: async (q: string, p: Record<string, unknown>) => {
        runs.push({ q, p })
        const chi = q.includes('ChangeApproval') ? 'change' : 'request'
        return { records: (righe[chi] ?? []).map((r) => ({ get: (k: string) => r[k] })) }
      },
    }),
    close: async () => {},
  }),
}))

const { pendingTicketApprovals } = await import('../pendingTicketApprovals.js')
const ctx = (role: string) => ({ tenantId: 't1', userId: 'u1', role, permissions: perms(role) }) as never

beforeEach(() => { runs.length = 0; righe = {} })

describe('pendingTicketApprovals', () => {
  it('requisiti delle change in attesa e richieste in un passo di approvazione, col link al ticket', async () => {
    righe = {
      change:  [{ entityId: 'chg-2', number: 'CHG00000002', title: 'Log', detail: 'Operazioni di rete', requestedAt: '2026-09-13T22:55:51Z' }],
      request: [{ entityId: 'req-2', number: 'REQ00000002', title: 'Portatile', detail: 'Approvazione', requestedAt: '2026-09-13T23:00:00Z' }],
    }
    const out = await pendingTicketApprovals(null, null, ctx('admin'))
    expect(out).toEqual([
      { kind: 'change', entityId: 'chg-2', number: 'CHG00000002', title: 'Log', detail: 'Operazioni di rete', requestedAt: '2026-09-13T22:55:51Z' },
      { kind: 'service_request', entityId: 'req-2', number: 'REQ00000002', title: 'Portatile', detail: 'Approvazione', requestedAt: '2026-09-13T23:00:00Z' },
    ])
    expect(runs[0]!.q).toContain("ChangeApproval {status: 'pending'}")
    expect(runs[1]!.q).toContain("purpose: 'approval'")
  })

  it('l\'admin vede i requisiti di ogni team; gli altri solo quelli dei loro team', async () => {
    await pendingTicketApprovals(null, null, ctx('admin'))
    expect(runs[0]!.p['isAdmin']).toBe(true)
    runs.length = 0
    await pendingTicketApprovals(null, null, ctx('operator'))
    expect(runs[0]!.p['isAdmin']).toBe(false)
    expect(runs[0]!.q).toContain('MEMBER_OF')
  })

  it('le richieste in approvazione le vede chi può farle avanzare (admin, operator), non un viewer', async () => {
    await pendingTicketApprovals(null, null, ctx('viewer'))
    expect(runs).toHaveLength(1)
    runs.length = 0
    await pendingTicketApprovals(null, null, ctx('operator'))
    expect(runs).toHaveLength(2)
  })
})
