/**
 * Creare una dashboard è UNA transazione (giro nel browser del 14 set 2026).
 *
 * Dal vivo: la query dell'autore falliva, e restavano due dashboard «Giro
 * browser — Operazioni» senza autore, perché il nodo era già stato scritto in
 * una transazione precedente. Nodo, autore e condivisione stanno insieme: se
 * una parte fallisce, non resta niente.
 */
import { describe, expect, it, vi } from 'vitest'
import { perms } from '../../../../lib/__tests__/testPermissions.js'

const writes: Array<Array<{ cypher: string; params: Record<string, unknown> }>> = []
let authorExists = true

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async (fn: (tx: unknown) => unknown) => fn({ run: async () => ({ records: [{ get: () => 0 }] }) }),
    executeWrite: async (fn: (tx: unknown) => unknown) => {
      const calls: Array<{ cypher: string; params: Record<string, unknown> }> = []
      writes.push(calls)
      return fn({
        run: async (cypher: string, params: Record<string, unknown>) => {
          calls.push({ cypher, params })
          if (cypher.includes('CREATE (d:DashboardConfig')) return { records: [{ get: () => ({ id: 'd-1', name: 'X', visibility: 'all' }) }] }
          if (cypher.includes('CREATED_BY')) return { records: authorExists ? [{ get: () => 'u-1' }] : [] }
          return { records: [] }
        },
      })
    },
    close: async () => undefined,
  }),
}))
vi.mock('../../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../helpers.js', () => ({ mapDashboardConfig: (p: unknown) => p }))
vi.mock('../../reportAccess.js', () => ({ assertDashboardAccess: vi.fn() }))

const { createDashboard } = await import('../dashboardMutations.js')
const ctx = { tenantId: 'c-test', userId: 'u-1', userEmail: 'a@x', role: 'admin', permissions: perms('admin') } as never

describe('createDashboard', () => {
  it('nodo, autore e condivisione nella STESSA transazione, con il tenant su ogni query', async () => {
    writes.length = 0
    authorExists = true
    await createDashboard(null, { input: { name: 'X', visibility: 'teams', sharedWithTeamIds: ['t-1'] } }, ctx)
    expect(writes).toHaveLength(1)
    const cyphers = writes[0]!.map((c) => c.cypher)
    expect(cyphers.some((c) => c.includes('CREATE (d:DashboardConfig'))).toBe(true)
    expect(cyphers.some((c) => c.includes('CREATED_BY'))).toBe(true)
    expect(cyphers.some((c) => c.includes('SHARED_WITH'))).toBe(true)
    for (const c of writes[0]!) expect(c.params['tenantId']).toBe('c-test')
  })

  it('autore inesistente → errore lanciato DENTRO la transazione (che quindi non si conferma)', async () => {
    writes.length = 0
    authorExists = false
    await expect(createDashboard(null, { input: { name: 'X', visibility: 'all' } }, ctx)).rejects.toThrow(/not found/)
    expect(writes).toHaveLength(1)
  })
})
