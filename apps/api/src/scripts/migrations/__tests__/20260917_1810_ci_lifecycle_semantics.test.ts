/**
 * Migrazione 20260917_1810_ci_lifecycle_semantics (ondata 7 · C-4/A-14):
 * scrive `retired_statuses` e `maintenance_statuses` sulla policy di ogni
 * tenant, con i valori che il codice usava come costanti — così il primo
 * giorno non cambia niente. Solo dove mancano; una policy corrotta ferma la
 * migrazione nominando il tenant; idempotente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ciLifecycleSemantics } from '../20260917_1810_ci_lifecycle_semantics.js'
import { MIGRATIONS } from '../index.js'
import { DEFAULT_EVENT_POLICY } from '../../../lib/eventPolicy.js'

const { retired_statuses: _r, maintenance_statuses: _m, ...POLICY_V5 } = DEFAULT_EVENT_POLICY

interface Row { id: string; value: unknown }

function fakeSession(tenants: Row[]) {
  const writes: Array<{ cypher: string; params: Record<string, unknown> }> = []
  return {
    writes,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      if (cypher.includes('MATCH (t:Tenant)')) {
        return { records: tenants.map((r) => ({ get: (k: string) => (k === 'id' ? r.id : r.value) })) }
      }
      writes.push({ cypher, params: params ?? {} })
      return { records: [] }
    }),
  }
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260917_1810_ci_lifecycle_semantics', () => {
  it('è registrata dopo la 1130, con id nel formato YYYYMMDD_HHMM_name e senza autocommit', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20260917_1810_ci_lifecycle_semantics')).toBeGreaterThan(ids.indexOf('20260911_1130_shared_domain_rules'))
    expect(ciLifecycleSemantics.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(ciLifecycleSemantics.autocommit).toBeUndefined()
  })

  it('scrive la semantica che il codice usava finora (inactive+decommissioned ritirati, maintenance in manutenzione) solo dove manca', async () => {
    const s = fakeSession([
      { id: 'acme',   value: JSON.stringify(POLICY_V5) },
      { id: 'globex', value: JSON.stringify(DEFAULT_EVENT_POLICY) },
    ])
    await ciLifecycleSemantics.up(s as never)
    expect(s.writes.map((w) => w.params['tenantId'])).toEqual(['acme'])
    expect(JSON.parse(s.writes[0]!.params['policy'] as string)).toEqual({
      ...POLICY_V5,
      retired_statuses:     ['inactive', 'decommissioned'],
      maintenance_statuses: ['maintenance'],
    })
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('2 tenants: event_policy completed 1, created 0, already complete 1')
  })

  it('una semantica GIÀ scelta dall\'amministratore non viene toccata', async () => {
    const custom = { ...DEFAULT_EVENT_POLICY, retired_statuses: ['dismesso'], maintenance_statuses: ['in_manutenzione', 'fermo_programmato'] }
    const s = fakeSession([{ id: 'acme', value: JSON.stringify(custom) }])
    await ciLifecycleSemantics.up(s as never)
    expect(s.writes).toEqual([])
  })

  it('policy assente → scritta intera dai valori iniziali; JSON corrotto → si ferma nominando il tenant', async () => {
    const s = fakeSession([{ id: 'acme', value: null }])
    await ciLifecycleSemantics.up(s as never)
    expect(JSON.parse(s.writes[0]!.params['policy'] as string)).toEqual(DEFAULT_EVENT_POLICY)

    await expect(ciLifecycleSemantics.up(fakeSession([{ id: 'acme', value: '{nope' }]) as never))
      .rejects.toThrow(/Tenant acme event_policy is corrupt JSON/)
    await expect(ciLifecycleSemantics.up(fakeSession([{ id: 'acme', value: 42 }]) as never))
      .rejects.toThrow(/Tenant acme event_policy is not a JSON string \(got number\)/)
  })

  it('idempotente: alla seconda esecuzione non manca più nulla e non si scrive', async () => {
    const s = fakeSession([{ id: 'acme', value: JSON.stringify(DEFAULT_EVENT_POLICY) }])
    await ciLifecycleSemantics.up(s as never)
    expect(s.writes).toEqual([])
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('event_policy completed 0, created 0, already complete 1')
  })

  it('database vuoto: nessuna scrittura', async () => {
    const s = fakeSession([])
    await ciLifecycleSemantics.up(s as never)
    expect(s.writes).toEqual([])
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('0 tenants')
  })
})
