/**
 * Migrazione 20260910_1110_service_map_auto_sync: scrive
 * `ServiceMap.auto_sync = true` (mappa viva, il default dell'ondata 5) SOLO
 * sulle mappe che non ce l'hanno, lasciando `synced_at` a null. Idempotente;
 * un interruttore già spento a mano non viene riacceso; su un database senza
 * mappe non fa nulla.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { serviceMapAutoSync } from '../20260910_1110_service_map_auto_sync.js'
import { MIGRATIONS } from '../index.js'

function fakeSession(written: number, total: { n: number; live: number }) {
  const calls: Array<{ cypher: string; params: Record<string, unknown> | undefined }> = []
  return {
    calls,
    run: vi.fn(async (cypher: string, params?: Record<string, unknown>) => {
      calls.push({ cypher, params })
      if (cypher.includes('WHERE m.auto_sync IS NULL')) {
        return { records: [{ get: () => written }] }
      }
      return { records: [{ get: (k: string) => (k === 'n' ? total.n : total.live) }] }
    }),
  }
}

beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })

describe('20260910_1110_service_map_auto_sync', () => {
  it('è registrata dopo la 1100 (e prima della 1120), con id nel formato YYYYMMDD_HHMM_name e senza autocommit', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20260910_1110_service_map_auto_sync')).toBeGreaterThan(ids.indexOf('20260910_1100_service_map_plan_limit'))
    expect(ids.indexOf('20260910_1110_service_map_auto_sync')).toBeLessThan(ids.indexOf('20260910_1120_service_map_review2'))
    expect(serviceMapAutoSync.id).toMatch(/^\d{8}_\d{4}_[a-z0-9_]+$/)
    expect(serviceMapAutoSync.autocommit).toBeUndefined()
  })

  it('scrive auto_sync = true solo dove manca (guardia IS NULL) e non tocca synced_at', async () => {
    const s = fakeSession(3, { n: 3, live: 3 })
    await serviceMapAutoSync.up(s as never)

    const write = s.calls[0]!
    expect(write.cypher).toContain('MATCH (m:ServiceMap)')
    expect(write.cypher).toContain('WHERE m.auto_sync IS NULL')
    expect(write.cypher).toContain('SET m.auto_sync = true')
    // `synced_at` resta assente: la mappa non è ancora stata sincronizzata da nessuno
    expect(write.cypher).not.toContain('synced_at')
    expect(write.params!['now']).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('3 ServiceMap: auto_sync written 3, live now 3, frozen 0')
  })

  it('idempotente: alla seconda esecuzione nessuna mappa senza auto_sync; un interruttore spento a mano resta spento', async () => {
    const s = fakeSession(0, { n: 4, live: 3 })
    await serviceMapAutoSync.up(s as never)
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('4 ServiceMap: auto_sync written 0, live now 3, frozen 1')
  })

  it('database senza mappe: nessuna scrittura da riportare', async () => {
    const s = fakeSession(0, { n: 0, live: 0 })
    await serviceMapAutoSync.up(s as never)
    expect(vi.mocked(console.log).mock.calls.at(-1)![0]).toContain('0 ServiceMap: auto_sync written 0, live now 0, frozen 0')
  })
})
