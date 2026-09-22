/**
 * THE WAIT STEP, AND THE QUEUE THAT ALWAYS CLOSES (E-28).
 *
 * Entering a `timer_wait` step enqueues a job that, once due, moves the
 * workflow out of it. Three things went wrong in production and these tests
 * keep them closed:
 *
 *  1. the `Queue` was built on every transition and closed ONLY on the happy
 *     path: an `add` that threw (flaky Redis) leaked a Redis connection for
 *     good, and a few dozen of those exhausted the pool;
 *  2. without a `jobId`, re-entering the same wait step enqueued a SECOND
 *     timer — and the workflow transitioned twice;
 *  3. a wait step with no automatic outgoing edge will never leave: that is
 *     an error the administrator must be told about, not a log line.
 *
 * This file is kept apart from `engine.test.ts` because `bullmq` and the
 * Redis of `@opengraphity/events` are faked only here: elsewhere the real
 * actions must be able to see the real modules.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WorkflowEngine } from '../engine.js'

const add   = vi.fn(async () => ({ id: 'job-1' }))
const close = vi.fn(async () => {})
const queueBuilt = vi.fn()

/**
 * `vi.hoisted` and not a plain const: `actions.ts` asks for the Redis
 * connection at module LOAD time, i.e. before this file's consts exist —
 * without hoisting the file would not load at all.
 */
const redisBroken = vi.hoisted(() => ({ value: false }))

vi.mock('bullmq', () => ({
  Queue: function Queue(this: unknown, name: string, opts: unknown) {
    queueBuilt(name, opts)
    return { add, close }
  },
}))
/**
 * `@opengraphity/events` is faked WHOLE rather than partially: importing it
 * for real opens a Neo4j and a Redis connection at module load, and a unit
 * test must not need live infrastructure. The other four exports are here
 * because `actions.ts` imports them statically.
 */
vi.mock('@opengraphity/events', () => ({
  getRedisConnection: () => {
    if (redisBroken.value) throw new Error('no Redis connection configured')
    return { host: 'fake' }
  },
  publish:               vi.fn(),
  assertSafeOutboundUrl: vi.fn(),
  loggableUrl:           (u: string) => u,
}))

function mockRecord(data: Record<string, unknown>) {
  return { get: (key: string) => data[key] }
}

/** State row of the wait step; `exit` is the step name of the automatic edge (null = no edge). */
function waitSession(opts: { minutes?: unknown; exit?: string | null } = {}) {
  const state = mockRecord({
    wi: { properties: { id: 'wi-1', tenant_id: 'c-one', entity_id: 'inc-1', entity_type: 'incident', definition_id: 'def-1' } },
    currentStepId: 'step-1', currentStepName: 'in_progress', exitActions: null,
    nextStepId: 'step-wait', nextStepName: 'waiting_customer', nextStepType: 'timer_wait',
    nextStepCategory: 'pending', nextStepTerminal: false, nextEnterActions: null,
    timerDelayMinutes: opts.minutes ?? 30, subWorkflowId: null,
    trigger: 'manual', condition: null, enteredAt: new Date().toISOString(),
  })
  const txRun = vi.fn().mockResolvedValue({ records: [mockRecord({ id: 'wi-1' })] })
  const exit = opts.exit === undefined ? 'closed' : opts.exit
  return {
    txRun,
    // There are TWO reads and they must be told apart by the query, not by
    // order: the transition state, and (only when entering a wait step) the
    // automatic outgoing edge.
    executeRead: vi.fn(async (work: (tx: { run: (q: string) => Promise<unknown> }) => Promise<unknown>) =>
      work({ run: async (q: string) => q.includes('AS toStep')
        ? { records: exit ? [mockRecord({ toStep: exit })] : [] }
        : { records: [state] } })),
    executeWrite: vi.fn(async (work: (tx: { run: typeof txRun }) => Promise<unknown>) => work({ run: txRun })),
  }
}

