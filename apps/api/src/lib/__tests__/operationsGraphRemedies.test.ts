/**
 * WHAT IS STUCK IN THE GRAPH, REPAIRED WITH A PERSON'S YES (26 Sep 2026).
 *
 * What a user loses if this regresses: alarms left with no incident while the
 * safety pass fails in silence; a service map behind the CMDB that nobody is
 * asked about — or one the admin FROZE synchronized behind their back; CIs
 * shown healthy while their alarms ring; tickets that could move by
 * themselves and sit there — or, worse, a remedy that cuts a wait short, moves
 * a ticket where the proposal says instead of where the customer's workflow
 * says, or reports «resolved» without looking.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fake = vi.hoisted(() => ({
  queries: [] as Array<{ q: string; params: Record<string, unknown> }>,
  answer: (_q: string, _p: Record<string, unknown>): unknown[] => [],
  unresolvedCauses: new Set<string>(),
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: async () => {} }),
  runQuery: async (_s: unknown, q: string, params: Record<string, unknown> = {}) => {
    fake.queries.push({ q, params })
    return fake.answer(q, params)
  },
  runQueryOne: async (_s: unknown, q: string, params: Record<string, unknown> = {}) => {
    fake.queries.push({ q, params })
    if (q.includes("verification: 'unresolved'")) return { n: fake.unresolvedCauses.has(String(params['cause'])) ? 1 : 0 }
    return fake.answer(q, params)[0] ?? null
  },
}))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../ciLifecycle.js', () => ({ resolveCILifecycleSemantics: async () => ({ maintenance: new Set(['in_maintenance']) }) }))
vi.mock('../domainMatrix.js', () => ({ loadDomainMatrix: async () => ({ entries: { critical: 'down', warning: 'degraded' } }) }))

const pipeline = vi.hoisted(() => ({ run: vi.fn(async (_i: { eventId: string }) => ({ outcome: 'correlated' })) }))
vi.mock('../../services/events/pipeline.js', () => ({ runEventPipeline: pipeline.run }))
const sync = vi.hoisted(() => ({ run: vi.fn(async () => ({ added: 1, removed: 2, moved: 0, skipped: null })) }))
vi.mock('../../services/serviceImpact/sync.js', () => ({ syncServiceMap: sync.run }))
const health = vi.hoisted(() => ({ recompute: vi.fn(async (_t: string, _id: string, _a: string) => 'down') }))
vi.mock('../../services/events/ciHealth.js', () => ({
  CI_HEALTH_SCALE: ['operational', 'degraded', 'down'],
  ciHealthCaseCypher: (s: string, f: string) => `CASE /* ${s} ${f} */ END`,
  recomputeCIHealth: health.recompute,
}))
const move = vi.hoisted(() => ({ transition: vi.fn(async (_s: unknown, _r: Record<string, unknown>) => ({ moved: true })) }))
vi.mock('../../services/ticketTransition.js', () => ({ transitionTicket: move.transition }))
const engine = vi.hoisted(() => ({ holds: new Map<string, boolean | 'unknown'>() }))
vi.mock('@opengraphity/workflow', () => ({
  WAIT_EXIT_TRIGGERS: ['automatic', 'timer'],
  workflowEngine: {
    evaluateCondition: async (_s: unknown, name: string) => {
      const v = engine.holds.get(name)
      if (v === 'unknown') throw new Error(`condition ${name} is not registered`)
      return v ?? false
    },
  },
}))
vi.mock('../../workflow/conditions.js', () => ({}))

const R = await import('../operationsGraphRemedies.js')
const { OPERATIONS_LIMITS: L, REMEDY_ACTOR } = await import('../operationsRemedyCommon.js')

const NOW = new Date('2026-09-26T08:00:00Z')
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()
const lastQuery = (part: string) => [...fake.queries].reverse().find((x) => x.q.includes(part))

beforeEach(() => {
  fake.queries = []
  fake.answer = () => []
  fake.unresolvedCauses = new Set()
  engine.holds = new Map()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('alarms the periodic pass left stuck', () => {
  it('none, no proposal', async () => {
    expect(await R.detectStuckAlarms('t-a', NOW)).toEqual([])
  })

  it('only those stuck well past the pass\'s own threshold: the pass is given its chance first', async () => {
    fake.answer = () => [{ n: 0, first: [] }]
    await R.detectStuckAlarms('t-a', NOW)
    const params = lastQuery("status: 'firing'")!.params
    // The pass calls «uncorrelated» 15 minutes; the proposal waits 45 more.
    expect(params['uncorrelatedCutoff']).toBe(minutesAgo(15 + L.alarmsBeyondPassMinutes))
    expect(params['tenantId']).toBe('t-a')
  })

  it('stuck alarms: one proposal for the tenant, the first twenty named, re-evaluating them', async () => {
    fake.answer = () => [{ n: 31, first: [{ id: 'e1', title: 'CPU' }, { id: 'e2', title: null }] }]
    const [p, ...rest] = await R.detectStuckAlarms('t-a', NOW)
    expect(rest).toEqual([])
    expect(p).toMatchObject({
      area: 'operations', kind: 'proposal.operationsStuckAlarms', params: { count: '31', cause: 'events:stuck' },
      scope: 'events:stuck:2026-09-26', evidence: { n: 31, refs: [{ entityType: 'event', id: 'e1', label: 'CPU' }, { entityType: 'event', id: 'e2', label: 'e2' }] },
      action: { type: 'events.reevaluate_stuck', params: { eventIds: ['e1', 'e2'] } },
    })
  })

  it('after a re-evaluation that did not hold this week: a proposal to read, no action', async () => {
    fake.answer = () => [{ n: 3, first: [{ id: 'e1', title: 'x' }] }]
    fake.unresolvedCauses.add('events:stuck')
    const [p] = await R.detectStuckAlarms('t-a', NOW)
    expect(p).toMatchObject({ kind: 'proposal.operationsStuckAlarmsNotHeld', action: null })
  })

  it('the remedy re-evaluates only those STILL stuck; one failing does not stop the others', async () => {
    fake.answer = (q) => q.includes('e.id IN $ids') ? [{ id: 'e1' }, { id: 'e3' }] : []
    pipeline.run.mockImplementation(async (i) => { if (i.eventId === 'e1') throw new Error('boom'); return { outcome: 'correlated' } })
    const out = await R.reevaluateStuckAlarms('t-a', { eventIds: ['e1', 'e2', 'e3'] })
    expect(pipeline.run.mock.calls.map((c) => c[0].eventId)).toEqual(['e1', 'e3'])
    expect(pipeline.run).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't-a', mode: 'reevaluate' }))
    expect(out).toEqual({ details: { eventIds: ['e1', 'e3'], reevaluated: 1, failed: 1 }, undoState: null })
  })

  it('none still stuck: refused, not a silent success; every one failing: an error, the proposal stays open', async () => {
    await expect(R.reevaluateStuckAlarms('t-a', { eventIds: ['e1'] })).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.proposal.nothingStuck' } } })
    fake.answer = (q) => q.includes('e.id IN $ids') ? [{ id: 'e1' }] : []
    pipeline.run.mockRejectedValue(new Error('neo4j down'))
    await expect(R.reevaluateStuckAlarms('t-a', { eventIds: ['e1'] })).rejects.toThrow(/every re-evaluation failed.*neo4j down/)
  })

  it('verified with the pass\'s own predicate, now', async () => {
    fake.answer = (q) => q.includes('e.id IN $ids') ? [{ id: 'e3' }] : []
    expect(await R.verifyAlarms('t-a', { eventIds: ['e1', 'e3'] })).toEqual({ verification: 'unresolved', detail: { alarms: 2, stillStuck: 1 } })
    fake.answer = () => []
    expect((await R.verifyAlarms('t-a', { eventIds: ['e1'] })).verification).toBe('resolved')
  })
})

describe('live service maps behind the CMDB', () => {
  it('one proposal per map, to synchronize it; frozen and over-limit maps are not in the question', async () => {
    fake.answer = () => [{ id: 'm1', name: 'Billing' }, { id: 'm2', name: null }]
    const out = await R.detectStaleServiceMaps('t-a', NOW)
    expect(out.map((p) => [p.kind, p.params['map'], p.scope, p.action])).toEqual([
      ['proposal.operationsStaleServiceMap', 'Billing', 'service_map:m1:2026-09-26', { type: 'service_map.sync', params: { mapId: 'm1' } }],
      ['proposal.operationsStaleServiceMap', 'm2', 'service_map:m2:2026-09-26', { type: 'service_map.sync', params: { mapId: 'm2' } }],
    ])
    const { q, params } = lastQuery('MATCH (m:ServiceMap')!
    expect(q).toMatch(/m\.auto_sync = true AND m\.status <> 'paused' AND coalesce\(m\.stale_reason, ''\) <> \$overLimit/)
    expect(params).toMatchObject({ overLimit: 'over_limit', missingCI: 'missing_ci', lateCutoff: minutesAgo(L.mapSyncLateMinutes) })
  })

  it('the remedy is the admin\'s «Sync now», by the remedy\'s actor', async () => {
    fake.answer = () => [{ autoSync: true, status: 'active' }]
    const out = await R.syncServiceMapRemedy('t-a', { mapId: 'm1' })
    expect(sync.run).toHaveBeenCalledWith('t-a', 'm1', 'manual', REMEDY_ACTOR)
    expect(out.details).toMatchObject({ mapId: 'm1', added: 1, removed: 2 })
  })

  it('a map frozen or paused since the proposal is refused — never synchronized behind the admin\'s back; a deleted one is said', async () => {
    fake.answer = () => [{ autoSync: false, status: 'active' }]
    await expect(R.syncServiceMapRemedy('t-a', { mapId: 'm1' })).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.proposal.mapNotLive' } } })
    fake.answer = () => [{ autoSync: true, status: 'paused' }]
    await expect(R.syncServiceMapRemedy('t-a', { mapId: 'm1' })).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.proposal.mapNotLive' } } })
    fake.answer = () => []
    await expect(R.syncServiceMapRemedy('t-a', { mapId: 'm1' })).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.proposal.mapGone' } } })
    expect(sync.run).not.toHaveBeenCalled()
  })

  it('verified on the map: still flagged is not resolved; deleted since, nothing left to fix', async () => {
    fake.answer = () => [{ stale: true, syncedAt: 'x', reason: 'missing_ci' }]
    expect((await R.verifyServiceMap('t-a', { mapId: 'm1' })).verification).toBe('unresolved')
    fake.answer = () => [{ stale: false, syncedAt: 'x', reason: null }]
    expect((await R.verifyServiceMap('t-a', { mapId: 'm1' })).verification).toBe('resolved')
    fake.answer = () => []
    expect(await R.verifyServiceMap('t-a', { mapId: 'm1' })).toEqual({ verification: 'resolved', detail: { gone: 'true' } })
  })
})

describe('CI health out of step with the alarms', () => {
  it('reads with the customer\'s matrix and lifecycle, leaving out CIs with alarm news in the last minutes', async () => {
    fake.answer = () => [{ id: 'c1', name: 'db-01' }]
    const [p] = await R.detectCIHealthOutOfStep('t-a', NOW)
    const { q, params } = lastQuery('RAISED_ON')!
    expect(params).toMatchObject({
      tenantId: 't-a', healthy: 'operational', maintenanceStatuses: ['in_maintenance'],
      healthBySeverity: { critical: 'down', warning: 'degraded' }, quietCutoff: minutesAgo(L.ciHealthQuietMinutes),
    })
    // A health set by hand and a severity the matrix does not know are not a recompute's business.
    expect(q).toContain("coalesce(ci.health_source, 'monitoring') = 'monitoring'")
    expect(q).toContain('all(s IN severities WHERE $healthBySeverity[s] IS NOT NULL)')
    expect(p).toMatchObject({ kind: 'proposal.operationsCIHealthOutOfStep', action: { type: 'ci.recompute_health', params: { ciIds: ['c1'] } } })
  })

  it('the remedy recomputes the named CIs still out of step, by the remedy\'s actor', async () => {
    fake.answer = (_q, p) => p['ids'] ? [{ id: 'c2', name: 'x' }] : []
    const out = await R.recomputeCIHealthRemedy('t-a', { ciIds: ['c1', 'c2'] })
    expect(health.recompute.mock.calls).toEqual([['t-a', 'c2', REMEDY_ACTOR]])
    expect(out.details).toEqual({ ciIds: ['c2'], recomputed: 1, failed: 0 })
  })

  it('none out of step any more: refused', async () => {
    await expect(R.recomputeCIHealthRemedy('t-a', { ciIds: ['c1'] })).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.proposal.nothingStuck' } } })
  })

  it('verified on the same predicate, on those CIs', async () => {
    fake.answer = (_q, p) => p['ids'] ? [{ id: 'c2', name: 'x' }] : []
    expect(await R.verifyCIHealth('t-a', { ciIds: ['c1', 'c2'] })).toEqual({ verification: 'unresolved', detail: { cis: 2, stillOutOfStep: 1 } })
  })
})

describe('tickets stuck in a wait whose timer was lost', () => {
  // A wait of an hour, entered two hours ago: its timer expired well past the grace.
  function arc(o: Partial<Record<string, unknown>>) {
    return {
      instanceId: 'wi1', entityType: 'incident', entityId: 'i1', label: 'INC001', props: {}, since: minutesAgo(120),
      fromStep: 'resolved', delay: 60, toStep: 'closed', condition: null, ...o,
    }
  }

  it('the change is not in the question: the resume pass already moves it every minute', async () => {
    fake.answer = () => []
    await R.detectStuckWorkflows('t-a', NOW)
    const types = lastQuery('HAS_WORKFLOW')!.params['types'] as string[]
    expect(types).toContain('incident')
    expect(types).not.toContain('change')
  })

  it('only a wait step\'s exit is read: an automatic arc elsewhere is fired by an event, not by time', async () => {
    // Found on the demo tenant (26 Sep 2026): fourteen problems waiting for their CHANGE on
    // `change_requested`, whose automatic arcs have no condition, were proposed as «stuck» —
    // accepting would have sent them all back to investigation.
    fake.answer = () => []
    await R.detectStuckWorkflows('t-a', NOW)
    const { q } = lastQuery('HAS_WORKFLOW')!
    expect(q).toContain("WHERE cur.type = 'timer_wait' AND tr.trigger IN $waitExit")
    expect(q).not.toMatch(/tr\.trigger = 'automatic'/)
  })

  it('a lost timer: proposed, the ticket named by its code', async () => {
    fake.answer = () => [arc({})]
    const [p] = await R.detectStuckWorkflows('t-a', NOW)
    expect(p).toMatchObject({
      kind: 'proposal.operationsStuckWorkflows', params: { count: '1' },
      evidence: { refs: [{ entityType: 'incident', id: 'i1', label: 'INC001' }] },
      action: { type: 'workflow.resume_automatic', params: { instanceIds: ['wi1'] } },
    })
  })

  it('a wait is never cut short: its exit opens only once the timer expired, plus the grace', async () => {
    fake.answer = () => [arc({ instanceId: 'running', since: minutesAgo(60 + L.timerGraceMinutes - 1) })]
    expect(await R.detectStuckWorkflows('t-a', NOW)).toEqual([])
    fake.answer = () => [arc({ instanceId: 'lost', since: minutesAgo(60 + L.timerGraceMinutes + 1) })]
    expect((await R.detectStuckWorkflows('t-a', NOW))[0]?.action?.params).toEqual({ instanceIds: ['lost'] })
    // A wait with no valid delay is the engine's error to tell, not a lost timer.
    fake.answer = () => [arc({ instanceId: 'broken', delay: 0, since: minutesAgo(999) })]
    expect(await R.detectStuckWorkflows('t-a', NOW)).toEqual([])
  })

  it('an exit whose condition does not hold, or that the engine does not know, is not followed', async () => {
    engine.holds.set('allTasksDone', false).set('mystery', 'unknown')
    fake.answer = () => [arc({ instanceId: 'closed-road', condition: 'allTasksDone' }), arc({ instanceId: 'unknown', condition: 'mystery' })]
    expect(await R.detectStuckWorkflows('t-a', NOW)).toEqual([])
  })

  it('one ticket, one exit: the first open one in the designer\'s order', async () => {
    engine.holds.set('ok', true)
    fake.answer = () => [arc({ toStep: 'closed', condition: 'nope' }), arc({ toStep: 'archived', condition: 'ok' }), arc({ toStep: 'other' })]
    const [p] = await R.detectStuckWorkflows('t-a', NOW)
    expect(p?.params['count']).toBe('1')
  })

  it('the remedy follows the arc read NOW from the customer\'s workflow — never a step from the parameters — through the pipeline, as the remedy', async () => {
    fake.answer = (q, p) => q.includes('wi.id IN $ids') && (p['ids'] as string[]).includes('wi1') ? [arc({})] : []
    const out = await R.resumeStuckWorkflows('t-a', { instanceIds: ['wi1'], toStep: 'deleted' })
    expect(move.transition).toHaveBeenCalledTimes(1)
    expect(move.transition.mock.calls[0]![1]).toEqual({
      tenantId: 't-a', instanceId: 'wi1', toStep: 'closed',
      actor: { kind: 'system', path: 'operations_remedy', userId: REMEDY_ACTOR }, triggerType: 'automatic',
    })
    expect(out.details).toEqual({ moves: [{ instanceId: 'wi1', from: 'resolved', to: 'closed', moved: true }], moved: 1, refused: 0, failed: 0 })
  })

  it('a ticket no longer stuck is left alone; none left is refused', async () => {
    await expect(R.resumeStuckWorkflows('t-a', { instanceIds: ['wi1'] })).rejects.toMatchObject({ extensions: { i18n: { key: 'errors.proposal.nothingStuck' } } })
    expect(move.transition).not.toHaveBeenCalled()
  })

  it('verified on where the tickets are now: still on the step they were stuck on is not resolved (a guard\'s refusal included)', async () => {
    fake.answer = () => [{ id: 'wi1', step: 'closed', status: 'active' }, { id: 'wi2', step: 'resolved', status: 'active' }]
    const details = { moves: [{ instanceId: 'wi1', from: 'resolved' }, { instanceId: 'wi2', from: 'resolved' }] }
    expect(await R.verifyWorkflows('t-a', details)).toEqual({ verification: 'unresolved', detail: { tickets: 2, stillStuck: 1 } })
    fake.answer = () => [{ id: 'wi1', step: 'closed', status: 'active' }, { id: 'wi2', step: 'resolved', status: 'completed' }]
    expect((await R.verifyWorkflows('t-a', details)).verification).toBe('resolved')
  })
})
