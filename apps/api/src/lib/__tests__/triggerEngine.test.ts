/**
 * lib/triggerEngine.ts — AutoTrigger facade: loading, execution counters,
 * timer scheduling and cache invalidation.
 *
 * Why these behaviours matter:
 *  - triggers are loaded only for the caller's tenant/entity/event and only
 *    when enabled: a disabled trigger or another customer's trigger must never
 *    act on a ticket;
 *  - the execution counter is what the admin reads to know a trigger works;
 *  - on_timer triggers become delayed jobs with a deterministic job id (one
 *    job per trigger and entity, so a retried creation does not schedule the
 *    timer twice), and a scheduling failure must propagate (C-15);
 *  - `invalidateTriggerCache` must drop the cached triggers, otherwise a
 *    trigger the admin just disabled keeps firing for up to a minute.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = Record<string, unknown>
const h = vi.hoisted(() => ({
  rowsByTenant: new Map<string, Record<string, unknown>[]>(),
  queue: { add: vi.fn() },
}))

vi.mock('@opengraphity/neo4j', () => ({
  runQuery: vi.fn(async (_s: unknown, cypher: string, params: { tenantId: string }) =>
    (cypher.includes('RETURN t.id AS id') ? (h.rowsByTenant.get(params.tenantId) ?? []) : [])),
}))
vi.mock('../db.js', () => ({ withSession: vi.fn(async (fn: (s: unknown) => unknown) => fn({})) }))
vi.mock('../bullmq.js', () => ({ getTenantQueue: vi.fn(() => h.queue) }))
vi.mock('../actionExecutor.js', () => ({
  executeActions: vi.fn(async () => [{ action: 'set_field', success: true }]),
  parseActions: vi.fn(() => [{ type: 'set_field' }]),
}))
vi.mock('../audit.js', () => ({ audit: vi.fn() }))
vi.mock('../logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})

const { evaluateTriggers, scheduleTimerTriggers, invalidateTriggerCache } = await import('../triggerEngine.js')
const { runQuery } = await import('@opengraphity/neo4j')
const { getTenantQueue } = await import('../bullmq.js')

const trigger = (over: Row = {}): Row => ({
  id: 'tr-1', name: 'Escalate', entity_type: 'incident', event_type: 'on_create',
  conditions: JSON.stringify([{ field: 'severity', operator: 'equals', value: 'critical' }]),
  timer_delay_minutes: null, actions: '[{"type":"set_field"}]', ...over,
})
const loadCalls = () => vi.mocked(runQuery).mock.calls.filter((c) => (c[1] as string).includes('RETURN t.id AS id'))
const counterCalls = () => vi.mocked(runQuery).mock.calls.filter((c) => (c[1] as string).includes('execution_count'))

let seq = 0
/** A tenant id unique to the test: the trigger cache is module state keyed by tenant. */
const freshTenant = () => `tenant-${++seq}`

beforeEach(() => {
  vi.clearAllMocks()
  h.rowsByTenant.clear()
  h.queue.add.mockResolvedValue(undefined)
})

