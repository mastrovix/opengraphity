/**
 * THE WAIT STEP (E-28), IN THE TENANT'S OWN QUEUE (23 Sep 2026).
 *
 * Entering a `timer_wait` step enqueues a job that, once due, moves the
 * workflow out of it. Three things went wrong in production and these tests
 * keep them closed:
 *
 *  1. the `Queue` was built on every transition and closed ONLY on the happy
 *     path: an `add` that threw (flaky Redis) leaked a Redis connection for
 *     good. The queue is now the tenant's producer singleton
 *     (`notification-jobs@<tenant>`), opened once per process;
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
const remove = vi.fn(async () => 1)
const queueAsked = vi.fn()

const redisBroken = vi.hoisted(() => ({ value: false }))

/**
 * `@opengraphity/events` is faked WHOLE rather than partially: importing it
 * for real opens a Redis connection, and a unit test must not need live
 * infrastructure. The other exports are here because `actions.ts` imports
 * them statically.
 */
vi.mock('@opengraphity/events', () => ({
  tenantQueue: (base: string, tenantId: string) => {
    queueAsked(base, tenantId)
    if (redisBroken.value) throw new Error('no Redis connection configured')
    return { add, remove }
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
    executeRead: vi.fn(async (work: (tx: { run: (q: string, p?: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
      work({ run: async (q: string, p?: Record<string, unknown>) => { exitQuery.params = p ?? null; exitQuery.cypher = q; return q.includes('AS toStep')
        ? { records: exit ? [mockRecord({ toStep: exit })] : [] }
        : { records: [state] } } })),
    executeWrite: vi.fn(async (work: (tx: { run: typeof txRun }) => Promise<unknown>) => work({ run: txRun })),
  }
}

const exitQuery: { cypher: string; params: Record<string, unknown> | null } = { cypher: '', params: null }
const manual = { instanceId: 'wi-1', toStepName: 'waiting_customer', triggeredBy: 'user-1', triggerType: 'manual' as const }
const actx = { userId: 'user-1', entityData: {} }

beforeEach(() => { add.mockClear(); remove.mockClear(); queueAsked.mockClear(); add.mockResolvedValue({ id: 'job-1' }) })

describe('timer_wait — the job that leaves the wait step', () => {
  it('enqueues the timer with the delay in milliseconds and a jobId per instance and per step', async () => {
    const s = waitSession({ minutes: 30 })
    const r = await new WorkflowEngine().transition(s as never, manual, actx)
    expect(r.success).toBe(true)
    expect(r.actionErrors).toBeUndefined()
    expect(add).toHaveBeenCalledWith('timer_wait',
      { instanceId: 'wi-1', toStep: 'closed', tenantId: 'c-one' },
      { delay: 30 * 60 * 1000, jobId: 'timer_wait:wi-1:step-wait', removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } })
    // The instance's tenant: its own queue, `notification-jobs@c-one`.
    expect(queueAsked).toHaveBeenCalledWith('notification-jobs', 'c-one')
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
    expect(r.actionErrors?.[0]).toContain('has no automatic or timer transition — the workflow will never leave this step')
    expect(add).not.toHaveBeenCalled()
  })

  it('if enqueuing fails, the error names the step left stuck', async () => {
    add.mockRejectedValueOnce(new Error('Redis unreachable'))
    const s = waitSession()
    const r = await new WorkflowEngine().transition(s as never, manual, actx)
    expect(r.actionErrors?.[0]).toContain('timer_wait scheduling failed: Redis unreachable')
    expect(r.actionErrors?.[0]).toContain('will never leave step "waiting_customer"')
  })

  it('a delay arriving as a Neo4j Integer is read as a number', async () => {
    const { int } = await import('neo4j-driver')
    await new WorkflowEngine().transition(waitSession({ minutes: int(15) }) as never, manual, actx)
    expect(add.mock.calls[0]![2]).toMatchObject({ delay: 15 * 60 * 1000 })
  })
})

describe('timer_wait — the fallbacks', () => {
  it('a queue that cannot even be opened is a scheduling error with its reason', async () => {
    redisBroken.value = true
    try {
      const r = await new WorkflowEngine().transition(waitSession() as never, manual, actx)
      expect(r.actionErrors?.[0]).toContain('timer_wait scheduling failed: no Redis connection configured')
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

// Review of 23 Sep 2026.
describe('timer_wait — the exit edge and a second visit', () => {
  it('the exit is an edge with trigger automatic OR timer (timer was documented and never scheduled)', async () => {
    await new WorkflowEngine().transition(waitSession() as never, manual, actx)
    expect(exitQuery.cypher).toContain('WHERE tr.trigger IN $exitTriggers')
    expect(exitQuery.params).toMatchObject({ exitTriggers: ['automatic', 'timer'] })
  })

  it('re-entering the step replaces the timer: the earlier visit\'s job is removed before the new one is added', async () => {
    await new WorkflowEngine().transition(waitSession() as never, manual, actx)
    expect(remove).toHaveBeenCalledWith('timer_wait:wi-1:step-wait')
    expect(remove.mock.invocationCallOrder[0]!).toBeLessThan(add.mock.invocationCallOrder[0]!)
  })
})
