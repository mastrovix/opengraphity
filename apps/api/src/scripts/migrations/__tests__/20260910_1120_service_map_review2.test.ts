/**
 * Migrazione 20260910_1120_service_map_review2 (revisione 2, ondata 1):
 * recupera `ServiceMap.stale_reason` sulle mappe già marcate «da rivedere»
 * (`missing_ci` se un id di `node_ids` non ha più la sua INCLUDES, altrimenti
 * `over_limit`) e conta le mappe `maintenance` che aspettano ancora
 * `health_if_active` dalla prima valutazione. Idempotente; su un database
 * senza mappe stale non scrive nulla.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { serviceMapReview2 } from '../20260910_1120_service_map_review2.js'
import { MIGRATIONS } from '../index.js'
import { SERVICE_STALE_REASONS } from '../../../lib/serviceVocabularies.js'

function fakeSession(written: { n: number; missing: number }, total: { n: number; stale: number; pendingIfActive: number }) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> | undefined }> = []
  return {
    calls,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      calls.push({ cypher, params })
      if (cypher.includes('m.stale_reason IS NULL')) {
        return { records: [{ get: (k: string) => (k === 'n' ? written.n : written.missing) }] }
      }
      return { records: [{ get: (k: string) => total[k as keyof typeof total] }] }
    }),
  }
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260910_1120_service_map_review2', () => {
  it('è registrata dopo la 1110 e prima della 1130, con id nel formato YYYYMMDD_HHMM_name e senza autocommit', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20260910_1120_service_map_review2')).toBeGreaterThan(ids.indexOf('20260910_1110_service_map_auto_sync'))
    // L'ondata 3 della revisione 2 ha aggiunto la 1130 in coda: l'ordine resta quello di scrittura.
    expect(ids.indexOf('20260911_1130_shared_domain_rules')).toBe(ids.indexOf('20260910_1120_service_map_review2') + 1)
    expect(serviceMapReview2.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(serviceMapReview2.autocommit).toBeUndefined()
  })

  it('scrive stale_reason SOLO sulle mappe stale che non ce l\'hanno, dal grafo (missing_ci vs over_limit); non tocca stale né version', async () => {
    const s = fakeSession({ n: 2, missing: 1 }, { n: 5, stale: 2, pendingIfActive: 0 })
    await serviceMapReview2.up(s as never)

    const write = s.calls[0]!
    expect(write.cypher).toContain('WHERE m.stale = true AND m.stale_reason IS NULL')
    expect(write.cypher).toContain('any(x IN coalesce(m.node_ids, []) WHERE NOT x IN includedIds) AS hasMissing')
    expect(write.cypher).toContain("SET m.stale_reason = CASE WHEN hasMissing THEN 'missing_ci' ELSE 'over_limit' END")
    // i due motivi vengono dal vocabolario, non da stringhe inventate qui
    for (const reason of SERVICE_STALE_REASONS) expect(write.cypher).toContain(`'${reason}'`)
    expect(write.cypher).not.toContain('SET m.stale =')
    expect(write.cypher).not.toContain('m.version')
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('5 ServiceMap, 2 stale: stale_reason written on 2 (1 missing_ci, 1 over_limit)')
  })

  it('idempotente: alla seconda esecuzione nessuna mappa stale senza motivo', async () => {
    const s = fakeSession({ n: 0, missing: 0 }, { n: 5, stale: 2, pendingIfActive: 0 })
    await serviceMapReview2.up(s as never)
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('stale_reason written on 0 (0 missing_ci, 0 over_limit)')
  })

  it('le mappe `maintenance` senza health_if_active sono contate, non inventate (le scrive la prima valutazione)', async () => {
    const s = fakeSession({ n: 0, missing: 0 }, { n: 3, stale: 0, pendingIfActive: 2 })
    await serviceMapReview2.up(s as never)
    expect(s.calls.every((c) => !c.cypher.includes('SET m.health_if_active'))).toBe(true)
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('2 maintenance maps still waiting for health_if_active')
  })

  it('database senza mappe: nessuna scrittura da riportare', async () => {
    const s = fakeSession({ n: 0, missing: 0 }, { n: 0, stale: 0, pendingIfActive: 0 })
    await serviceMapReview2.up(s as never)
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('0 ServiceMap, 0 stale')
  })
})
