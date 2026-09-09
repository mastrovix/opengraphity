/**
 * Migrazione 20260909_1060_event_management_policy_version: aggiunge
 * `version` / `updated_at` (e ogni altra chiave mancante) alle policy dei
 * tenant, crea la policy intera dove manca, non riscrive quelle già complete,
 * si ferma su JSON corrotto. Idempotente.
 */
import { describe, it, expect, vi } from 'vitest'
import { eventManagementPolicyVersion } from '../20260909_1060_event_management_policy_version.js'
import { MIGRATIONS } from '../index.js'
import { DEFAULT_EVENT_POLICY, DEFAULT_EVENT_POLICY_JSON } from '../../../lib/eventPolicy.js'

const { version: _v, updated_at: _u, ...UNVERSIONED } = DEFAULT_EVENT_POLICY

function fakeSession(tenants: Array<{ id: string; policy: unknown }>) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> | undefined }> = []
  return {
    calls,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      calls.push({ cypher, params })
      if (cypher.includes('RETURN t.id AS id, t.event_policy AS policy')) {
        return { records: tenants.map((t) => ({ get: (k: string) => (k === 'id' ? t.id : t.policy) })) }
      }
      return { records: [] }
    }),
  }
}

describe('20260909_1060_event_management_policy_version', () => {
  it('è l\'ultima registrata, dopo la 1050, con id nel formato YYYYMMDD_HHMM_name', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.at(-1)).toBe('20260909_1060_event_management_policy_version')
    expect(ids.indexOf('20260909_1060_event_management_policy_version')).toBeGreaterThan(ids.indexOf('20260909_1050_event_management_indexes'))
    expect(eventManagementPolicyVersion.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
  })

  it('policy senza version/updated_at → completata (version 1, updated_at null) conservando i valori; senza policy → default intero; completa → non riscritta', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const custom = { ...UNVERSIONED, retention_days: 30, open_incident_from: 'warning' }
    const s = fakeSession([
      { id: 'acme', policy: JSON.stringify(custom) },
      { id: 'beta', policy: null },
      { id: 'done', policy: DEFAULT_EVENT_POLICY_JSON },
    ])
    await eventManagementPolicyVersion.up(s as never)
    const writes = s.calls.filter((c) => c.cypher.includes('SET t.event_policy = $policy'))
    expect(writes.map((w) => w.params!['tenantId'])).toEqual(['acme', 'beta'])
    expect(JSON.parse(writes[0]!.params!['policy'] as string)).toEqual({ ...custom, version: 1, updated_at: null })
    expect(writes[1]!.params!['policy']).toBe(DEFAULT_EVENT_POLICY_JSON)
    expect(writes[0]!.cypher).toContain('MATCH (t:Tenant {id: $tenantId})')
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('event_policy versioned 1, created 1, already versioned 1')
  })

  it('JSON corrotto o non oggetto → la migrazione si ferma con il tenant nel messaggio, nulla scritto', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const bad = fakeSession([{ id: 'acme', policy: '{nope' }])
    await expect(eventManagementPolicyVersion.up(bad as never)).rejects.toThrow(/Tenant acme event_policy is corrupt JSON/)
    expect(bad.calls.some((c) => c.cypher.includes('SET t.event_policy'))).toBe(false)
    const list = fakeSession([{ id: 'acme', policy: '[1]' }])
    await expect(eventManagementPolicyVersion.up(list as never)).rejects.toThrow(/Tenant acme event_policy is not a JSON object/)
    const notString = fakeSession([{ id: 'acme', policy: 42 }])
    await expect(eventManagementPolicyVersion.up(notString as never)).rejects.toThrow(/is not a JSON string/)
  })
})