const manual = { instanceId: 'wi-1', toStepName: 'waiting_customer', triggeredBy: 'user-1', triggerType: 'manual' as const }
const actx = { userId: 'user-1', entityData: {} }

beforeEach(() => { add.mockClear(); close.mockClear(); queueBuilt.mockClear(); add.mockResolvedValue({ id: 'job-1' }) })

describe('timer_wait — the job that leaves the wait step', () => {
  it('enqueues the timer with the delay in milliseconds and a jobId per instance and per step', async () => {
    const s = waitSession({ minutes: 30 })
    const r = await new WorkflowEngine().transition(s as never, manual, actx)
    expect(r.success).toBe(true)
    expect(r.actionErrors).toBeUndefined()
    expect(add).toHaveBeenCalledWith('timer_wait',
      { instanceId: 'wi-1', toStep: 'closed', tenantId: 'c-one' },
      { delay: 30 * 60 * 1000, jobId: 'timer_wait:wi-1:step-wait' })
    expect(queueBuilt).toHaveBeenCalledWith('notification-jobs', { connection: { host: 'fake' } })
    expect(close).toHaveBeenCalledOnce()
  })

  it('the target step comes from the AUTOMATIC edge, not from a hand-written name', async () => {
    const s = waitSession({ exit: 'reopened' })
    await new WorkflowEngine().transition(s as never, manual, actx)
    expect(add.mock.calls[0]![1]).toMatchObject({ toStep: 'reopened' })
  })

  it('a wait step WITHOUT an automatic outgoing edge is an error: it would stay put forever', async () => {
    const s = waitSession({ exit: null })
    const r = await new WorkflowEngine().transition(s as never, manual, actx)
    expect(r.success).toBe(true)
    expect(r.actionErrors?.[0]).toContain('has no automatic transition — the workflow will never leave this step')
    expect(add).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()   // the queue closes here too
  })

  it('if enqueuing fails the queue still closes, and the error names the step left stuck', async () => {
    add.mockRejectedValueOnce(new Error('Redis unreachable'))
    const s = waitSession()
    const r = await new WorkflowEngine().transition(s as never, manual, actx)
    expect(r.actionErrors?.[0]).toContain('timer_wait scheduling failed: Redis unreachable')
    expect(r.actionErrors?.[0]).toContain('will never leave step "waiting_customer"')
    expect(close).toHaveBeenCalledOnce()
  })

  it('a failing queue close does not fail the transition', async () => {
    // Closing is cleanup: if it fails we log it and move on — undoing an
    // already-written transition over this would be worse than the problem.
    close.mockRejectedValueOnce(new Error('connection already dropped'))
    const r = await new WorkflowEngine().transition(waitSession() as never, manual, actx)
    expect(r.success).toBe(true)
    expect(r.actionErrors).toBeUndefined()
  })

  it('a delay arriving as a Neo4j Integer is read as a number', async () => {
    const { int } = await import('neo4j-driver')
    await new WorkflowEngine().transition(waitSession({ minutes: int(15) }) as never, manual, actx)
    expect(add.mock.calls[0]![2]).toMatchObject({ delay: 15 * 60 * 1000 })
  })
})

describe('timer_wait — the fallbacks', () => {
  it('a queue that cannot even be BUILT is not closed', async () => {
    // `queue` stays null: a `queue.close()` here would raise a TypeError that
    // would bury the real reason (Redis not configured) inside the `finally`.
    redisBroken.value = true
    try {
      const r = await new WorkflowEngine().transition(waitSession() as never, manual, actx)
      expect(r.actionErrors?.[0]).toContain('timer_wait scheduling failed: no Redis connection configured')
      expect(close).not.toHaveBeenCalled()
    } finally {
      redisBroken.value = false
    }
  })

  it('a rejection that is not an Error is still readable in the scheduling error', async () => {
    add.mockRejectedValueOnce('Redis said no')
    const r = await new WorkflowEngine().transition(waitSession() as never, manual, actx)
    expect(r.actionErrors?.[0]).toContain('timer_wait scheduling failed: Redis said no')
  })
})
