/**
 * The SLA sweep (wave 7 · A1): the timers Redis lost, fired from the graph
 * through the same handler as the jobs. What must not regress: it acts only
 * past the grace period (the jobs normally win), never sends a warning twice
 * for the same deadline, sends one for a new deadline, reads the candidates
 * scoped to the tenant, and says what could not fire.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const rows = vi.hoisted(() => ({ resolve: [] as Record<string, unknown>[], response: [] as Record<string, unknown>[] }))
const calls: Array<{ cypher: string; params: Record<string, unknown> }> = []
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn() })),
  runQuery: vi.fn(async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    calls.push({ cypher, params })
    return cypher.includes('response_met: false') ? rows.response : rows.resolve
  }),
}))
const fired: Array<{ name: string; data: Record<string, unknown> }> = []
const failFor = new Set<string>()
vi.mock('../scheduler.js', () => ({
  fireSLATimer: vi.fn(async (name: string, data: Record<string, unknown>) => {
    if (failFor.has(String(data['entityId']))) throw new Error('redis down')
    fired.push({ name, data })
  }),
}))

const { runSLASweep, SLA_SWEEP_GRACE_MS } = await import('../sweep.js')

const NOW = new Date('2026-09-24T10:00:00.000Z')
const iso = (msFromNow: number) => new Date(NOW.getTime() + msFromNow).toISOString()
const MIN = 60_000
const open = (entityId: string, deadline: string, over: Record<string, unknown> = {}) =>
  ({ entityId, entityType: 'incident', resolveDeadline: deadline, warningMinutes: 30, warningSentFor: null, ...over })

beforeEach(() => { rows.resolve = []; rows.response = []; calls.length = 0; fired.length = 0; failFor.clear() })

describe('runSLASweep', () => {
  it('reads only this tenant\'s open, running SLAs, and the overdue responses before the cutoff', async () => {
    await runSLASweep('t1', NOW)
    expect(calls[0]!.cypher).toContain('{tenant_id: $tenantId, breached: false, resolve_met: false}')
    expect(calls[0]!.cypher).toContain('s.resolved_at IS NULL AND s.paused_at IS NULL')
    expect(calls[0]!.params).toEqual({ tenantId: 't1' })
    expect(calls[1]!.cypher).toContain('{tenant_id: $tenantId, response_met: false}')
    expect(calls[1]!.params).toEqual({ tenantId: 't1', cutoff: iso(-SLA_SWEEP_GRACE_MS) })
  })

  it('a deadline passed beyond the grace fires the breach; one inside the grace is left to its job', async () => {
    rows.resolve = [open('late', iso(-SLA_SWEEP_GRACE_MS - MIN)), open('just', iso(-MIN), { warningSentFor: iso(-MIN) })]
    const summary = await runSLASweep('t1', NOW)
    expect(fired).toEqual([{ name: 'sla.breach', data: { tenantId: 't1', entityId: 'late', entityType: 'incident', resolveDeadline: iso(-SLA_SWEEP_GRACE_MS - MIN) } }])
    expect(summary).toEqual({ warnings: 0, breaches: 1, responses: 0, failed: 0 })
  })

  it('a warning whose time has passed goes out once per deadline: not again for the same, again for a new one', async () => {
    const deadline = iso(20 * MIN)                     // warning at -10 min
    rows.resolve = [
      open('due', deadline),
      open('sent', deadline, { warningSentFor: deadline }),
      open('moved', deadline, { warningSentFor: iso(5 * MIN) }),
      open('early', iso(60 * MIN)),                    // warning at +30 min
    ]
    const summary = await runSLASweep('t1', NOW)
    expect(fired.map((f) => [f.name, f.data['entityId']])).toEqual([['sla.warning', 'due'], ['sla.warning', 'moved']])
    expect(summary.warnings).toBe(2)
  })

  it('an overdue response fires the response breach', async () => {
    rows.response = [{ entityId: 'r1', entityType: 'service_request', resolveDeadline: iso(60 * MIN) }]
    expect(await runSLASweep('t1', NOW)).toMatchObject({ responses: 1 })
    expect(fired).toEqual([{ name: 'sla.response_breach', data: { tenantId: 't1', entityId: 'r1', entityType: 'service_request', resolveDeadline: iso(60 * MIN) } }])
  })

  it('a timer that cannot fire, or a status without a readable deadline, is counted and the others still fire', async () => {
    rows.resolve = [open('broken', 'not a date'), open('down', iso(-10 * MIN)), open('ok', iso(-10 * MIN))]
    failFor.add('down')
    const summary = await runSLASweep('t1', NOW)
    expect(summary).toEqual({ warnings: 0, breaches: 1, responses: 0, failed: 2 })
    expect(fired.map((f) => f.data['entityId'])).toEqual(['ok'])
  })
})
