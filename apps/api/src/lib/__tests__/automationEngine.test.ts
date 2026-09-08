/**
 * C-20b — pins the shared automation engine: AND/OR matching, stop_on_match,
 * failed action reported as `error`, corrupt config never executes, and the
 * two facades mapping to their public result shapes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../logger.js', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { ...l, child: () => l } }
})
vi.mock('../audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../actionExecutor.js', () => ({
  executeActions: vi.fn(),
  parseActions: (raw: string | null) => (raw ? JSON.parse(raw) : []),
}))
vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn() }))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation((fn: (s: unknown) => unknown) => fn({})),
}))
vi.mock('../bullmq.js', () => ({ getQueue: vi.fn() }))

const { evaluateRules, createAutomationCache } = await import('../automationEngine.js')
const { executeActions } = await import('../actionExecutor.js')
const { audit } = await import('../audit.js')
const { runQuery } = await import('@opengraphity/neo4j')
const { evaluateTriggers } = await import('../triggerEngine.js')
const { evaluateBusinessRules, invalidateRulesCache } = await import('../rulesEngine.js')

const ENTITY = { id: 'inc-1', severity: 'high', status: 'new', category: 'db' }
const ACTIONS = JSON.stringify([{ type: 'assign_team', params: { team_id: 't' } }, { type: 'create_comment', params: { text: 'x' } }])
const C_TRUE  = { field: 'severity', operator: 'equals', value: 'high' }
const C_FALSE = { field: 'status',   operator: 'equals', value: 'closed' }

function record(over: Partial<{ id: string; name: string; conditions: unknown[] | string | null; actions: string | null; conditionLogic: 'and' | 'or'; stopOnMatch: boolean }> = {}) {
  const conditions = over.conditions === undefined ? [C_TRUE] : over.conditions
  return {
    id: over.id ?? 'r1',
    name: over.name ?? 'rule one',
    conditions: typeof conditions === 'string' || conditions === null ? conditions : JSON.stringify(conditions),
    actions: over.actions === undefined ? ACTIONS : over.actions,
    conditionLogic: over.conditionLogic ?? 'and',
    stopOnMatch: over.stopOnMatch ?? false,
  }
}

const base = { kind: 'rule' as const, tenantId: 't1', entityType: 'incident', entity: ENTITY, userId: 'u1' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(executeActions).mockResolvedValue([{ action: 'assign_team', success: true }, { action: 'create_comment', success: true }])
})

describe('evaluateRules — condition logic', () => {
  it('AND: one false condition → not matched, no action executed', async () => {
    const out = await evaluateRules({ ...base, records: [record({ conditions: [C_TRUE, C_FALSE], conditionLogic: 'and' })] })
    expect(out).toEqual([{ id: 'r1', name: 'rule one', matched: false, actionsRun: 0, stopped: false }])
    expect(executeActions).not.toHaveBeenCalled()
  })

  it('OR: one true condition → matched, actions executed with the right context', async () => {
    const out = await evaluateRules({ ...base, records: [record({ conditions: [C_FALSE, C_TRUE], conditionLogic: 'or' })] })
    expect(out).toEqual([{ id: 'r1', name: 'rule one', matched: true, actionsRun: 2, stopped: false }])
    expect(executeActions).toHaveBeenCalledWith(JSON.parse(ACTIONS), expect.objectContaining({
      tenantId: 't1', userId: 'u1', entityId: 'inc-1', entityType: 'incident', source: 'business_rule', sourceName: 'rule one',
    }))
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'business_rule.executed', 'BusinessRule', 'r1',
      expect.objectContaining({ ruleName: 'rule one', entityId: 'inc-1', actionsRun: 2 }))
  })

  it('no conditions → always matches', async () => {
    const out = await evaluateRules({ ...base, records: [record({ conditions: null })] })
    expect(out[0]!.matched).toBe(true)
  })
})

describe('evaluateRules — stop_on_match and ordering', () => {
  it('stops after the first matching record with stopOnMatch; later records are not evaluated', async () => {
    const out = await evaluateRules({ ...base, records: [
      record({ id: 'a', conditions: [C_FALSE] }),
      record({ id: 'b', stopOnMatch: true }),
      record({ id: 'c' }),
    ] })
    expect(out.map(o => [o.id, o.matched, o.stopped])).toEqual([['a', false, false], ['b', true, true]])
    expect(executeActions).toHaveBeenCalledTimes(1)
  })

  it('without stopOnMatch every record runs in the given order', async () => {
    const out = await evaluateRules({ ...base, records: [record({ id: 'a' }), record({ id: 'b' })] })
    expect(out.map(o => o.id)).toEqual(['a', 'b'])
    expect(executeActions).toHaveBeenCalledTimes(2)
  })
})

describe('evaluateRules — failures are reported, never hidden', () => {
  it('a failed action → matched with error and partial actionsRun (both kinds)', async () => {
    vi.mocked(executeActions).mockResolvedValue([
      { action: 'assign_team', success: true },
      { action: 'create_comment', success: false, error: 'text is required' },
    ])
    for (const kind of ['rule', 'trigger'] as const) {
      const out = await evaluateRules({ ...base, kind, records: [record()] })
      expect(out[0]).toMatchObject({ matched: true, actionsRun: 1 })
      expect(out[0]!.error).toContain('action "create_comment" failed: text is required')
      expect(out[0]!.error).toContain('1/2 actions ran')
    }
  })

  it('a failed action still honours stopOnMatch (the record did match)', async () => {
    vi.mocked(executeActions).mockResolvedValue([{ action: 'assign_team', success: false, error: 'boom' }])
    const out = await evaluateRules({ ...base, records: [record({ id: 'a', stopOnMatch: true }), record({ id: 'b' })] })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'a', matched: true, stopped: true })
  })

  it('corrupt conditions → not matched, error reported, nothing executed', async () => {
    const out = await evaluateRules({ ...base, records: [record({ conditions: '{not json' })] })
    expect(out[0]).toMatchObject({ matched: false, actionsRun: 0, stopped: false })
    expect(out[0]!.error).toMatch(/corrupt conditions/)
    expect(executeActions).not.toHaveBeenCalled()
  })

  it('corrupt actions → matched with error, evaluation continues', async () => {
    const out = await evaluateRules({ ...base, records: [record({ id: 'a', actions: '[oops' }), record({ id: 'b' })] })
    expect(out[0]).toMatchObject({ id: 'a', matched: true, actionsRun: 0, stopped: false })
    expect(out[0]!.error).toBeTruthy()
    expect(out[1]).toMatchObject({ id: 'b', matched: true, actionsRun: 2 })
  })

  it('an afterExecute failure is reported on the record', async () => {
    const out = await evaluateRules({ ...base, records: [record()], afterExecute: async () => { throw new Error('counter failed') } })
    expect(out[0]).toMatchObject({ matched: true, actionsRun: 0, error: 'counter failed' })
  })
})

describe('createAutomationCache', () => {
  it('caches per tenant/entity/event and invalidates per tenant', async () => {
    const c = createAutomationCache<number>('x')
    const loader = vi.fn().mockResolvedValue([1])
    await c.get('t1', 'incident', 'on_create', loader)
    await c.get('t1', 'incident', 'on_create', loader)
    expect(loader).toHaveBeenCalledTimes(1)
    c.invalidate('t1')
    await c.get('t1', 'incident', 'on_create', loader)
    expect(loader).toHaveBeenCalledTimes(2)
  })
})

describe('facades', () => {
  it('evaluateTriggers maps to TriggerResult, bumps execution_count and audits as trigger', async () => {
    vi.mocked(runQuery).mockResolvedValueOnce([
      { id: 'tr1', name: 'auto assign', entity_type: 'incident', event_type: 'on_create', conditions: JSON.stringify([C_TRUE]), timer_delay_minutes: null, actions: ACTIONS },
    ] as never).mockResolvedValue([] as never)

    const out = await evaluateTriggers('t-trg', 'incident', 'on_create', ENTITY, 'u1')
    expect(out).toEqual([{ triggerId: 'tr1', triggerName: 'auto assign', fired: true, actionsRun: 2 }])
    expect(executeActions).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ source: 'trigger', sourceName: 'auto assign' }))
    const counterCall = vi.mocked(runQuery).mock.calls.find(([, cypher]) => String(cypher).includes('execution_count'))
    expect(counterCall?.[2]).toMatchObject({ id: 'tr1', tenantId: 't-trg' })
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'trigger.executed', 'AutoTrigger', 'tr1', expect.anything())
  })

  it('evaluateBusinessRules maps to RuleResult with stopped and error', async () => {
    invalidateRulesCache('t-rule')
    vi.mocked(runQuery).mockResolvedValueOnce([
      { id: 'b1', name: 'first', entity_type: 'incident', event_type: 'on_create', condition_logic: 'or', conditions: JSON.stringify([C_FALSE, C_TRUE]), actions: ACTIONS, priority: 1, stop_on_match: true },
      { id: 'b2', name: 'second', entity_type: 'incident', event_type: 'on_create', condition_logic: 'and', conditions: null, actions: ACTIONS, priority: 2, stop_on_match: false },
    ] as never)
    vi.mocked(executeActions).mockResolvedValue([{ action: 'assign_team', success: false, error: 'no team' }])

    const out = await evaluateBusinessRules('t-rule', 'incident', 'on_create', ENTITY, 'u1')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ ruleId: 'b1', ruleName: 'first', matched: true, actionsRun: 0, stopped: true })
    expect(out[0]!.error).toContain('no team')
  })
})
