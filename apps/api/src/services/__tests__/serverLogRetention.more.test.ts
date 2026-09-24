/**
 * THE NIGHTLY LOG PURGE, END TO END (against a fake Neo4j session).
 *
 * The rules (how many days, which cut-off) are pinned in
 * `serverLogRetention.test.ts`; this file pins the pass that applies them:
 *  - it counts BEFORE deleting, so the maintenance log reports real numbers
 *    (`IN TRANSACTIONS` returns nothing usable);
 *  - it skips a registry with nothing to delete, instead of paying for a
 *    batched delete over 270,000 nodes that deletes zero;
 *  - the server registry is cut by DAY (`YYYY-MM-DD`), the browser one by the
 *    full ISO instant: swapping the two parameters deletes the wrong nodes;
 *  - the write session is closed even when the delete fails, or a failed
 *    night leaks a connection every night until the pool runs dry;
 *  - a malformed retention setting stops the pass before anything is deleted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => {
  const state = {
    counts: { server: 0, browser: 0 } as { server: unknown; browser: unknown },
    failWrite: false,
    runs: [] as Array<{ mode: string; cypher: string; params: Record<string, unknown>; txConfig?: unknown }>,
    closed: [] as string[],
  }
  const getSession = (_db: unknown, mode: string) => ({
    run: async (cypher: string, params: Record<string, unknown>, txConfig?: unknown) => {
      state.runs.push({ mode, cypher, params, txConfig })
      if (cypher.includes('RETURN count(l) AS n')) {
        const n = cypher.includes(':ServerLogEntry') ? state.counts.server : state.counts.browser
        return { records: n === undefined ? [] : [{ get: (k: string) => (k === 'n' ? n : undefined) }] }
      }
      if (state.failWrite) throw new Error('neo4j: heap exhausted')
      return { records: [] }
    },
    close: async () => { state.closed.push(mode) },
  })
  return { state, getSession }
})

vi.mock('@opengraphity/neo4j', () => ({
  getSession: h.getSession,
  MAINTENANCE_TX_CONFIG: { timeout: 7_200_000 },
  toNumber: (v: unknown) => (typeof v === 'object' && v !== null && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : Number(v)),
}))

vi.mock('neo4j-driver', () => ({ default: { session: { READ: 'READ', WRITE: 'WRITE' } } }))

vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { child: () => child } }
})

import { purgaIRegistriDeiLog, PURGA_SERVER_CYPHER, PURGA_BROWSER_CYPHER } from '../serverLogRetention.js'

const NOW = Date.parse('2026-09-20T12:00:00.000Z')

beforeEach(() => {
  h.state.counts = { server: 0, browser: 0 }
  h.state.failWrite = false
  h.state.runs = []
  h.state.closed = []
  vi.stubEnv('SERVER_LOG_RETENTION_DAYS', '')
})

afterEach(() => { vi.unstubAllEnvs() })

const writes = () => h.state.runs.filter((r) => r.mode === 'WRITE')

describe('purgaIRegistriDeiLog', () => {
  it('deletes from both registries and reports what it counted, with the right cut-off for each', async () => {
    // Neo4j integers arrive as objects with toNumber(): the report must be a plain number.
    h.state.counts = { server: { toNumber: () => 12 }, browser: 270000 }
    const out = await purgaIRegistriDeiLog(NOW)

    expect(out).toEqual({ server: 12, browser: 270000, giorni: 90 })
    expect(writes().map((w) => w.cypher)).toEqual([PURGA_SERVER_CYPHER, PURGA_BROWSER_CYPHER])
    // The server registry dates by day, the browser one by full instant.
    expect(writes()[0]!.params).toEqual({ limiteGiorno: '2026-06-22' })
    expect(writes()[1]!.params).toEqual({ limite: '2026-06-22T12:00:00.000Z' })
    // `IN TRANSACTIONS` lasts the whole purge: both deletes carry the maintenance limit (wave 7 · A2).
    expect(writes().map((w) => w.txConfig)).toEqual([{ timeout: 7_200_000 }, { timeout: 7_200_000 }])
    // Both counting sessions and the write session are released.
    expect(h.state.closed.sort()).toEqual(['READ', 'READ', 'WRITE'])
  })

  it('does not run a delete over a registry with nothing old in it', async () => {
    h.state.counts = { server: 0, browser: 3 }
    const out = await purgaIRegistriDeiLog(NOW)
    expect(out).toEqual({ server: 0, browser: 3, giorni: 90 })
    expect(writes().map((w) => w.cypher)).toEqual([PURGA_BROWSER_CYPHER])
  })

  it('treats a count query with no row as zero, and deletes nothing', async () => {
    h.state.counts = { server: undefined, browser: undefined }
    const out = await purgaIRegistriDeiLog(NOW)
    expect(out).toEqual({ server: 0, browser: 0, giorni: 90 })
    expect(writes()).toEqual([])
  })

  it('honours the configured retention', async () => {
    vi.stubEnv('SERVER_LOG_RETENTION_DAYS', '30')
    h.state.counts = { server: 1, browser: 0 }
    const out = await purgaIRegistriDeiLog(NOW)
    expect(out.giorni).toBe(30)
    expect(writes()[0]!.params).toEqual({ limiteGiorno: '2026-08-21' })
  })

  it('closes the write session even when the delete fails', async () => {
    h.state.counts = { server: 5, browser: 5 }
    h.state.failWrite = true
    await expect(purgaIRegistriDeiLog(NOW)).rejects.toThrow('heap exhausted')
    expect(h.state.closed).toContain('WRITE')
  })

  it('refuses to run with a malformed retention, before touching the database', async () => {
    vi.stubEnv('SERVER_LOG_RETENTION_DAYS', '0')
    await expect(purgaIRegistriDeiLog(NOW)).rejects.toThrow(/SERVER_LOG_RETENTION_DAYS/)
    expect(h.state.runs).toEqual([])
  })

  it('defaults to now when no instant is given', async () => {
    h.state.counts = { server: 0, browser: 1 }
    await purgaIRegistriDeiLog()
    const limite = writes()[0]!.params['limite'] as string
    // Ninety days back from "now", give or take the test's own runtime.
    expect(Math.abs(Date.parse(limite) - (Date.now() - 90 * 86_400_000))).toBeLessThan(60_000)
  })
})
