/**
 * services/events/storm.ts — end-of-storm re-evaluation and the cooldown
 * clock, the paths the facade suite (services/__tests__/eventStorm.test.ts)
 * does not reach.
 *
 * Why these behaviours matter: alarms that clear DURING a storm are only
 * re-evaluated when the storm ends. If one re-evaluation fails and the job
 * still "succeeds", the incident it should have closed stays open forever
 * with nobody told. So every alarm is attempted (one failure does not skip
 * the others), each failure is logged, and the job then FAILS so it is
 * retried. And a malformed clock must be an error, not a storm that never
 * (or always) cools down.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('@opengraphity/sla', () => ({ getTenantTimezone: vi.fn(async () => 'Europe/Rome') }))
vi.mock('../../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'en'), languageForUser: vi.fn(async () => 'en') }))
vi.mock('../../../lib/domainMatrix.js', () => import('../../../lib/__tests__/domainMatrixFake.js'))
vi.mock('../../../lib/bullmq.js', () => ({ getSharedRedis: () => ({}) }))
vi.mock('../../../lib/publishEvent.js', () => ({ publishEvent: vi.fn() }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../../middleware/metrics.js', () => ({ eventStormsActive: { set: vi.fn() }, incidentsAutoOpenedTotal: { inc: vi.fn() }, redisLockTimeoutsTotal: { inc: vi.fn() }, redisLockHoldSeconds: { observe: vi.fn() } }))
vi.mock('../../incidentService.js', () => ({ createIncident: vi.fn(), addIncidentComment: vi.fn() }))
vi.mock('../policy.js', () => ({ getEventPolicy: vi.fn() }))
const runEventPipeline = vi.fn()
vi.mock('../pipeline.js', () => ({ runEventPipeline }))
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => log } }))

const { reevaluateResolvedDuringStorm, stormCooledDown } = await import('../storm.js')
const { getSession, runQuery } = await import('@opengraphity/neo4j')

const session = { close: vi.fn(async () => undefined) }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getSession).mockReturnValue(session as never)
})

describe('reevaluateResolvedDuringStorm', () => {
  it('reads the cleared alarms of this tenant and source since the storm began', async () => {
    vi.mocked(runQuery).mockResolvedValue([] as never)
    await reevaluateResolvedDuringStorm('t1', 'hook-1', '2026-09-22T09:00:00.000Z', 'monitoring')
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toContain("MATCH (e:Event {tenant_id: $tenantId, source_id: $sourceId, status: 'resolved'})")
    expect(cypher).toContain('(i:Incident {tenant_id: $tenantId})')
    expect(params).toEqual({ tenantId: 't1', sourceId: 'hook-1', since: '2026-09-22T09:00:00.000Z' })
    expect(session.close).toHaveBeenCalled()
  })

  it('nothing cleared during the storm → 0, the pipeline is not even loaded', async () => {
    vi.mocked(runQuery).mockResolvedValue([] as never)
    expect(await reevaluateResolvedDuringStorm('t1', 'hook-1', '2026-09-22T09:00:00.000Z', 'monitoring')).toBe(0)
    expect(runEventPipeline).not.toHaveBeenCalled()
  })

  it('every alarm is re-evaluated in reevaluate mode, and the count is returned', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ eventId: 'ev-a' }, { eventId: 'ev-b' }] as never)
    runEventPipeline.mockResolvedValue({ outcome: 'auto_resolved' })
    expect(await reevaluateResolvedDuringStorm('t1', 'hook-1', 's', 'monitoring')).toBe(2)
    expect(runEventPipeline.mock.calls.map((c) => c[0])).toEqual([
      { tenantId: 't1', eventId: 'ev-a', actorId: 'monitoring', mode: 'reevaluate' },
      { tenantId: 't1', eventId: 'ev-b', actorId: 'monitoring', mode: 'reevaluate' },
    ])
  })

  it('one failing re-evaluation does not skip the others, is logged, and fails the job so it is retried', async () => {
    vi.mocked(runQuery).mockResolvedValue([{ eventId: 'ev-a' }, { eventId: 'ev-b' }, { eventId: 'ev-c' }] as never)
    runEventPipeline.mockImplementation(async ({ eventId }: { eventId: string }) => {
      if (eventId === 'ev-b') throw new Error('neo4j timeout')
      return { outcome: 'auto_resolved' }
    })

    await expect(reevaluateResolvedDuringStorm('t1', 'hook-1', 's', 'monitoring'))
      .rejects.toThrow('reevaluateResolvedDuringStorm: 1/3 alarms cleared during the storm of source hook-1 failed re-evaluation')
    // ev-c still ran after ev-b failed.
    expect(runEventPipeline).toHaveBeenCalledTimes(3)
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', sourceId: 'hook-1', eventId: 'ev-b' }), expect.any(String))
  })

  it('a failing read still closes the session', async () => {
    vi.mocked(runQuery).mockRejectedValue(new Error('db down'))
    await expect(reevaluateResolvedDuringStorm('t1', 'hook-1', 's', 'monitoring')).rejects.toThrow('db down')
    expect(session.close).toHaveBeenCalled()
  })
})

describe('stormCooledDown — clock validation', () => {
  it('a malformed "now" is an error, not a storm that silently never ends', () => {
    expect(() => stormCooledDown('2026-09-22T10:00:00.000Z', 'not-a-date', 5)).toThrow(/now "not-a-date" is not an ISO date/)
  })
})
