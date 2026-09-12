/**
 * Personalizzazioni, ondata 8 — A8-1 (B-18): l'azione `transition_workflow`
 * delle automazioni guarda l'ESITO del motore.
 *
 * Prima il risultato era scartato: un `to_step` che non esiste più (passo
 * rinominato o tolto dal disegnatore) faceva risultare l'azione eseguita e la
 * regola sana, il ticket non si muoveva e nessuno lo sapeva. Dal vivo, su un
 * tenant reale, la regola «Change emergency → approvazione immediata» punta al
 * passo `approved`, che la definizione change non ha mai avuto: l'auto
 * approvazione delle emergency non è mai avvenuta.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../logger.js', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { ...l, child: () => l } }
})
vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn() }))
vi.mock('@opengraphity/events', () => ({ publish: vi.fn() }))

const fakeSession = {
  executeRead: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({
    run: async () => ({ records: [{ get: () => 'wi-1' }] }),
  })),
}
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation((fn: (s: unknown) => unknown) => fn(fakeSession)),
}))
const transition = vi.fn<(...a: unknown[]) => Promise<{ success: boolean; error?: string }>>()
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { transition: (...a: unknown[]) => transition(...a) } }))

const { executeActions } = await import('../actionExecutor.js')

const ctx = {
  tenantId: 't1', userId: 'u1', entityId: 'chg-1', entityType: 'change',
  entity: { id: 'chg-1' }, source: 'business_rule' as const, sourceName: 'Change emergency → approvazione immediata',
}
const action = { type: 'transition_workflow' as const, params: { to_step: 'approved' } }

beforeEach(() => { vi.clearAllMocks() })

describe('transition_workflow — l\'esito del motore non si butta', () => {
  it('transizione riuscita → azione riuscita', async () => {
    transition.mockResolvedValue({ success: true })
    await expect(executeActions([action], ctx)).resolves.toEqual([{ action: 'transition_workflow', success: true }])
  })

  it('bersaglio inesistente → azione FALLITA che nomina il passo e l\'errore del motore', async () => {
    transition.mockResolvedValue({ success: false, error: 'Transizione verso "approved" non valida dallo step corrente' })
    const results = await executeActions([action], ctx)
    expect(results).toHaveLength(1)
    expect(results[0]!.success).toBe(false)
    expect(results[0]!.error).toContain('la transizione verso "approved" non è avvenuta')
    expect(results[0]!.error).toContain('non valida dallo step corrente')
    expect(results[0]!.error).toContain('passo del workflow change')
  })

  it('un\'azione dopo una transizione fallita non viene eseguita (la catena si ferma, come per ogni errore)', async () => {
    transition.mockResolvedValue({ success: false, error: 'boom' })
    const results = await executeActions([action, { type: 'create_comment', params: { text: 'fatto' } }], ctx)
    expect(results.map((r) => r.action)).toEqual(['transition_workflow'])
  })
})
