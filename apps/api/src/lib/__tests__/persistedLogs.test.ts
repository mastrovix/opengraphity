/**
 * The persisted browser logs (`:LogEntry`) shown on the Logs page.
 *
 * Why it matters: these nodes were written for years and never read. The
 * reader must stay tenant-scoped (one customer never sees another's browser
 * errors), must run its two queries one after the other on the same session
 * (a Neo4j session cannot run two at once — found live, not by tests), must
 * report the true total so the page can say the window is truncated, and the
 * merge with the in-memory ring must give one newest-first timeline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LogEntry } from '../logBuffer.js'

let active = 0
let maxConcurrent = 0
const calls: Array<{ q: string; p: Record<string, unknown> }> = []
let rows: Record<string, unknown>[] = []
let total: unknown = 0
let failOn: string | null = null
const close = vi.fn(async () => undefined)

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    run: async (q: string, p: Record<string, unknown>) => {
      active++
      maxConcurrent = Math.max(maxConcurrent, active)
      calls.push({ q, p })
      await new Promise((r) => setTimeout(r, 1))
      active--
      if (failOn && q.includes(failOn)) throw new Error('neo4j down')
      if (q.includes('count(l)')) return { records: total === undefined ? [] : [{ get: () => total }] }
      return { records: rows.map((r) => ({ get: (k: string) => r[k] })) }
    },
    close,
  }),
  toNumber: (v: unknown) => Number(v),
}))

const { righePersistite, fondi, MAX_RIGHE, RIGHE_CYPHER, CONTEGGIO_CYPHER } = await import('../persistedLogs.js')

beforeEach(() => {
  active = 0; maxConcurrent = 0; calls.length = 0; rows = []; total = 0; failOn = null
  close.mockClear()
})

describe('righePersistite', () => {
  it('reads only the tenant rows, newest first, capped at the declared window', async () => {
    await righePersistite('t1')
    expect(RIGHE_CYPHER).toMatch(/\{tenant_id: \$tenantId\}/)
    expect(CONTEGGIO_CYPHER).toMatch(/\{tenant_id: \$tenantId\}/)
    expect(calls[0]).toEqual({ q: RIGHE_CYPHER, p: { tenantId: 't1', max: MAX_RIGHE } })
    expect(calls[1]).toEqual({ q: CONTEGGIO_CYPHER, p: { tenantId: 't1' } })
  })

  it('never runs the two queries at the same time on one session', async () => {
    await righePersistite('t1', 10)
    expect(maxConcurrent).toBe(1)
  })

  it('maps rows with defaults for missing fields and the tenant stamped on', async () => {
    rows = [
      { id: 'l1', timestamp: '2026-09-20T10:00:00Z', level: 'error', module: 'portal', message: 'boom', data: '{"x":1}' },
      { id: 'l2', timestamp: '2026-09-20T09:00:00Z', level: null, module: null, message: null, data: null },
    ]
    total = 5000
    const r = await righePersistite('t1', 2)
    expect(r.righe).toEqual([
      { id: 'l1', timestamp: '2026-09-20T10:00:00Z', level: 'error', module: 'portal', message: 'boom', data: '{"x":1}', tenantId: 't1' },
      // a browser row without level/module is an info from the frontend, not a crash of the page
      { id: 'l2', timestamp: '2026-09-20T09:00:00Z', level: 'info', module: 'frontend', message: '', data: null, tenantId: 't1' },
    ])
    // the total exceeds the rows returned: that is how the page knows the window is cut
    expect(r.totale).toBe(5000)
  })

  it('a count query with no row means zero, not a crash', async () => {
    total = undefined
    expect((await righePersistite('t1')).totale).toBe(0)
  })

  it('closes the session even when a query fails', async () => {
    failOn = 'count(l)'
    await expect(righePersistite('t1')).rejects.toThrow('neo4j down')
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('fondi', () => {
  const e = (id: string, timestamp: string): LogEntry => ({ id, timestamp, level: 'info', module: 'm', message: id, data: null, tenantId: 't1' })

  it('merges the server ring and the browser rows into one newest-first timeline', () => {
    const merged = fondi(
      [e('srv-a', '2026-09-20T10:00:00Z'), e('srv-b', '2026-09-20T08:00:00Z')],
      [e('web-a', '2026-09-20T09:00:00Z'), e('web-b', '2026-09-20T11:00:00Z')],
    )
    expect(merged.map((x) => x.id)).toEqual(['web-b', 'srv-a', 'web-a', 'srv-b'])
  })

  it('keeps both entries with the same timestamp and does not mutate the inputs', () => {
    const mem = [e('a', '2026-09-20T10:00:00Z')]
    const per = [e('b', '2026-09-20T10:00:00Z')]
    expect(fondi(mem, per).map((x) => x.id).sort()).toEqual(['a', 'b'])
    expect(mem).toHaveLength(1)
    expect(per).toHaveLength(1)
  })
})
