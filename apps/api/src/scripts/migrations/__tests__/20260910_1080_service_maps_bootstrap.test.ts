/**
 * Migrazione 20260910_1080_service_maps_bootstrap: completa i campi
 * dell'ondata 1 e node_ids (dalle INCLUDES) sulle ServiceMap dove mancano,
 * completa/crea `rules` con i default, non riscrive quelle complete, si ferma
 * su JSON corrotto. Su un database senza mappe non fa nulla. Idempotente.
 */
import { describe, it, expect, vi } from 'vitest'
import { serviceMapsBootstrap } from '../20260910_1080_service_maps_bootstrap.js'
import { MIGRATIONS } from '../index.js'
import { DEFAULT_SERVICE_IMPACT_RULES, DEFAULT_SERVICE_IMPACT_RULES_JSON, SERVICE_MAP_DEFAULT_DEPTH, SERVICE_RELATIONSHIP_TYPES } from '../../../lib/serviceVocabularies.js'

function fakeSession(maps: Array<{ id: string; rules: unknown }>, completedFields = 0) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> | undefined }> = []
  return {
    calls,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      calls.push({ cypher, params })
      if (cypher.includes('m.node_ids           = coalesce(m.node_ids')) return { records: [{ get: () => completedFields }] }
      if (cypher.includes('RETURN m.id AS id, m.rules AS rules')) return { records: maps.map((m) => ({ get: (k: string) => (k === 'id' ? m.id : m.rules) })) }
      return { records: [] }
    }),
  }
}

describe('20260910_1080_service_maps_bootstrap', () => {
  it('è registrata fra la 1070 e la 1090, con id nel formato YYYYMMDD_HHMM_name e senza autocommit', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20260910_1080_service_maps_bootstrap')).toBeLessThan(ids.indexOf('20260910_1090_service_notification_rules'))
    expect(ids.indexOf('20260910_1080_service_maps_bootstrap')).toBeGreaterThan(ids.indexOf('20260910_1070_event_management_tenants'))
    expect(serviceMapsBootstrap.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(serviceMapsBootstrap.autocommit).toBeUndefined()
  })

  it('campi dell\'ondata 1 e node_ids solo dove mancano (coalesce), con relazioni e profondità di default', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession([], 3)
    await serviceMapsBootstrap.up(s as never)
    const fields = s.calls.find((c) => c.cypher.includes('m.node_ids'))!
    expect(fields.cypher).toContain('MATCH (m:ServiceMap)')
    expect(fields.cypher).toContain('WHERE m.stale IS NULL OR m.version IS NULL OR m.built_from IS NULL OR m.status IS NULL OR m.health IS NULL')
    for (const f of ['stale', 'version', 'built_from', 'status', 'health', 'impact_score', 'explanation', 'relationship_types', 'max_depth']) {
      expect(fields.cypher).toMatch(new RegExp(`m\\.${f}\\s+= coalesce\\(m\\.${f},`))
    }
    expect(fields.cypher).toContain('m.node_ids           = coalesce(m.node_ids, [(m)-[:INCLUDES]->(ci) | ci.id])')
    expect(fields.params).toMatchObject({ relationshipTypes: [...SERVICE_RELATIONSHIP_TYPES], maxDepth: SERVICE_MAP_DEFAULT_DEPTH })
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('wave-1 fields/node_ids completed on 3')
  })

  it('rules senza una chiave → completata conservando i valori; assente → default intero; completa → non riscritta', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { min_nodes: _m, ...partial } = { ...DEFAULT_SERVICE_IMPACT_RULES, down_share_pct: 70 }
    const s = fakeSession([
      { id: 'a', rules: JSON.stringify(partial) },
      { id: 'b', rules: null },
      { id: 'c', rules: DEFAULT_SERVICE_IMPACT_RULES_JSON },
    ])
    await serviceMapsBootstrap.up(s as never)
    const writes = s.calls.filter((c) => c.cypher.includes('SET m.rules = $rules'))
    expect(writes.map((w) => w.params!['mapId'])).toEqual(['a', 'b'])
    expect(JSON.parse(writes[0]!.params!['rules'] as string)).toEqual({ ...partial, min_nodes: 1 })
    expect(writes[1]!.params!['rules']).toBe(DEFAULT_SERVICE_IMPACT_RULES_JSON)
    expect(writes[0]!.cypher).toContain('MATCH (m:ServiceMap {id: $mapId})')
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('3 ServiceMap: wave-1 fields/node_ids completed on 0; rules completed 1, created 1, already complete 1')
  })

  it('idempotente e no-op su un database senza mappe: solo le due letture/SET condizionali, nessuna scrittura di regole', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession([])
    await serviceMapsBootstrap.up(s as never)
    expect(s.run).toHaveBeenCalledTimes(2)
    expect(s.calls.some((c) => c.cypher.includes('SET m.rules'))).toBe(false)
  })

  it('rules con JSON corrotto, non oggetto o non stringa → la migrazione si ferma con la mappa nel messaggio, nulla scritto', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const bad = fakeSession([{ id: 'm1', rules: '{nope' }])
    await expect(serviceMapsBootstrap.up(bad as never)).rejects.toThrow(/ServiceMap m1 rules is corrupt JSON/)
    expect(bad.calls.some((c) => c.cypher.includes('SET m.rules'))).toBe(false)
    await expect(serviceMapsBootstrap.up(fakeSession([{ id: 'm1', rules: '[1]' }]) as never)).rejects.toThrow(/is not a JSON object/)
    await expect(serviceMapsBootstrap.up(fakeSession([{ id: 'm1', rules: 42 }]) as never)).rejects.toThrow(/is not a JSON string/)
  })
})
