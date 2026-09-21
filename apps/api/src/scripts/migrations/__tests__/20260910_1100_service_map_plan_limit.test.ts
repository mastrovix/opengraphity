/**
 * Migrazione 20260910_1100_service_map_plan_limit: scrive
 * `Tenant.max_service_maps` (starter 5, pro 50, enterprise 200 —
 * lib/tenantPlans.ts) SOLO sui tenant che non ce l'hanno, dal piano del
 * tenant. Idempotente; un limite già presente (anche cambiato a mano) non si
 * tocca; un `plan` fuori vocabolario FERMA la migrazione con il tenant nel
 * messaggio.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { serviceMapPlanLimit } from '../20260910_1100_service_map_plan_limit.js'
import { MIGRATIONS } from '../index.js'
import { PLAN_SETTINGS } from '../../../lib/tenantPlans.js'

interface TenantRow { id: string; plan: unknown; limit: unknown }

function fakeSession(tenants: TenantRow[]) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> | undefined }> = []
  return {
    calls,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      calls.push({ cypher, params })
      if (cypher.includes('RETURN t.id AS id, t.plan AS plan')) {
        return { records: tenants.map((t) => ({ get: (k: string) => (k === 'id' ? t.id : k === 'plan' ? t.plan : t.limit) })) }
      }
      return { records: [] }
    }),
  }
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260910_1100_service_map_plan_limit', () => {
  it('è registrata dopo la 1090 e prima della 1110, con id nel formato YYYYMMDD_HHMM_name e senza autocommit', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20260910_1100_service_map_plan_limit')).toBeGreaterThan(ids.indexOf('20260910_1090_service_notification_rules'))
    expect(ids.indexOf('20260910_1100_service_map_plan_limit')).toBeLessThan(ids.indexOf('20260910_1110_service_map_auto_sync'))
    expect(serviceMapPlanLimit.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(serviceMapPlanLimit.autocommit).toBeUndefined()
  })

  it('i valori del piano vengono da PLAN_SETTINGS: starter 5, pro 50, enterprise 200', () => {
    expect([PLAN_SETTINGS.starter, PLAN_SETTINGS.pro, PLAN_SETTINGS.enterprise].map((s) => s.max_service_maps)).toEqual([5, 50, 200])
  })

  it('scrive il limite del piano su ogni tenant che non ce l\'ha, con toInteger e la guardia IS NULL', async () => {
    const s = fakeSession([
      { id: 'acme', plan: 'starter', limit: null },
      { id: 'beta', plan: 'pro', limit: null },
      { id: 'gamma', plan: 'enterprise', limit: null },
    ])
    await serviceMapPlanLimit.up(s as never)

    const read = s.calls[0]!
    expect(read.cypher).toContain('MATCH (t:Tenant)')
    expect(read.cypher).toContain('WHERE t.id IS NOT NULL')
    expect(read.cypher).toContain('ORDER BY t.id')

    const writes = s.calls.slice(1)
    expect(writes).toHaveLength(3)
    expect(writes[0]!.cypher).toContain('MATCH (t:Tenant {id: $tenantId})')
    expect(writes[0]!.cypher).toContain('WHERE t.max_service_maps IS NULL')
    expect(writes[0]!.cypher).toContain('SET t.max_service_maps = toInteger($maxServiceMaps)')
    expect(writes.map((w) => [w.params!['tenantId'], w.params!['maxServiceMaps']])).toEqual([
      ['acme', 5], ['beta', 50], ['gamma', 200],
    ])
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('3 tenants: max_service_maps written 3, already set 0')
  })

  it('idempotente: un limite già presente (anche cambiato a mano) non viene riscritto', async () => {
    const s = fakeSession([{ id: 'acme', plan: 'starter', limit: 5 }, { id: 'beta', plan: 'pro', limit: 7 }])
    await serviceMapPlanLimit.up(s as never)
    expect(s.run).toHaveBeenCalledTimes(1)   // solo la lettura
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('2 tenants: max_service_maps written 0, already set 2')
  })

  it('piano assente o fuori vocabolario → la migrazione si ferma con il tenant nel messaggio (nessun piano starter di comodo)', async () => {
    await expect(serviceMapPlanLimit.up(fakeSession([{ id: 'acme', plan: null, limit: null }]) as never))
      .rejects.toThrow(/Tenant acme plan is null: expected one of starter, pro, enterprise/)
    await expect(serviceMapPlanLimit.up(fakeSession([{ id: 'beta', plan: 'gold', limit: null }]) as never))
      .rejects.toThrow(/Tenant beta plan is "gold"/)
  })

  it('database senza tenant → solo la lettura, nessuna scrittura', async () => {
    const s = fakeSession([])
    await serviceMapPlanLimit.up(s as never)
    expect(s.run).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('0 tenants: max_service_maps written 0, already set 0')
  })
})
