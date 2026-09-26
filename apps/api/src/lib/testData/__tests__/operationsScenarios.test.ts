/**
 * THE CASES PUT IN BY HAND, AND TAKEN AWAY (26 Sep 2026).
 *
 * What the owner loses if this regresses: a trial that leaves a CI «down» for
 * good, a clean that removes jobs that were not the trial's, or one that
 * writes «operational» where there was no health at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fake = vi.hoisted(() => ({
  queries: [] as Array<{ q: string; params: Record<string, unknown> }>,
  answer: (_q: string): unknown[] => [],
  jobs: [] as Array<{ name: string; removed: boolean; remove: () => Promise<void> }>,
  added: [] as unknown[][],
}))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: async () => {} }),
  runQuery: async (_s: unknown, q: string, params: Record<string, unknown>) => { fake.queries.push({ q, params }); return fake.answer(q) },
  runQueryOne: async (_s: unknown, q: string, params: Record<string, unknown>) => { fake.queries.push({ q, params }); return fake.answer(q)[0] ?? null },
}))
vi.mock('../../bullmq.js', () => ({
  getTenantQueue: () => ({
    add: async (...a: unknown[]) => { fake.added.push(a) },
    getJobs: async () => fake.jobs,
  }),
}))
const sync = vi.hoisted(() => vi.fn(async () => ({ skipped: null })))
vi.mock('../../../services/serviceImpact/sync.js', () => ({ syncServiceMap: sync }))
vi.mock('../../ciLifecycle.js', () => ({ resolveCILifecycleSemantics: async () => ({ maintenance: new Set(['in_maintenance']) }) }))

const S = await import('../operationsScenarios.js')
const log = vi.fn()
const job = (name: string) => { const j = { name, removed: false, remove: async () => { j.removed = true } }; return j }

beforeEach(() => {
  fake.queries = []
  fake.answer = () => []
  fake.jobs = []
  fake.added = []
  log.mockClear()
})

describe('ci-health', () => {
  it('plants on a CI with no alarm, not in maintenance, keeping what it overwrites', async () => {
    fake.answer = () => [{ id: 'c1', name: 'db-01', backup: '{}' }]
    await S.plantScenario('ci-health', 't-a', log, new Date('2026-09-26T08:00:00Z'))
    const { q, params } = fake.queries[0]!
    expect(q).toContain("NOT EXISTS { MATCH (e:Event {tenant_id: $tenantId})-[:RAISED_ON]->(ci) WHERE e.status IN ['firing', 'flapping'] }")
    expect(q).toContain('ci.scenario_backup = apoc.convert.toJson({health: ci.health')
    expect(params).toMatchObject({ tenantId: 't-a', maintenance: ['in_maintenance'], hourAgo: '2026-09-26T07:00:00.000Z' })
  })

  it('no CI to plant on: said, not a silent nothing', async () => {
    await expect(S.plantScenario('ci-health', 't-a', log)).rejects.toThrow(/no CI without alarms/)
  })

  it('the clean puts back exactly what was there — «no health» stays «no health»', async () => {
    fake.answer = (q) => q.includes('RETURN ci.id AS id') ? [{ id: 'c1', name: 'db-01', backup: '{"health_source":"monitoring"}' }] : []
    await S.cleanScenario('ci-health', 't-a', log)
    const write = fake.queries.find((x) => x.q.includes('REMOVE ci.scenario'))!
    expect(write.params['r']).toEqual({ health: null, health_source: 'monitoring', last_event_at: null, health_since: null })
  })
})

describe('failed-job', () => {
  it('adds a job the queue does not know, tried once', async () => {
    await S.plantScenario('failed-job', 't-a', log, new Date(5))
    expect(fake.added).toEqual([[S.ALWAYS_FAILING_JOB, { tenantId: 't-a', entityId: 'scenario' }, { jobId: 'scenario-always-fails-5', attempts: 1, removeOnFail: false }]])
  })

  it('another queue can be chosen, among those that refuse an unknown job; any other is refused', async () => {
    await S.plantScenario('failed-job', 't-a', log, new Date(5), { queue: 'notification-jobs' })
    expect(log).toHaveBeenCalledWith(expect.stringContaining('added to notification-jobs'))
    await expect(S.plantScenario('failed-job', 't-a', log, new Date(5), { queue: 'sla-jobs' })).rejects.toThrow(/not "sla-jobs"/)
  })

  it('the clean removes the trial\'s jobs only', async () => {
    const mine = job(S.ALWAYS_FAILING_JOB)
    const theirs = job('ola_sweep')
    fake.jobs = [mine, theirs]
    await S.cleanScenario('failed-job', 't-a', log)
    expect([mine.removed, theirs.removed]).toEqual([true, false])
  })
})

describe('map-late', () => {
  it('plants on a live map only, and the clean gives back its auto sync', async () => {
    fake.answer = () => [{ id: 'm1', name: 'Billing' }]
    await S.plantScenario('map-late', 't-a', log)
    expect(fake.queries[0]!.q).toContain("m.auto_sync = true AND m.status = 'active'")
    fake.queries = []
    await S.cleanScenario('map-late', 't-a', log)
    expect(fake.queries[0]!.q).toContain('SET m.auto_sync = coalesce(b.auto_sync, m.auto_sync)')
  })

  it('the clean synchronizes the map again: it does not leave it looking behind the CMDB', async () => {
    fake.answer = (q) => q.includes("scenario: 'map-late'") && q.includes('REMOVE') ? [{ id: 'm1', name: 'Billing', autoSync: true }] : []
    await S.cleanScenario('map-late', 't-a', log)
    expect(sync).toHaveBeenCalledWith('t-a', 'm1', 'manual', 'system:operations-scenario')
  })
})

describe('alarm-stuck', () => {
  it('plants on a firing alarm below the severity threshold: re-evaluated, it opens no incident', async () => {
    fake.answer = () => [{ id: 'e1', title: 'CPU' }]
    await S.plantScenario('alarm-stuck', 't-a', log, new Date('2026-09-26T08:00:00Z'))
    const { q, params } = fake.queries[0]!
    expect(q).toContain("status: 'firing', correlation: 'skipped_severity'")
    expect(q).toContain("e.correlation = 'none', e.correlation_at = $seventyAgo")
    expect(params).toMatchObject({ seventyAgo: '2026-09-26T06:50:00.000Z' })
  })

  it('the clean puts the old decision back only while the alarm is still undecided', async () => {
    await S.cleanScenario('alarm-stuck', 't-a', log)
    expect(fake.queries[0]!.q).toContain("FOREACH (_ IN CASE WHEN undecided THEN [1] ELSE [] END")
  })
})

describe('lost-timer', () => {
  it('adds a sixty-minute wait with its automatic exit, and puts an incident in it with no timer, ninety minutes ago', async () => {
    fake.answer = (q) => q.includes('CREATE (w:WorkflowStep') ? [{ id: 'w1' }] : q.includes('CURRENT_STEP]->(w)') ? [{ number: 'INC1', id: 'i1' }] : []
    await S.plantScenario('lost-timer', 't-a', log, new Date('2026-09-26T08:00:00Z'))
    const [step, move] = fake.queries
    expect(step!.q).toContain("type: 'timer_wait', timer_delay_minutes: 60")
    expect(step!.q).toContain("TRANSITIONS_TO {id: randomUUID(), trigger: 'automatic'")
    expect(move!.params).toMatchObject({ ninetyAgo: '2026-09-26T06:30:00.000Z', wait: 'scenario_wait' })
  })

  it('no step created (already there, or no such workflow): said, and no incident is moved', async () => {
    await expect(S.plantScenario('lost-timer', 't-a', log)).rejects.toThrow(/Incident Management/)
    expect(fake.queries).toHaveLength(1)
  })

  it('the clean puts the incident back only if still waiting, then removes the step', async () => {
    await S.cleanScenario('lost-timer', 't-a', log)
    expect(fake.queries[0]!.q).toContain('WITH wi, cur, waiting, b WHERE waiting')
    expect(fake.queries[1]!.q).toContain("MATCH (w:WorkflowStep {tenant_id: $tenantId, scenario: 'lost-timer'})")
  })
})
