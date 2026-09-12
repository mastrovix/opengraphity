/**
 * Migrazione 20260918_1910 (ondata 8 · D-14 + A-18): per ogni `:Tenant` chiama
 * la STESSA `provisionTenantData` dell'onboarding, così un tenant nato da una
 * migrazione (webhook, chiave API, import, o un onboarding interrotto) è
 * usabile come uno onboardato; e normalizza `values` dei vocabolari scritti
 * come stringa JSON.
 *
 * Quello che va pinnato è l'igiene: il tenant condiviso `system` è escluso, un
 * tenant già completo non viene toccato, e la migrazione è registrata.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const provisionCalls: string[] = []
const gaps = new Map<string, string[]>()

vi.mock('../../../lib/provisionTenantData.js', () => ({
  provisionTenantData: vi.fn(async (_s: unknown, tenantId: string) => {
    provisionCalls.push(tenantId)
    gaps.set(tenantId, [])
    return { dashboardCreated: true, notificationRulesCreated: 35, matricesCreated: [], workflows: [{ name: 'X', created: true }] }
  }),
  tenantProvisioningGaps: vi.fn(async (_s: unknown, tenantId: string) => gaps.get(tenantId) ?? []),
}))

const { provisionTenantDataMigration, SHARED_TENANT_ID } = await import('../20260918_1910_provision_tenant_data.js')
const { MIGRATIONS } = await import('../index.js')

function fakeSession(tenants: string[], nonListEnums: Array<{ tenantId: string; name: string; values: unknown }> = []) {
  const writes: Array<{ cypher: string; params: Record<string, unknown> }> = []
  return {
    writes,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      if (cypher.includes('MATCH (t:Tenant)')) {
        return { records: tenants.map((id) => ({ get: () => id })) }
      }
      if (cypher.includes('NOT e.values IS :: LIST<ANY>')) {
        return { records: nonListEnums.map((e) => ({ get: (k: string) => (e as Record<string, unknown>)[k] })) }
      }
      writes.push({ cypher, params: params ?? {} })
      return { records: [] }
    }),
  }
}

beforeEach(() => { provisionCalls.length = 0; gaps.clear(); vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260918_1910 — un tenant nasce in un modo', () => {
  it('è registrata in MIGRATIONS, una volta sola', () => {
    expect(MIGRATIONS.filter((m) => m.id === provisionTenantDataMigration.id)).toHaveLength(1)
  })

  it('il tenant condiviso `system` è escluso: non è un cliente', async () => {
    const s = fakeSession(['c-one', 'c-two'])
    gaps.set('c-two', ['nessun workflow attivo per: incident'])
    await provisionTenantDataMigration.up(s as never)
    const [cypher, params] = s.run.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toContain('t.id <> $shared')
    expect(params['shared']).toBe(SHARED_TENANT_ID)
  })

  it('un tenant completo non viene toccato; quello incompleto sì', async () => {
    const s = fakeSession(['c-one', 'c-two'])
    gaps.set('c-one', [])
    gaps.set('c-two', ['nessun workflow attivo per: incident, problem'])
    await provisionTenantDataMigration.up(s as never)
    expect(provisionCalls).toEqual(['c-two'])
  })

  it('A-18: values come stringa JSON → riscritto come lista', async () => {
    const s = fakeSession([], [{ tenantId: 'system', name: 'ci_chain', values: '["Application","Infrastructure"]' }])
    await provisionTenantDataMigration.up(s as never)
    const write = s.writes.find((w) => w.cypher.includes('SET e.values = $values'))!
    expect(write.params['values']).toEqual(['Application', 'Infrastructure'])
    expect(write.params['name']).toBe('ci_chain')
  })

  it.each([
    [42,               /non è né una lista né una stringa/],
    ['{non json',      /non è una stringa JSON|non è JSON/],
    ['{"a":1}',        /non è una lista di stringhe/],
    ['[1,2]',          /non è una lista di stringhe/],
  ])('values %j → la migrazione si ferma nominando il vocabolario', async (values, pattern) => {
    const s = fakeSession([], [{ tenantId: 'system', name: 'rotto', values }])
    await expect(provisionTenantDataMigration.up(s as never)).rejects.toThrow(pattern)
    expect(s.writes.some((w) => w.cypher.includes('SET e.values'))).toBe(false)
  })
})
