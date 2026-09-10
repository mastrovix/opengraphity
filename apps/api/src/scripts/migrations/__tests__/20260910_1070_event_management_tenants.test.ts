/**
 * Migrazione 20260910_1070_event_management_tenants: crea i nodi :Tenant
 * mancanti unendo (UNION) i tenant_id di User, InboundWebhook, ApiKey e
 * ConfigurationItem (la 1010 guardava solo gli :User), poi completa ogni
 * event_policy con `match_short_hostname` (e ogni altra chiave mancante),
 * crea la policy intera dove manca, non riscrive quelle complete, si ferma
 * su JSON corrotto. Idempotente.
 */
import { describe, it, expect, vi } from 'vitest'
import { eventManagementTenants, TENANT_ID_SOURCE_LABELS } from '../20260910_1070_event_management_tenants.js'
import { MIGRATIONS } from '../index.js'
import { DEFAULT_EVENT_POLICY, DEFAULT_EVENT_POLICY_JSON } from '../../../lib/eventPolicy.js'
import { DEFAULT_TENANT_PLAN, DEFAULT_TENANT_TIMEZONE, PLAN_SETTINGS } from '../../../lib/tenantPlans.js'

const { match_short_hostname: _m, ...WITHOUT_V4 } = DEFAULT_EVENT_POLICY

function fakeSession(tenants: Array<{ id: string; policy: unknown }>, merged = { created: 0, total: tenants.length }) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> | undefined }> = []
  return {
    calls,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      calls.push({ cypher, params })
      if (cypher.includes('MERGE (t:Tenant {id: tid})')) {
        return { records: [{ get: (k: string) => (k === 'created' ? merged.created : merged.total) }] }
      }
      if (cypher.includes('RETURN t.id AS id, t.event_policy AS policy')) {
        return { records: tenants.map((t) => ({ get: (k: string) => (k === 'id' ? t.id : t.policy) })) }
      }
      return { records: [] }
    }),
  }
}

describe('20260910_1070_event_management_tenants', () => {
  it('è l\'ultima registrata, dopo la 1060, con id nel formato YYYYMMDD_HHMM_name', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.at(-1)).toBe('20260910_1070_event_management_tenants')
    expect(ids.indexOf('20260910_1070_event_management_tenants')).toBeGreaterThan(ids.indexOf('20260909_1060_event_management_policy_version'))
    expect(eventManagementTenants.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(eventManagementTenants.autocommit).toBeUndefined()
  })

  it('UNION dei tenant_id di User, InboundWebhook, ApiKey e ConfigurationItem → MERGE :Tenant con i campi predefiniti della 1010 (ON CREATE: gli esistenti non si toccano)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession([], { created: 2, total: 5 })
    await eventManagementTenants.up(s as never)
    const merge = s.calls.find((c) => c.cypher.includes('MERGE (t:Tenant {id: tid})'))!
    expect(TENANT_ID_SOURCE_LABELS).toEqual(['User', 'InboundWebhook', 'ApiKey', 'ConfigurationItem'])
    for (const label of TENANT_ID_SOURCE_LABELS) {
      expect(merge.cypher).toContain(`MATCH (n:${label}) WHERE n.tenant_id IS NOT NULL AND n.tenant_id <> '' RETURN DISTINCT n.tenant_id AS tid`)
    }
    expect(merge.cypher.match(/\bUNION\b/g)).toHaveLength(3)
    expect(merge.cypher).toContain('CALL {')
    expect(merge.cypher).toContain('WITH DISTINCT tid')
    expect(merge.cypher).toContain('ON CREATE SET')
    expect(merge.cypher).not.toMatch(/ON MATCH SET/)
    const settings = PLAN_SETTINGS[DEFAULT_TENANT_PLAN]
    expect(merge.params).toMatchObject({
      plan: DEFAULT_TENANT_PLAN, timezone: DEFAULT_TENANT_TIMEZONE,
      slaEnabled: settings.sla_enabled, scriptingEnabled: settings.scripting_enabled, maxUsers: settings.max_users, maxCi: settings.max_ci,
    })
    expect(typeof merge.params!['now']).toBe('string')
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain(':Tenant created 2 of 5 tenant_id found on User/InboundWebhook/ApiKey/ConfigurationItem')
  })

  it('policy senza match_short_hostname → completata (false) conservando i valori; senza policy (tenant appena creato) → default intero versionato; completa → non riscritta', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const custom = { ...WITHOUT_V4, retention_days: 30, version: 4 }
    const s = fakeSession([
      { id: 'acme', policy: JSON.stringify(custom) },
      { id: 'beta', policy: null },
      { id: 'done', policy: JSON.stringify({ ...DEFAULT_EVENT_POLICY, match_short_hostname: true }) },
    ])
    await eventManagementTenants.up(s as never)
    const writes = s.calls.filter((c) => c.cypher.includes('SET t.event_policy = $policy'))
    expect(writes.map((w) => w.params!['tenantId'])).toEqual(['acme', 'beta'])
    expect(JSON.parse(writes[0]!.params!['policy'] as string)).toEqual({ ...custom, match_short_hostname: false })
    expect(writes[1]!.params!['policy']).toBe(DEFAULT_EVENT_POLICY_JSON)
    expect(JSON.parse(DEFAULT_EVENT_POLICY_JSON)).toMatchObject({ version: 1, updated_at: null, match_short_hostname: false })
    expect(writes[0]!.cypher).toContain('MATCH (t:Tenant {id: $tenantId})')
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('3 tenants: event_policy completed 1, created 1, already complete 1')
  })

  it('idempotente: seconda esecuzione con tutto completo → solo le due letture, nessuna scrittura', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession([{ id: 'acme', policy: DEFAULT_EVENT_POLICY_JSON }])
    await eventManagementTenants.up(s as never)
    expect(s.run).toHaveBeenCalledTimes(2)
    expect(s.calls.some((c) => c.cypher.includes('SET t.event_policy'))).toBe(false)
  })

  it('JSON corrotto o non oggetto → la migrazione si ferma con il tenant nel messaggio, nulla scritto', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const bad = fakeSession([{ id: 'acme', policy: '{nope' }])
    await expect(eventManagementTenants.up(bad as never)).rejects.toThrow(/Tenant acme event_policy is corrupt JSON/)
    expect(bad.calls.some((c) => c.cypher.includes('SET t.event_policy'))).toBe(false)
    const list = fakeSession([{ id: 'acme', policy: '[1]' }])
    await expect(eventManagementTenants.up(list as never)).rejects.toThrow(/Tenant acme event_policy is not a JSON object/)
    const notString = fakeSession([{ id: 'acme', policy: 42 }])
    await expect(eventManagementTenants.up(notString as never)).rejects.toThrow(/is not a JSON string/)
  })
})