describe('evaluateTriggers', () => {
  it('loads only enabled triggers of the tenant, entity type and event type', async () => {
    const t = freshTenant()
    await evaluateTriggers(t, 'incident', 'on_create', { id: 'i1' }, 'u1')
    const [, cypher, params] = loadCalls()[0]!
    expect(cypher).toContain('tenant_id: $tenantId, entity_type: $entityType, event_type: $eventType, enabled: true')
    expect(params).toEqual({ tenantId: t, entityType: 'incident', eventType: 'on_create' })
  })

  it('no triggers → empty result, nothing evaluated', async () => {
    expect(await evaluateTriggers(freshTenant(), 'incident', 'on_create', { id: 'i1' }, 'u1')).toEqual([])
    expect(counterCalls()).toHaveLength(0)
  })

  it('a matching trigger fires, and its execution counter is bumped scoped to the tenant; a non-matching one does not', async () => {
    const t = freshTenant()
    h.rowsByTenant.set(t, [trigger(), trigger({ id: 'tr-2', name: 'Minor', conditions: JSON.stringify([{ field: 'severity', operator: 'equals', value: 'low' }]) })])

    const out = await evaluateTriggers(t, 'incident', 'on_create', { id: 'i1', severity: 'critical' }, 'u1')

    expect(out).toEqual([
      { triggerId: 'tr-1', triggerName: 'Escalate', fired: true, actionsRun: 1 },
      { triggerId: 'tr-2', triggerName: 'Minor', fired: false, actionsRun: 0 },
    ])
    expect(counterCalls()).toHaveLength(1)
    expect(counterCalls()[0]![2]).toMatchObject({ id: 'tr-1', tenantId: t })
  })

  it('a trigger with corrupt conditions reports the error instead of firing', async () => {
    const t = freshTenant()
    h.rowsByTenant.set(t, [trigger({ conditions: '{not json' })])
    const [r] = await evaluateTriggers(t, 'incident', 'on_create', { id: 'i1' }, 'u1')
    expect(r).toMatchObject({ triggerId: 'tr-1', fired: false })
    expect(r!.error).toMatch(/corrupt conditions/)
  })

  it('on_field_change: a trigger with corrupt conditions stays a candidate, so its corruption is reported', async () => {
    const t = freshTenant()
    h.rowsByTenant.set(t, [trigger({ event_type: 'on_field_change', conditions: '{broken' })])
    const out = await evaluateTriggers(t, 'incident', 'on_field_change', { id: 'i1' }, 'u1', { changedFields: ['status'] })
    expect(out).toHaveLength(1)
    expect(out[0]!.error).toMatch(/corrupt conditions/)
  })

  it('triggers are cached per tenant: a second evaluation does not reload them', async () => {
    const t = freshTenant()
    h.rowsByTenant.set(t, [trigger()])
    await evaluateTriggers(t, 'incident', 'on_create', { id: 'i1' }, 'u1')
    await evaluateTriggers(t, 'incident', 'on_create', { id: 'i2' }, 'u1')
    expect(loadCalls()).toHaveLength(1)
  })

  it('invalidateTriggerCache drops the cache: a trigger disabled by the admin stops firing immediately', async () => {
    const t = freshTenant()
    h.rowsByTenant.set(t, [trigger()])
    expect(await evaluateTriggers(t, 'incident', 'on_create', { id: 'i1', severity: 'critical' }, 'u1')).toHaveLength(1)

    h.rowsByTenant.set(t, []) // the admin disabled it
    invalidateTriggerCache(t)
    expect(await evaluateTriggers(t, 'incident', 'on_create', { id: 'i1', severity: 'critical' }, 'u1')).toEqual([])
  })
})

describe('scheduleTimerTriggers', () => {
  it('no on_timer triggers → no queue is even opened', async () => {
    await scheduleTimerTriggers(freshTenant(), 'incident', 'i1')
    expect(getTenantQueue).not.toHaveBeenCalled()
  })

  it('schedules a delayed job per trigger with a positive delay, with a deterministic job id; skips null/zero/negative delays', async () => {
    const t = freshTenant()
    h.rowsByTenant.set(t, [
      trigger({ id: 'tm-30', event_type: 'on_timer', timer_delay_minutes: 30 }),
      trigger({ id: 'tm-null', event_type: 'on_timer', timer_delay_minutes: null }),
      trigger({ id: 'tm-0', event_type: 'on_timer', timer_delay_minutes: 0 }),
      trigger({ id: 'tm-neg', event_type: 'on_timer', timer_delay_minutes: -5 }),
      // Neo4j Integers arrive as strings/objects: the loader normalises with Number().
      trigger({ id: 'tm-str', event_type: 'on_timer', timer_delay_minutes: '2' }),
    ])

    await scheduleTimerTriggers(t, 'incident', 'inc-7')

    expect(getTenantQueue).toHaveBeenCalledWith('workflow-jobs', t)
    expect(h.queue.add.mock.calls).toEqual([
      ['trigger_timer', { triggerId: 'tm-30', tenantId: t, entityType: 'incident', entityId: 'inc-7' },
        { delay: 30 * 60_000, jobId: 'trigger-tm-30-inc-7', removeOnComplete: true }],
      ['trigger_timer', { triggerId: 'tm-str', tenantId: t, entityType: 'incident', entityId: 'inc-7' },
        { delay: 2 * 60_000, jobId: 'trigger-tm-str-inc-7', removeOnComplete: true }],
    ])
  })

  it('a queue failure propagates to the caller (C-15): an entity must not look healthy with a dead timer', async () => {
    const t = freshTenant()
    h.rowsByTenant.set(t, [trigger({ event_type: 'on_timer', timer_delay_minutes: 5 })])
    h.queue.add.mockRejectedValue(new Error('redis down'))
    await expect(scheduleTimerTriggers(t, 'incident', 'i1')).rejects.toThrow('redis down')
  })
})
