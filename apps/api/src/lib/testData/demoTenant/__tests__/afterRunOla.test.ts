/**
 * THE RUN'S OLA CONTRACTS ARE SWITCHED ON AFTER THE PAST IS MARKED (review of 23 Sep 2026).
 *
 * The contracts are written switched off (writeReference.ts), so the OLA
 * sweep of the running workers does not send the past's alerts in the
 * minutes before they are marked. What must hold: the marking counts the
 * run's contracts although they are off, and the switch-on touches only the
 * run's own, still-off contracts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const calls: Array<{ cypher: string; params: Record<string, unknown> }> = []
vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    calls.push({ cypher, params })
    return cypher.includes('SET o.enabled = true') ? [{ n: 12 }] : []
  }),
  toNumber: (v: unknown) => Number(v),
}))
vi.mock('@opengraphity/sla', () => ({ calendarFor: vi.fn(), getTenantTimezone: vi.fn(), scheduleBreachCheck: vi.fn(), scheduleResponseCheck: vi.fn(), scheduleWarning: vi.fn() }))

const { markOlaAlerts, enableRunOlaContracts } = await import('../afterRun.js')

beforeEach(() => { calls.length = 0 })

describe('the run\'s OLA contracts', () => {
  it('the marking reads the enabled contracts and the run\'s own, still switched off', async () => {
    await markOlaAlerts({} as never, 'demo', new Date('2026-09-23T12:00:00Z'), 'run-1')
    expect(calls[0]!.cypher).toContain('(coalesce(o.enabled, true) = true OR o.demo_run_id = $runId)')
    expect(calls[0]!.params).toEqual({ tenantId: 'demo', runId: 'run-1' })
  })

  it('the switch-on touches only the run\'s contracts that are off, and counts them', async () => {
    await expect(enableRunOlaContracts({} as never, 'demo', 'run-1')).resolves.toBe(12)
    expect(calls[0]!.cypher).toContain('MATCH (o:OLAContract {tenant_id: $tenantId, demo_run_id: $runId}) WHERE o.enabled = false')
    expect(calls[0]!.params).toEqual({ tenantId: 'demo', runId: 'run-1' })
  })
})
