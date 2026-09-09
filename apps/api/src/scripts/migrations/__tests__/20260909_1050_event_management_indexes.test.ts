/**
 * Migrazione 20260909_1050_event_management_indexes: backfill di
 * `ConfigurationItem.name_key = toLower(name)` a lotti, idempotente (solo dove
 * manca o non combacia più con il nome); gli indici vivono in
 * packages/neo4j/src/init.ts (verificati in init.test.ts).
 */
import { describe, it, expect, vi } from 'vitest'
import { eventManagementIndexes, NAME_KEY_BACKFILL_BATCH } from '../20260909_1050_event_management_indexes.js'
import { MIGRATIONS } from '../index.js'

function fakeSession(counts: number[]) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> | undefined }> = []
  let i = 0
  return {
    calls,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      calls.push({ cypher, params })
      const n = counts[i++] ?? 0
      return { records: [{ get: (k: string) => (k === 'n' ? n : undefined) }] }
    }),
  }
}

describe('20260909_1050_event_management_indexes', () => {
  it('è registrata dopo la 1040 e ha un id nel formato YYYYMMDD_HHMM_name', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    // Non più l'ultima: la 1060 (versione della policy, revisione C-4) la segue.
    expect(ids).toContain('20260909_1050_event_management_indexes')
    expect(ids.indexOf('20260909_1050_event_management_indexes')).toBeGreaterThan(ids.indexOf('20260909_1040_event_management_policy_v2'))
    expect(eventManagementIndexes.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(eventManagementIndexes.autocommit).toBeUndefined()
  })

  it('backfill a lotti finché un lotto è pieno: 5000 + 12 → due statement, poi si ferma; log con il totale', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession([NAME_KEY_BACKFILL_BATCH, 12])
    await eventManagementIndexes.up(s as never)
    expect(s.run).toHaveBeenCalledTimes(2)
    const { cypher, params } = s.calls[0]!
    expect(cypher).toContain('MATCH (ci:ConfigurationItem)')
    expect(cypher).toContain('WHERE ci.name IS NOT NULL AND (ci.name_key IS NULL OR ci.name_key <> toLower(ci.name))')
    expect(cypher).toContain('WITH ci LIMIT toInteger($batch)')   // il driver manda i numeri JS come Float: LIMIT vuole un intero
    expect(cypher).toContain('SET ci.name_key = toLower(ci.name)')
    expect(params).toEqual({ batch: NAME_KEY_BACKFILL_BATCH })
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('name_key backfilled on 5012 CI in 2 batch(es)')
  })

  it('idempotente: nulla da fare → un solo statement, 0 CI', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const s = fakeSession([0])
    await eventManagementIndexes.up(s as never)
    expect(s.run).toHaveBeenCalledTimes(1)
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('backfilled on 0 CI in 0 batch(es)')
  })
})
