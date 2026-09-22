/**
 * logBuffer — the circular buffer behind the «Log» page.
 *
 * The buffer is capped (2000 rows) so a chatty process cannot eat the API's
 * memory. Once it wraps, the newest rows overwrite the oldest ones, and the page
 * must still show them newest-first: if the reconstruction were off by one, an
 * admin chasing an error would see a stale row on top and miss the one that
 * just happened.
 */
import { describe, it, expect } from 'vitest'
import { pushLog, getLogs, tutteLeRighe, type LogEntry } from '../logBuffer.js'

const MAX = 2000

const row = (n: number, tenantId: string | null = 't1'): LogEntry => ({
  id: `r${n}`, timestamp: new Date(1_700_000_000_000 + n).toISOString(),
  level: 'info', module: 'test', message: `row ${n}`, data: null, tenantId,
})

describe('logBuffer after it wraps', () => {
  // The buffer belongs to the module (fresh per test file): these steps build on each other.
  it('never holds more than the cap, and drops the oldest rows first', () => {
    for (let n = 0; n < MAX + 5; n++) pushLog(row(n))
    const all = tutteLeRighe()
    expect(all).toHaveLength(MAX)
    expect(all[0]!.id).toBe(`r${MAX + 4}`)
    // Rows 0..4 were overwritten: the oldest still present is row 5.
    expect(all[MAX - 1]!.id).toBe('r5')
    expect(all.map((e) => e.id)).not.toContain('r4')
  })

  it('keeps a strict newest-first order across the wrap point', () => {
    const ids = tutteLeRighe().map((e) => Number(e.id.slice(1)))
    for (let i = 1; i < ids.length; i++) expect(ids[i]).toBe(ids[i - 1]! - 1)
  })

  it('still filters by tenant once wrapped, platform rows included in the whole buffer only', () => {
    pushLog(row(9001, 't2'))
    pushLog(row(9002, null))
    expect(getLogs('t2').map((e) => e.id)).toEqual(['r9001'])
    expect(getLogs('t1')[0]!.id).toBe(`r${MAX + 4}`)
    expect(tutteLeRighe()[0]!.id).toBe('r9002')
    expect(tutteLeRighe()).toHaveLength(MAX)
  })
})
