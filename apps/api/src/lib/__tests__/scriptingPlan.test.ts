/**
 * D-12 — `Tenant.scripting_enabled` viene LETTO.
 *
 * Prima: 13 occorrenze della proprietà, tutte scritture o definizioni, zero
 * letture. Gli script del cliente (validazione del metamodello, azione
 * `execute_script` delle automazioni, trasformazione dei webhook) giravano
 * anche per i tenant il cui piano non li comprende, e nessuno lo diceva.
 *
 * Contratto pinnato qui: piano senza script → l'operazione si FERMA con un
 * messaggio che nomina il piano; tenant incompleto (senza nodo o senza la
 * proprietà) → errore che nomina la migrazione, mai un limite inventato;
 * gli script spediti col metamodello condiviso (`scope` base/itil) non passano
 * dal limite, altrimenti nessun tenant starter potrebbe creare un CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'

const runQueries: Array<{ cypher: string; params: Record<string, unknown> }> = []
let tenantRows: Array<Record<string, unknown>> = []

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
      fn({
        run: async (cypher: string, params: Record<string, unknown>) => {
          runQueries.push({ cypher, params })
          return { records: tenantRows.map((r) => ({ get: (k: string) => r[k] })) }
        },
      }),
    close: async () => {},
  }),
}))

const {
  assertScriptingEnabled, getScriptingPlan, invalidateScriptingPlanCache,
  isTenantOwnedDefinition, SCRIPTING_PLAN_CACHE_TTL_MS,
} = await import('../scriptingPlan.js')

beforeEach(() => {
  runQueries.length = 0
  tenantRows = []
  invalidateScriptingPlanCache()
})

describe('assertScriptingEnabled', () => {
  it('piano con script → passa e legge una sola volta (poi cache)', async () => {
    tenantRows = [{ plan: 'pro', scriptingEnabled: true }]
    await expect(assertScriptingEnabled('t1', 'server.rack.validation_script')).resolves.toBeUndefined()
    await expect(assertScriptingEnabled('t1', 'server.rack.validation_script')).resolves.toBeUndefined()
    expect(runQueries).toHaveLength(1)
    expect(runQueries[0]!.params).toEqual({ tenantId: 't1' })
  })

  it('piano SENZA script → BAD_USER_INPUT che nomina script, piano e tenant (mai un salto silenzioso)', async () => {
    tenantRows = [{ plan: 'starter', scriptingEnabled: false }]
    const err = await assertScriptingEnabled('t1', 'server.rack.validation_script').then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('BAD_USER_INPUT')
    expect((err as GraphQLError).message).toContain('server.rack.validation_script')
    expect((err as GraphQLError).message).toContain('il piano "starter" del tenant t1 non include gli script')
  })

  it('tenant senza nodo :Tenant → errore che nomina la migrazione', async () => {
    tenantRows = []
    await expect(assertScriptingEnabled('t9', 'x')).rejects.toThrow(/has no :Tenant node — run the 20260910_1070/)
  })

  it('tenant senza scripting_enabled → errore che nomina la migrazione, non "abilitato per comodità"', async () => {
    tenantRows = [{ plan: 'starter', scriptingEnabled: null }]
    await expect(assertScriptingEnabled('t1', 'x')).rejects.toThrow(/has no scripting_enabled \(got null\) — run the 20260909_1010/)
  })

  it('tenant senza piano → errore esplicito', async () => {
    tenantRows = [{ plan: null, scriptingEnabled: true }]
    await expect(assertScriptingEnabled('t1', 'x')).rejects.toThrow(/has no plan/)
  })
})

describe('cache', () => {
  it('scade dopo il TTL e si può invalidare a mano (cambio di piano)', async () => {
    tenantRows = [{ plan: 'pro', scriptingEnabled: true }]
    const t0 = 1_000_000
    await getScriptingPlan('t1', t0)
    await getScriptingPlan('t1', t0 + SCRIPTING_PLAN_CACHE_TTL_MS - 1)
    expect(runQueries).toHaveLength(1)
    await getScriptingPlan('t1', t0 + SCRIPTING_PLAN_CACHE_TTL_MS + 1)
    expect(runQueries).toHaveLength(2)
    invalidateScriptingPlanCache('t1')
    await getScriptingPlan('t1', t0 + SCRIPTING_PLAN_CACHE_TTL_MS + 1)
    expect(runQueries).toHaveLength(3)
  })

  it('la cache è per tenant', async () => {
    tenantRows = [{ plan: 'pro', scriptingEnabled: true }]
    await getScriptingPlan('t1')
    await getScriptingPlan('t2')
    expect(runQueries.map((q) => q.params['tenantId'])).toEqual(['t1', 't2'])
  })
})

describe('isTenantOwnedDefinition — chi è del cliente e chi è del prodotto', () => {
  it('base e itil sono del prodotto (url, ipAddress, expiresAt, certificate): nessun limite di piano', () => {
    expect(isTenantOwnedDefinition('base')).toBe(false)
    expect(isTenantOwnedDefinition('itil')).toBe(false)
  })

  it('tenant è del cliente; uno scope assente o sconosciuto viene trattato come del cliente (prudenza)', () => {
    expect(isTenantOwnedDefinition('tenant')).toBe(true)
    expect(isTenantOwnedDefinition(undefined)).toBe(true)
    expect(isTenantOwnedDefinition('qualcosa')).toBe(true)
  })
})
