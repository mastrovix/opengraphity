/**
 * Wave 7 · A1: the SLA sweep's indexes, created on an existing database with
 * the same form as init.ts, and the warnings already due marked as sent so the
 * first sweep does not send them again.
 */
import { describe, it, expect, vi } from 'vitest'
import { slaSweepIndexes } from '../20261009_1010_sla_sweep_indexes.js'

function session(marked: number) {
  const run = vi.fn(async (q: string) => ({ records: q.includes('SET s.warning_sent_for') ? [{ get: () => marked }] : [] }))
  return { run }
}

describe('20261009_1010_sla_sweep_indexes', () => {
  it('creates the two indexes idempotently, waits for them, then marks the warnings already due', async () => {
    const s = session(21)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await slaSweepIndexes.up(s as never)
    const queries = s.run.mock.calls.map((c) => c[0] as string)
    expect(queries[0]).toBe('CREATE INDEX sla_status_tenant_open IF NOT EXISTS FOR (n:SLAStatus) ON (n.tenant_id, n.breached, n.resolve_met)')
    expect(queries[1]).toBe('CREATE INDEX sla_status_tenant_response IF NOT EXISTS FOR (n:SLAStatus) ON (n.tenant_id, n.response_met)')
    expect(queries[2]).toBe('CALL db.awaitIndexes(300)')
    // Only open SLAs not yet breached, not already marked, whose warning time has passed; marked for their own deadline.
    expect(queries[3]).toContain('{breached: false, resolve_met: false}')
    expect(queries[3]).toContain('s.resolved_at IS NULL AND s.warning_sent_for IS NULL')
    expect(queries[3]).toContain('SET s.warning_sent_for = s.resolve_deadline')
    expect(log).toHaveBeenCalledWith('  2 indexes checked, 21 warning(s) already due marked as sent')
    log.mockRestore()
  })

  it('runs outside the marker\'s transaction: schema commands need autocommit', () => {
    expect(slaSweepIndexes.autocommit).toBe(true)
    expect(slaSweepIndexes.id).toBe('20261009_1010_sla_sweep_indexes')
  })
})
