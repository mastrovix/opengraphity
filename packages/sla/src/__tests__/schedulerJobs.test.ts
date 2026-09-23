/**
 * SCHEDULING AND CANCELLING THE SLA TIMERS.
 *
 * `scheduler.test.ts` covers what happens when a timer FIRES. This file
 * covers putting them in the queue and taking them out, which is where two
 * real defects lived:
 *
 *  - rescheduling threw on a job a worker had in hand (E-22). BullMQ refuses
 *    `remove()` on an ACTIVE job, so a resume-from-pause or a policy change
 *    ended up in the failed queue and the SLA kept the old deadline.
 *  - a deadline already in the past used to schedule nothing at all, so an
 *    SLA shorter than its own warning lead never warned. It now fires
 *    immediately: late is information, silence is not.
 *
 * The job ids are part of the contract: they are what makes re-scheduling
 * idempotent, and what `cancelSLAJobs` finds again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SLAStatus } from '../status.js'

const fake = vi.hoisted(() => {
  interface FakeJob { remove: () => Promise<void>; getState: () => Promise<string> }
  const state = {
    pools: [] as Array<{ base: string; processor: unknown; closed: number }>,
    added: [] as Array<{ queue: string; name: string; data: unknown; opts: { jobId: string; delay: number; removeOnComplete?: unknown; removeOnFail?: unknown } }>,
    jobs: new Map<string, FakeJob>(),
    gotten: [] as string[],
    queuesAsked: [] as string[],
  }
  /** The tenant queues of @opengraphity/events: one fake per name, like the real singletons. */
  const queues = new Map<string, unknown>()
  function tenantQueue(base: string, tenantId: string) {
    const name = `${base}@${tenantId}`
    state.queuesAsked.push(name)
    if (!queues.has(name)) {
      queues.set(name, {
        name,
        async getJob(id: string) { state.gotten.push(`${name}/${id}`); return state.jobs.get(`${name}/${id}`) ?? null },
        async add(jobName: string, data: unknown, opts: { jobId: string; delay: number }) { state.added.push({ queue: name, name: jobName, data, opts }); return { id: opts.jobId } },
      })
    }
    return queues.get(name)
  }
  class TenantWorkerPool {
    me: { base: string; processor: unknown; closed: number }
    constructor(base: string, processor: unknown) { this.me = { base, processor, closed: 0 }; state.pools.push(this.me) }
    async close() { this.me.closed += 1 }
  }
  return { state, tenantQueue, TenantWorkerPool }
})

vi.mock('@opengraphity/events', () => ({ publish: vi.fn(), tenantQueue: fake.tenantQueue, TenantWorkerPool: fake.TenantWorkerPool }))
vi.mock('../status.js', () => ({ ticketReference: vi.fn(), getSLAStatus: vi.fn(), markBreached: vi.fn(), markResponseBreachNotified: vi.fn() }))
vi.mock('../olaBreach.js', () => ({ isEntityResolved: vi.fn() }))

const { scheduleWarning, scheduleBreachCheck, scheduleResponseCheck, cancelSLAJobs, cancelOLABreaches,
        initScheduler, closeScheduler, processSLAJob } = await import('../scheduler.js')

/** The key of a job in the fake store: the queue of tenant c-one, then the job id. */
const inQueue = (jobId: string, tenant = 'c-one') => `sla-jobs@${tenant}/${jobId}`

/** Deadlines relative to now, so the delays are predictable. */
const IN_AN_HOUR = () => new Date(Date.now() + 60 * 60_000).toISOString()
const status = (over: Partial<SLAStatus> = {}): SLAStatus => ({
  id: 'sla-1', tenant_id: 'c-one', entity_id: 'inc-1', entity_type: 'incident',
  started_at: new Date().toISOString(),
  response_deadline: IN_AN_HOUR(), resolve_deadline: IN_AN_HOUR(),
  response_met: false, resolve_met: false, breached: false,
  tier: { severity: 'high', response_minutes: 60, resolve_minutes: 240, business_hours: false, warning_minutes: 30 },
  ...over,
} as unknown as SLAStatus)

const removable = () => ({ remove: vi.fn(async () => {}), getState: vi.fn(async () => 'delayed') })
const active = () => ({
  remove: vi.fn(async () => { throw new Error('Job is locked by a worker') }),
  getState: vi.fn(async () => 'active'),
})

