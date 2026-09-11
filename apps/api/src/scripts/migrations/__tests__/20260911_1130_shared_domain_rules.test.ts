/**
 * Migrazione 20260911_1130_shared_domain_rules (revisione 2, ondata 3):
 * scrive `ignore_lifecycle_statuses` nella policy di ogni tenant (D6.3) e
 * `during_storm` nelle regole di ogni mappa (D6.4), SOLO dove mancano e con i
 * default dei vocabolari. Policy o regole con JSON corrotto fermano la
 * migrazione con il tenant (o la mappa) nel messaggio; idempotente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sharedDomainRules } from '../20260911_1130_shared_domain_rules.js'
import { MIGRATIONS } from '../index.js'
import { DEFAULT_EVENT_POLICY } from '../../../lib/eventPolicy.js'
import { DEFAULT_SERVICE_IMPACT_RULES } from '../../../lib/serviceVocabularies.js'

const { ignore_lifecycle_statuses: _i, ...POLICY_V4 } = DEFAULT_EVENT_POLICY
const { during_storm: _d, ...RULES_V1 } = DEFAULT_SERVICE_IMPACT_RULES

interface Row { id: string; value: unknown }

function fakeSession(tenants: Row[], maps: Row[]) {
  const writes: Array<{ cypher: string; params: Record<string, unknown> }> = []
  const records = (rows: Row[], key: string) => rows.map((r) => ({ get: (k: string) => (k === 'id' ? r.id : r.value), _key: key }))
  return {
    writes,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      if (cypher.includes('MATCH (t:Tenant)')) return { records: records(tenants, 'policy') }
      if (cypher.includes('MATCH (m:ServiceMap)\n      RETURN')) return { records: records(maps, 'rules') }
      writes.push({ cypher, params: params ?? {} })
      return { records: [] }
    }),
  }
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260911_1130_shared_domain_rules', () => {
  it('è registrata per ultima, con id nel formato YYYYMMDD_HHMM_name e senza autocommit', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.at(-1)).toBe('20260911_1130_shared_domain_rules')
    expect(sharedDomainRules.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(sharedDomainRules.autocommit).toBeUndefined()
  })

  it('completa la policy dei tenant con ignore_lifecycle_statuses e le regole delle mappe con during_storm, senza toccare i valori esistenti', async () => {
    const s = fakeSession(
      [{ id: 'acme', value: JSON.stringify(POLICY_V4) }, { id: 'globex', value: JSON.stringify(DEFAULT_EVENT_POLICY) }],
      [{ id: 'map-1', value: JSON.stringify(RULES_V1) }, { id: 'map-2', value: JSON.stringify({ ...DEFAULT_SERVICE_IMPACT_RULES, during_storm: 'evaluate' }) }],
    )
    await sharedDomainRules.up(s as never)
    // solo il tenant e la mappa incompleti vengono riscritti
    expect(s.writes.map((w) => w.params['tenantId'] ?? w.params['mapId'])).toEqual(['acme', 'map-1'])
    expect(JSON.parse(s.writes[0]!.params['policy'] as string)).toEqual({ ...POLICY_V4, ignore_lifecycle_statuses: ['decommissioned'] })
    expect(JSON.parse(s.writes[1]!.params['rules'] as string)).toEqual({ ...RULES_V1, during_storm: 'hold' })
    // non tocca version né le altre proprietà della mappa
    expect(s.writes[1]!.cypher).toContain('SET m.rules = $rules, m.updated_at = $now')
    expect(s.writes[1]!.cypher).not.toContain('m.version')
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('2 tenants: event_policy completed 1, created 0, already complete 1; 2 ServiceMap: rules completed 1, created 0, already complete 1')
  })

  it('policy o regole assenti → scritte intere dai default; JSON corrotto → la migrazione si ferma nominando il tenant o la mappa', async () => {
    const s = fakeSession([{ id: 'acme', value: null }], [{ id: 'map-1', value: '' }])
    await sharedDomainRules.up(s as never)
    expect(JSON.parse(s.writes[0]!.params['policy'] as string)).toEqual(DEFAULT_EVENT_POLICY)
    expect(JSON.parse(s.writes[1]!.params['rules'] as string)).toEqual(DEFAULT_SERVICE_IMPACT_RULES)

    await expect(sharedDomainRules.up(fakeSession([{ id: 'acme', value: '{nope' }], []) as never))
      .rejects.toThrow(/Tenant acme event_policy is corrupt JSON/)
    await expect(sharedDomainRules.up(fakeSession([], [{ id: 'map-9', value: '[]' }]) as never))
      .rejects.toThrow(/ServiceMap map-9 rules is not a JSON object/)
    await expect(sharedDomainRules.up(fakeSession([{ id: 'acme', value: 42 }], []) as never))
      .rejects.toThrow(/Tenant acme event_policy is not a JSON string \(got number\)/)
  })

  it('idempotente: alla seconda esecuzione non manca più nulla e non si scrive', async () => {
    const s = fakeSession([{ id: 'acme', value: JSON.stringify(DEFAULT_EVENT_POLICY) }], [{ id: 'map-1', value: JSON.stringify(DEFAULT_SERVICE_IMPACT_RULES) }])
    await sharedDomainRules.up(s as never)
    expect(s.writes).toEqual([])
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('event_policy completed 0, created 0, already complete 1')
  })

  it('database vuoto: nessuna scrittura da riportare', async () => {
    const s = fakeSession([], [])
    await sharedDomainRules.up(s as never)
    expect(s.writes).toEqual([])
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('0 tenants')
  })
})
