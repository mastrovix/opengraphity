/**
 * THE RUNNING OF A TENANT, REPAIRED WITH A PERSON'S YES (26 Sep 2026).
 *
 * What a user loses if this regresses: failed jobs nobody sees; a retry that
 * silently does not hold and is proposed again every night, hiding a defect;
 * a remedy that reaches a queue it may not touch, or retries a thousand jobs
 * at once; a verification that says «resolved» without looking.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QUEUE_REGISTRY } from '../queueRegistry.js'

const fake = vi.hoisted(() => ({
  failed: {} as Record<string, number>,
  jobs: {} as Record<string, Array<{ id: string; state: string; retried: boolean }>>,
  unresolvedCauses: new Set<string>(),
  due: [] as Array<{ id: string; action: string | null; details: string | null }>,
  writes: [] as Array<Record<string, unknown>>,
}))

vi.mock('../bullmq.js', () => ({
  getTenantQueue: (base: string) => ({
    getJobCounts: async () => ({ failed: fake.failed[base] ?? 0 }),
    getJobs: async (_types: string[], start: number, end: number) =>
      (fake.jobs[base] ?? []).filter((j) => j.state === 'failed').slice(start, end + 1).map((j) => ({
        id: j.id,
        retry: async () => { j.retried = true; j.state = 'waiting' },
      })),
    getJob: async (id: string) => {
      const j = (fake.jobs[base] ?? []).find((x) => x.id === id)
      return j ? { getState: async () => j.state } : undefined
    },
  }),
}))
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: async () => {} }),
  runQueryOne: async (_s: unknown, _q: string, params: { cause: string }) => ({ n: fake.unresolvedCauses.has(params.cause) ? 1 : 0 }),
  runQuery: async (_s: unknown, q: string, params: Record<string, unknown>) => {
    if (q.includes('RETURN p.id AS id, p.action AS action')) return fake.due
    fake.writes.push(params)
    return []
  },
}))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
const graph = vi.hoisted(() => ({
  alarms: vi.fn(async (): Promise<unknown[]> => []),
  maps:   vi.fn(async (): Promise<unknown[]> => []),
  health: vi.fn(async (): Promise<unknown[]> => []),
  flows:  vi.fn(async (): Promise<unknown[]> => []),
}))
vi.mock('../operationsGraphRemedies.js', () => ({
  detectStuckAlarms: graph.alarms, detectStaleServiceMaps: graph.maps,
  detectCIHealthOutOfStep: graph.health, detectStuckWorkflows: graph.flows,
  verifyAlarms: vi.fn(), verifyCIHealth: vi.fn(), verifyServiceMap: vi.fn(), verifyWorkflows: vi.fn(),
}))

const {
  detectFailedJobs, retryFailedJobs, verifyRetry, verifyRemedies, analizzaFunzionamento, OPERATIONS_LIMITS,
} = await import('../operationsRemedies.js')
const { logger } = await import('../logger.js')

const RETRYABLE = QUEUE_REGISTRY.filter((e) => e.scope === 'tenant' && e.retryable).map((e) => e.name)
const NOT_RETRYABLE = QUEUE_REGISTRY.find((e) => e.scope === 'tenant' && !e.retryable)!.name
const Q = RETRYABLE[0]!
const NOW = new Date('2026-09-26T08:00:00Z')

function failedJobs(queue: string, n: number) {
  fake.jobs[queue] = Array.from({ length: n }, (_, i) => ({ id: `j${String(i + 1)}`, state: 'failed', retried: false }))
  fake.failed[queue] = n
}

beforeEach(() => {
  fake.failed = {}
  fake.jobs = {}
  fake.unresolvedCauses = new Set()
  fake.due = []
  fake.writes = []
  vi.clearAllMocks()
})

describe('the detector of failed jobs', () => {
  it('there is a registered retryable queue of the tenant to look at', () => {
    expect(RETRYABLE.length).toBeGreaterThan(0)
  })

  it('no failed job, no proposal', async () => {
    expect(await detectFailedJobs('t-a', NOW)).toEqual([])
  })

  it('failed jobs on a retryable queue: a proposal to retry them, twenty at most, one per cause per day', async () => {
    failedJobs(Q, 37)
    const [p, ...rest] = await detectFailedJobs('t-a', NOW)
    expect(rest).toEqual([])
    expect(p).toMatchObject({
      tenantId: 't-a', area: 'operations', kind: 'proposal.operationsFailedJobs',
      params: { queue: Q, count: '37', cause: `queue:${Q}` },
      scope: `queue:${Q}:2026-09-26`, cause: `queue:${Q}`,
      evidence: { n: 37, windowDays: 1, refs: [] },
      action: { type: 'queue.retry_failed', params: { queue: Q, max: OPERATIONS_LIMITS.retryMax } },
    })
  })

  it('a run of a periodic job is not proposed: its next repetition already did the work', async () => {
    failedJobs(Q, 2)
    fake.jobs[Q]!.push({ id: 'repeat:workflow-ola-sweep:1790190765007', state: 'failed', retried: false })
    const [p] = await detectFailedJobs('t-a', NOW)
    expect(p?.params['count']).toBe('2')
    fake.jobs[Q] = [{ id: 'repeat:sla-sweep:1', state: 'failed', retried: false }]
    expect(await detectFailedJobs('t-a', NOW)).toEqual([])
    await expect(retryFailedJobs('t-a', { queue: Q, max: 5 })).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.proposal.noFailedJobs' } } })
  })

  it('never twice on the same cause without a person: after a retry that did not hold, a proposal to read', async () => {
    failedJobs(Q, 4)
    fake.unresolvedCauses.add(`queue:${Q}`)
    const [p] = await detectFailedJobs('t-a', NOW)
    expect(p).toMatchObject({ kind: 'proposal.operationsFailedJobsNotHeld', action: null, params: { queue: Q, count: '4' } })
  })
})

describe('the remedy: retrying the failed jobs of one queue', () => {
  it('retries them oldest first, twenty at most even when asked for more, and says which', async () => {
    failedJobs(Q, 25)
    const out = await retryFailedJobs('t-a', { queue: Q, max: 100 })
    expect(out.undoState).toBeNull()
    expect(out.details).toMatchObject({ queue: Q, retried: 20 })
    expect((out.details['jobIds'] as string[])[0]).toBe('j1')
    expect(fake.jobs[Q]!.filter((j) => j.retried)).toHaveLength(20)
  })

  it('a queue that is not the tenant\'s, or whose jobs may not be retried, is refused — the parameters are not trusted', async () => {
    await expect(retryFailedJobs('t-a', { queue: 'rm -rf', max: 5 })).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.proposal.queueUnknown' } } })
    await expect(retryFailedJobs('t-a', { queue: NOT_RETRYABLE, max: 5 })).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.proposal.queueNotRetryable' } } })
  })

  it('nothing failed any more (someone retried by hand): refused, not a silent success', async () => {
    failedJobs(Q, 0)
    await expect(retryFailedJobs('t-a', { queue: Q, max: 5 })).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.proposal.noFailedJobs' } } })
  })
})

describe('the verification', () => {
  it('resolved when none of the retried jobs failed again; a job no longer in the queue has run', async () => {
    fake.jobs[Q] = [{ id: 'j1', state: 'completed', retried: true }]
    expect(await verifyRetry('t-a', { queue: Q, jobIds: ['j1', 'j-gone'] })).toEqual({
      verification: 'resolved', detail: { queue: Q, retried: 2, failedAgain: 0 },
    })
  })

  it('unresolved when one failed again', async () => {
    fake.jobs[Q] = [{ id: 'j1', state: 'completed', retried: true }, { id: 'j2', state: 'failed', retried: true }]
    expect((await verifyRetry('t-a', { queue: Q, jobIds: ['j1', 'j2'] })).verification).toBe('unresolved')
  })

  it('the pass writes the outcome on each proposal due; one that cannot be verified is said and left for the next pass', async () => {
    fake.jobs[Q] = [{ id: 'j1', state: 'completed', retried: true }]
    fake.due = [
      { id: 'p-1', action: JSON.stringify({ type: 'queue.retry_failed' }), details: JSON.stringify({ queue: Q, jobIds: ['j1'] }) },
      { id: 'p-2', action: JSON.stringify({ type: 'unknown.action' }), details: '{}' },
    ]
    expect(await verifyRemedies('t-a', NOW)).toEqual({ verified: 1 })
    expect(fake.writes).toEqual([expect.objectContaining({ id: 'p-1', verification: 'resolved', now: NOW.toISOString() })])
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(expect.objectContaining({ proposal: 'p-2' }), expect.any(String))
  })
})

describe('the analyst of the running', () => {
  it('asks every detector, and one that fails does not take the others\' proposals with it — it is said', async () => {
    failedJobs(Q, 2)
    graph.alarms.mockRejectedValueOnce(new Error('neo4j down'))
    graph.flows.mockResolvedValueOnce([{ kind: 'proposal.operationsStuckWorkflows' }])
    const out = await analizzaFunzionamento('t-a', NOW)
    expect(out.map((p) => p.kind)).toEqual(['proposal.operationsFailedJobs', 'proposal.operationsStuckWorkflows'])
    for (const d of [graph.maps, graph.health, graph.flows]) expect(d).toHaveBeenCalledWith('t-a', NOW)
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(expect.objectContaining({ err: 'neo4j down' }), expect.any(String))
    // A detector failed: nothing is expired, it has not said its proposals are gone.
    expect(fake.writes).toEqual([])
  })

  it('every detector looked: the open operational proposals nobody found again expire, the ones found stay', async () => {
    failedJobs(Q, 2)
    const out = await analizzaFunzionamento('t-a', NOW)
    const { fingerprintOf } = await import('../proposals.js')
    expect(fake.writes).toEqual([{ tenantId: 't-a', keep: out.map((p) => fingerprintOf(p.area, p.kind, p.scope)), now: NOW.toISOString() }])
  })
})