beforeEach(() => {
  fake.state.pools = []
  fake.state.added = []
  fake.state.jobs.clear()
  fake.state.gotten = []
  fake.state.queuesAsked = []
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('scheduling the three timers', () => {
  it('the warning fires the policy\'s lead time before the resolve deadline', async () => {
    // It used to be 30 minutes flat for everybody (NT-8/F6): a four-hour SLA
    // and a five-day one warned at the same distance from the end.
    await scheduleWarning(status({ resolve_deadline: new Date(Date.now() + 120 * 60_000).toISOString() }))
    const [a] = fake.state.added
    expect(a!.name).toBe('sla.warning')
    expect(a!.opts.jobId).toBe('warning-inc-1')
    expect(a!.opts.delay).toBeGreaterThan(88 * 60_000)   // 120 - 30, minus test time
    expect(a!.opts.delay).toBeLessThanOrEqual(90 * 60_000)
  })

  it('an SLA shorter than its own warning lead warns IMMEDIATELY, not never', async () => {
    await scheduleWarning(status({ resolve_deadline: new Date(Date.now() + 5 * 60_000).toISOString() }))
    expect(fake.state.added[0]!.opts.delay).toBe(0)
  })

  it('a tier with no valid warning lead is a configuration error naming the status', async () => {
    // Guessing a lead here would promise a warning the customer never gets.
    for (const warning_minutes of [undefined, 0, -5, 1.5, 'trenta']) {
      const s = status()
      ;(s.tier as { warning_minutes?: unknown }).warning_minutes = warning_minutes
      await expect(scheduleWarning(s)).rejects.toThrow(/SLAStatus sla-1 has no valid warning lead/)
    }
  })

  it('the breach and response checks fire at their own deadlines, with their own job ids', async () => {
    await scheduleBreachCheck(status())
    await scheduleResponseCheck(status())
    expect(fake.state.added.map((a) => [a.name, a.opts.jobId])).toEqual([
      ['sla.breach', 'breach-inc-1'],
      ['sla.response_breach', 'response-inc-1'],
    ])
  })

  it('a deadline already past fires at once instead of being dropped', async () => {
    const past = new Date(Date.now() - 60 * 60_000).toISOString()
    await scheduleBreachCheck(status({ resolve_deadline: past }))
    await scheduleResponseCheck(status({ response_deadline: past }))
    expect(fake.state.added.map((a) => a.opts.delay)).toEqual([0, 0])
  })

  it('every job carries the resolve deadline, so the handler can tell a stale timer from a live one', async () => {
    const deadline = IN_AN_HOUR()
    await scheduleBreachCheck(status({ resolve_deadline: deadline }))
    expect(fake.state.added[0]!.data).toEqual({
      entityId: 'inc-1', entityType: 'incident', tenantId: 'c-one', resolveDeadline: deadline,
    })
  })

  it('the timers of a tenant go in that tenant\'s own queue (23 Sep 2026)', async () => {
    await scheduleBreachCheck(status())
    await scheduleBreachCheck(status({ tenant_id: 'c-two', entity_id: 'inc-9' }))
    expect(fake.state.added.map((a) => [a.queue, a.opts.jobId])).toEqual([
      ['sla-jobs@c-one', 'breach-inc-1'],
      ['sla-jobs@c-two', 'breach-inc-9'],
    ])
  })

  it('every timer carries its own cleanup: completed ones go, the last 200 failed ones stay for diagnosis', async () => {
    await scheduleBreachCheck(status())
    expect(fake.state.added[0]!.opts).toMatchObject({ removeOnComplete: true, removeOnFail: 200 })
  })
})

describe('rescheduling over an existing timer', () => {
  it('the old job with the same id is removed first: re-scheduling is idempotent', async () => {
    const old = removable()
    fake.state.jobs.set(inQueue('breach-inc-1'), old)
    await scheduleBreachCheck(status())
    expect(old.remove).toHaveBeenCalledOnce()
    expect(fake.state.added[0]!.opts.jobId).toBe('breach-inc-1')
  })

  it('an ACTIVE job is not removable: the new one is queued under a distinct id (E-22)', async () => {
    // BullMQ refuses `remove()` on a job a worker holds. Letting that throw
    // put the resume-from-pause event in the failed queue, and the SLA kept
    // a deadline that no longer applied.
    fake.state.jobs.set(inQueue('breach-inc-1'), active())
    await scheduleBreachCheck(status())
    expect(fake.state.added).toHaveLength(1)
    expect(fake.state.added[0]!.opts.jobId).toMatch(/^breach-inc-1:re\d+$/)
  })

  it('a removal failing for any OTHER reason still propagates', async () => {
    // "Active" is the one case we know how to carry on from; everything else
    // would be scheduling a second timer on top of a live one.
    const broken = { remove: vi.fn(async () => { throw new Error('Redis down') }), getState: vi.fn(async () => 'delayed') }
    fake.state.jobs.set(inQueue('breach-inc-1'), broken)
    await expect(scheduleBreachCheck(status())).rejects.toThrow('Redis down')
    expect(fake.state.added).toHaveLength(0)
  })

  it('a state that cannot even be read is not treated as active', async () => {
    const broken = {
      remove: vi.fn(async () => { throw new Error('Redis down') }),
      getState: vi.fn(async () => { throw new Error('Redis down') }),
    }
    fake.state.jobs.set(inQueue('breach-inc-1'), broken)
    await expect(scheduleBreachCheck(status())).rejects.toThrow('Redis down')
  })
})

describe('cancelSLAJobs — which clock stops', () => {
  const setup = () => {
    const jobs = { warning: removable(), breach: removable(), response: removable() }
    fake.state.jobs.set(inQueue('warning-inc-1'), jobs.warning)
    fake.state.jobs.set(inQueue('breach-inc-1'), jobs.breach)
    fake.state.jobs.set(inQueue('response-inc-1'), jobs.response)
    return jobs
  }

  it('"resolve" cancels the warning and the breach: both hang off the resolve deadline', async () => {
    const j = setup()
    await cancelSLAJobs('c-one', 'inc-1', 'resolve')
    expect(j.warning.remove).toHaveBeenCalledOnce()
    expect(j.breach.remove).toHaveBeenCalledOnce()
    expect(j.response.remove).not.toHaveBeenCalled()
  })

  it('"response" cancels only the response timer', async () => {
    const j = setup()
    await cancelSLAJobs('c-one', 'inc-1', 'response')
    expect(j.response.remove).toHaveBeenCalledOnce()
    expect(j.warning.remove).not.toHaveBeenCalled()
  })

  it('the default is "both": on resolution all three go', async () => {
    const j = setup()
    await cancelSLAJobs('c-one', 'inc-1')
    expect([j.warning, j.breach, j.response].every((x) => x.remove.mock.calls.length === 1)).toBe(true)
  })

  it('a timer that is not in the queue is not an error: it already fired', async () => {
    await expect(cancelSLAJobs('c-one', 'inc-1')).resolves.toBeUndefined()
    expect(fake.state.gotten).toEqual([inQueue('warning-inc-1'), inQueue('breach-inc-1'), inQueue('response-inc-1')])
  })

  it('the timers are looked for in the tenant\'s queue only', async () => {
    const j = setup()
    await cancelSLAJobs('c-two', 'inc-1')
    expect(j.breach.remove).not.toHaveBeenCalled()
    expect(fake.state.gotten.every((g) => g.startsWith('sla-jobs@c-two/'))).toBe(true)
  })
})

describe('cancelOLABreaches — the per-ticket timers the sweep replaced', () => {
  it('removes one job per contract, keyed by contract AND entity', async () => {
    const a = removable(); const b = removable()
    fake.state.jobs.set(inQueue('ola-ola1-chg-1'), a)
    fake.state.jobs.set(inQueue('ola-ola2-chg-1'), b)
    await cancelOLABreaches('c-one', 'chg-1', ['ola1', 'ola2', 'ola3'])
    expect(a.remove).toHaveBeenCalledOnce()
    expect(b.remove).toHaveBeenCalledOnce()
    expect(fake.state.gotten).toEqual([inQueue('ola-ola1-chg-1'), inQueue('ola-ola2-chg-1'), inQueue('ola-ola3-chg-1')])
  })

  it('no contracts means nothing to do', async () => {
    await cancelOLABreaches('c-one', 'chg-1', [])
    expect(fake.state.gotten).toEqual([])
  })
})

/**
 * Starting and stopping the worker.
 *
 * `closeScheduler` runs in the API's shutdown sequence, BEFORE the Neo4j
 * driver closes (D-24): a job still in flight that then cannot read the graph
 * fails, gets retried, and eventually gives up — an SLA breach nobody is told
 * about. Both functions are idempotent because the shutdown path can be
 * entered twice (a SIGTERM while a SIGINT is already draining).
 */
describe('initScheduler / closeScheduler', () => {
  it('registers one pool of SLA workers (one worker per tenant, added by the host), and starting again does not register a second', async () => {
    await closeScheduler()
    fake.state.pools = []
    initScheduler()
    initScheduler()
    expect(fake.state.pools).toHaveLength(1)
    expect(fake.state.pools[0]!.base).toBe('sla-jobs')
    expect(fake.state.pools[0]!.processor).toBe(processSLAJob)
    await closeScheduler()
  })

  it('closing drains the workers, and closing again is harmless', async () => {
    await closeScheduler()
    fake.state.pools = []
    initScheduler()
    const pool = fake.state.pools[0]!
    await closeScheduler()
    expect(pool.closed).toBe(1)
    await closeScheduler()
    expect(pool.closed).toBe(1)
  })

  it('closing without ever having started is not an error', async () => {
    await closeScheduler()
    await expect(closeScheduler()).resolves.toBeUndefined()
  })
})
