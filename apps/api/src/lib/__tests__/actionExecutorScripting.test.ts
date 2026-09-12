/**
 * D-12 — l'azione `execute_script` delle automazioni passa dal limite di piano
 * del tenant (`Tenant.scripting_enabled`).
 *
 * Prima girava per tutti: un tenant starter poteva far eseguire script dalle
 * proprie regole di automazione e nessuno lo diceva. Ora, col piano che non li
 * comprende, lo script NON viene eseguito e l'azione riporta il perché
 * (risultato `success: false` con il messaggio, più un ERROR nel log): niente
 * silenzio in nessuna delle due direzioni.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../logger.js', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { ...l, child: () => l } }
})
vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn() }))
vi.mock('@opengraphity/events', () => ({ publish: vi.fn() }))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation((fn: (s: unknown) => unknown) => fn({})),
}))
const runScript = vi.fn(async () => ({ success: true, logs: [], duration_ms: 1 }))
vi.mock('@opengraphity/scripting', () => ({ runScript: (...a: unknown[]) => runScript(...(a as [])) }))
const assertScriptingEnabled = vi.fn<(tenantId: string, what: string) => Promise<void>>(async () => {})
vi.mock('../scriptingPlan.js', () => ({ assertScriptingEnabled: (t: string, w: string) => assertScriptingEnabled(t, w) }))

const { executeActions } = await import('../actionExecutor.js')
const { ValidationError } = await import('../errors.js')

const ctx = {
  tenantId: 't1', userId: 'u1', entityId: 'inc-1', entityType: 'incident',
  entity: { id: 'inc-1', severity: 'high' }, source: 'business_rule' as const, sourceName: 'Chiudi i duplicati',
}
const action = { type: 'execute_script' as const, params: { code: 'ctx.entity.severity' } }

beforeEach(() => {
  vi.clearAllMocks()
  runScript.mockImplementation(async () => ({ success: true, logs: [], duration_ms: 1 }))
  assertScriptingEnabled.mockImplementation(async () => {})
})

describe('execute_script — limite di piano', () => {
  it('piano con script → il limite è comunque controllato, nominando la regola, poi lo script gira', async () => {
    const results = await executeActions([action], ctx)
    expect(assertScriptingEnabled).toHaveBeenCalledWith('t1', 'azione execute_script di "Chiudi i duplicati"')
    expect(runScript).toHaveBeenCalledTimes(1)
    expect(results).toEqual([{ action: 'execute_script', success: true }])
  })

  it('piano SENZA script → lo script non gira e l\'azione riporta il motivo', async () => {
    assertScriptingEnabled.mockRejectedValueOnce(new ValidationError('azione execute_script di "Chiudi i duplicati": il piano "starter" del tenant t1 non include gli script (scripting_enabled = false). Rimuovi lo script dalla configurazione oppure passa a un piano che li include.'))
    const results = await executeActions([action], ctx)
    expect(runScript).not.toHaveBeenCalled()
    expect(results).toHaveLength(1)
    expect(results[0]!.success).toBe(false)
    expect(results[0]!.error).toMatch(/non include gli script/)
  })

  it('il limite si controlla PRIMA di caricare il sandbox, e un\'azione senza codice resta un errore suo', async () => {
    const results = await executeActions([{ type: 'execute_script', params: {} }], ctx)
    expect(results[0]!.error).toBe('execute_script: code is required')
    expect(assertScriptingEnabled).not.toHaveBeenCalled()
  })
})
