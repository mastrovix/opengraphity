/**
 * THE REST OF THE SLA CLOCK: starting it, stopping it, restarting it.
 *
 * `status.test.ts` covers the outcome (met / breached) and re-policying.
 * This file covers what comes before and after: reading the scope and the
 * priority the policy is chosen by, creating the status, pausing, reopening,
 * and the small marks that keep a customer from being told twice about the
 * same thing.
 *
 * The recurring theme is that none of these functions may act on a clock
 * that is already stopped. Pausing a resolved SLA, reopening one that was
 * never resolved, or restarting one that was never paused would each move a
 * deadline nobody expected to move — and a deadline is what a customer is
 * owed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SLAPolicy } from '../policy.js'

interface Call { cypher: string; params: Record<string, unknown> }
const state = vi.hoisted(() => ({
  writes: [] as Call[],
  reads: [] as Call[],
  /** What `getSLAStatus` (and the projections) come back with. */
  current: null as Record<string, unknown> | null,
  /** What a plain read query answers, when the test needs something else. */
  readRow: undefined as Record<string, unknown> | null | undefined,
  /** Makes the write come back empty: the node vanished between read and write. */
  writeVanishes: false,
  closed: 0,
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({ close: async () => { state.closed += 1 } }),
  runQuery: async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    state.writes.push({ cypher, params })
    // Only a MERGE…RETURN gives rows back; the plain SETs return nothing.
    return cypher.includes('MERGE ') && state.current ? [state.current] : []
  },
  runQueryOne: async (_s: unknown, cypher: string, params: Record<string, unknown>) => {
    const isWrite = cypher.includes('SET ') || cypher.includes('MERGE ')
    ;(isWrite ? state.writes : state.reads).push({ cypher, params })
    if (isWrite && state.writeVanishes) return null
    if (state.readRow !== undefined && !isWrite) return state.readRow
    return state.current
  },
}))

const {
  getEntityScope, getEntityPriority, createSLAStatus, ticketReference,
  markResponseBreachNotified, markResponseMet, markBreached, pauseSLA, resumeSLA, reopenSLA,
} = await import('../status.js')

const status = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'sla-1', tenant_id: 'c-one', entity_id: 'inc-1', entity_type: 'incident',
  policy_id: 'pol-1', started_at: '2026-05-01T09:00:00.000Z',
  response_deadline: '2026-05-01T10:00:00.000Z',
  resolve_deadline:  '2026-05-01T17:00:00.000Z',
  response_met: false, resolve_met: false, breached: false,
  paused_at: null, paused_type: null, resolved_at: null,
  tier_severity: 'high', tier_response_minutes: 60, tier_resolve_minutes: 480, tier_business_hours: false,
  ...over,
})

const POLICY: SLAPolicy = {
  id: 'pol-1', tenant_id: 'c-one', name: 'Standard', entity_type: 'incident',
  timezone: 'Europe/Rome', calendar: null,
  tiers: [{ severity: 'high', response_minutes: 60, resolve_minutes: 480, business_hours: false }],
} as unknown as SLAPolicy

const lastWrite = () => state.writes[state.writes.length - 1]!

beforeEach(() => {
  state.writes = []; state.reads = []
  state.current = null; state.readRow = undefined
  state.writeVanishes = false; state.closed = 0
})

describe('getEntityScope — what a policy can be scoped to', () => {
  it('returns the category and the assigned team of the ticket', async () => {
    state.readRow = { category: 'network', teamId: 'team-1' }
    expect(await getEntityScope('c-one', 'inc-1')).toEqual({ category: 'network', teamId: 'team-1' })
    expect(state.reads[0]!.cypher).toContain('OPTIONAL MATCH (e)-[:ASSIGNED_TO_TEAM]->(t:Team)')
    expect(state.reads[0]!.params).toEqual({ tenantId: 'c-one', entityId: 'inc-1' })
  })

  it('an empty string is not a category: a policy asking for one must not match a ticket with none', async () => {
    // `''` is what an unset property looks like after an import; treating it
    // as a value would apply the "network incidents" policy to everything.
    state.readRow = { category: '', teamId: '' }
    expect(await getEntityScope('c-one', 'inc-1')).toEqual({ category: null, teamId: null })
    state.readRow = { category: null, teamId: undefined }
    expect(await getEntityScope('c-one', 'inc-1')).toEqual({ category: null, teamId: null })
  })

  it('a ticket that does not exist is an error naming it, and the session still closes', async () => {
    state.readRow = null
    await expect(getEntityScope('c-one', 'inc-ghost')).rejects.toThrow('[sla:status] Entity inc-ghost not found for tenant c-one')
    expect(state.closed).toBe(1)
  })
})

describe('getEntityPriority — where each entity type keeps its priority', () => {
  it.each([
    ['incident',        'Incident',       'severity'],
    ['problem',         'Problem',        'priority'],
    ['service_request', 'ServiceRequest', 'priority'],
  ])('%s reads %s.%s', async (entityType, label, prop) => {
    // An incident keeps it in `severity`; reading `priority` there would
    // return undefined and pick the wrong tier for every incident.
    state.readRow = { priority: 'high' }
    expect(await getEntityPriority('c-one', entityType as 'incident', 'e-1')).toBe('high')
    expect(state.reads[0]!.cypher).toContain(`MATCH (e:${label} {id: $entityId, tenant_id: $tenantId}) RETURN e.${prop} AS priority`)
  })

  it('a ticket that does not exist is an error naming type and id', async () => {
    state.readRow = null
    await expect(getEntityPriority('c-one', 'problem', 'prb-9')).rejects.toThrow('[sla:status] problem prb-9 not found for tenant c-one')
  })
})

describe('createSLAStatus', () => {
  it('computes both deadlines from the tier and MERGEs, so a redelivery creates no second status', async () => {
    // `entity.created` is at-least-once: a CREATE here would give one ticket
    // two SLAs, two sets of timers and two breach notifications.
    state.current = status()
    await createSLAStatus({
      tenantId: 'c-one', entityId: 'inc-1', entityType: 'incident', severity: 'high',
      policy: POLICY, startedAt: new Date('2026-05-01T09:00:00.000Z'),
    })
    const w = lastWrite()
    expect(w.cypher).toContain('MERGE (e)-[:HAS_SLA]->(s:SLAStatus')
    expect(w.params['responseDeadline']).toBe('2026-05-01T10:00:00.000Z')
    expect(w.params['resolveDeadline']).toBe('2026-05-01T17:00:00.000Z')
  })

  it('a severity with no tier in the policy is an error naming both', async () => {
    // Silently picking the first tier would give a critical incident the
    // deadline of a low one.
    await expect(createSLAStatus({
      tenantId: 'c-one', entityId: 'inc-1', entityType: 'incident', severity: 'cosmic', policy: POLICY,
    })).rejects.toThrow('[sla:status] No tier found for severity "cosmic" in policy "pol-1"')
  })

  it('without an explicit start the clock starts now', async () => {
    state.current = status()
    const before = Date.now()
    await createSLAStatus({ tenantId: 'c-one', entityId: 'inc-1', entityType: 'incident', severity: 'high', policy: POLICY })
    const started = new Date(lastWrite().params['responseDeadline'] as string).getTime() - 60 * 60 * 1000
    expect(started).toBeGreaterThanOrEqual(before - 1000)
  })
})

describe('ticketReference — how the ticket appears in an SLA notification', () => {
  it('reads number, title and the ticket\'s REAL severity and status', async () => {
    // The Slack/Teams breach card used to print "Severity: HIGH · Status:
    // open" hardcoded, for every ticket — a critical one in escalation
    // included (E-8).
    state.readRow = { number: 'INC00000042', title: 'DB down', severity: 'critical', status: 'escalated' }
    expect(await ticketReference('c-one', 'inc-1')).toEqual({
      number: 'INC00000042', title: 'DB down', severity: 'critical', status: 'escalated',
    })
    expect(state.reads[0]!.cypher).toContain('coalesce(e.number, e.code) AS number')
    expect(state.reads[0]!.cypher).toContain('coalesce(e.severity, e.priority) AS severity')
  })

  it('severity and status are optional: a ticket without a priority stays possible', async () => {
    state.readRow = { number: 'INC1', title: 'x', severity: null, status: null }
    expect(await ticketReference('c-one', 'inc-1')).toMatchObject({ severity: null, status: null })
  })

  it('a ticket that does not exist is null, not an error: there is simply nothing to name', async () => {
    state.readRow = null
    expect(await ticketReference('c-one', 'inc-ghost')).toBeNull()
  })

  it('a ticket with no number or no title IS an error: the notification would not say which ticket', async () => {
    for (const row of [{ number: null, title: 'x' }, { number: 'INC1', title: null }]) {
      state.readRow = row
      await expect(ticketReference('c-one', 'inc-1')).rejects.toThrow(/has no number or title/)
    }
  })
})

describe('the marks that keep a customer from being told twice', () => {
  it('markResponseBreachNotified keeps the FIRST instant: resuming a pause sends no second alert', async () => {
    await markResponseBreachNotified('c-one', 'inc-1', '2026-05-01T10:05:00.000Z')
    expect(lastWrite().cypher).toContain('SET s.response_breach_notified_at = coalesce(s.response_breach_notified_at, $at)')
    expect(lastWrite().params).toEqual({ tenantId: 'c-one', entityId: 'inc-1', at: '2026-05-01T10:05:00.000Z' })
  })

  it('markBreached records WHEN, once: a breach happened one time only', async () => {
    // Without `breached_at` the digest's "SLA breached" panel counted SLAs
    // STARTED in the last 24 hours that happen to be breached — wrong in
    // both directions (C-8).
    await markBreached('c-one', 'inc-1', '2026-05-01T17:00:01.000Z')
    expect(lastWrite().cypher).toContain('SET s.breached = true, s.breached_at = coalesce(s.breached_at, $at)')
  })

  it('both default to now when the caller does not say', async () => {
    const before = Date.now()
    await markResponseBreachNotified('c-one', 'inc-1')
    await markBreached('c-one', 'inc-1')
    for (const w of state.writes) {
      expect(new Date(w.params['at'] as string).getTime()).toBeGreaterThanOrEqual(before - 1000)
    }
  })

  it('markResponseMet sets the flag on this tenant\'s status only', async () => {
    await markResponseMet('c-one', 'inc-1')
    expect(lastWrite().cypher).toContain('SET s.response_met = true')
    expect(lastWrite().cypher).toContain('{id: $entityId, tenant_id: $tenantId}')
  })
})

describe('pauseSLA — stopping a clock that is running', () => {
  it('records when it stopped and which clock stopped', async () => {
    state.current = status()
    const out = await pauseSLA('c-one', 'inc-1', 'resolve', new Date('2026-05-01T11:00:00.000Z'))
    expect(out).toMatchObject({ paused_at: '2026-05-01T11:00:00.000Z', paused_type: 'resolve' })
    expect(lastWrite().cypher).toContain('SET s.paused_at = $now, s.paused_type = $slaType')
  })

  it('pauses at the instant of the EVENT, not of the consumer that processed it', async () => {
    // A queue running late would otherwise extend the pause — and therefore
    // the deadline — by however late it was (SL-8).
    state.current = status()
    await pauseSLA('c-one', 'inc-1', 'both', new Date('2026-05-01T11:00:00.000Z'))
    expect(lastWrite().params['now']).toBe('2026-05-01T11:00:00.000Z')
  })

  it.each([
    ['already paused',   { paused_at: '2026-05-01T11:00:00.000Z' }],
    ['already met',      { resolve_met: true }],
    ['already resolved', { resolved_at: '2026-05-01T12:00:00.000Z' }],
  ])('a clock %s is not paused again and nothing is written', async (_what, over) => {
    state.current = status(over)
    expect(await pauseSLA('c-one', 'inc-1')).toBeNull()
    expect(state.writes).toHaveLength(0)
  })

  it('a ticket with no SLA at all is null', async () => {
    state.current = null
    expect(await pauseSLA('c-one', 'inc-1')).toBeNull()
  })
})

describe('resumeSLA — which deadline moves depends on what was paused', () => {
  const paused = (type: string | null) => status({ paused_at: '2026-05-01T10:00:00.000Z', paused_type: type })
  const resumeAt = new Date('2026-05-01T11:00:00.000Z')   // one hour of pause

  it('paused_type "response" shifts only the response deadline', async () => {
    state.current = paused('response')
    await resumeSLA('c-one', 'inc-1', resumeAt)
    expect(lastWrite().params['newResponse']).toBe('2026-05-01T11:00:00.000Z')
    expect(lastWrite().params['newResolve']).toBe('2026-05-01T17:00:00.000Z')
  })

  it('paused_type "resolve" shifts only the resolve deadline', async () => {
    state.current = paused('resolve')
    await resumeSLA('c-one', 'inc-1', resumeAt)
    expect(lastWrite().params['newResponse']).toBe('2026-05-01T10:00:00.000Z')
    expect(lastWrite().params['newResolve']).toBe('2026-05-01T18:00:00.000Z')
  })

  it('a pause with no recorded type shifts both: "both" is the old default', async () => {
    state.current = paused(null)
    await resumeSLA('c-one', 'inc-1', resumeAt)
    expect(lastWrite().params['newResponse']).toBe('2026-05-01T11:00:00.000Z')
    expect(lastWrite().params['newResolve']).toBe('2026-05-01T18:00:00.000Z')
  })

  it('a paused_at in the future never SHORTENS a deadline', async () => {
    // A corrupt or clock-skewed instant would otherwise pull the deadline
    // backwards and breach the SLA retroactively.
    state.current = paused('both')
    await resumeSLA('c-one', 'inc-1', new Date('2026-05-01T09:00:00.000Z'))
    expect(lastWrite().params['newResolve']).toBe('2026-05-01T17:00:00.000Z')
  })

  it('an SLA that was not paused is null, and nothing is written', async () => {
    state.current = status()
    expect(await resumeSLA('c-one', 'inc-1', resumeAt)).toBeNull()
    expect(state.writes).toHaveLength(0)
  })
})

describe('reopenSLA — a reopened ticket gets its clock back (SL-3)', () => {
  it('the time spent resolved does not count: the resolve deadline moves forward by it', async () => {
    // Before this, a transition from resolved back to an open step left the
    // ticket in progress with no deadline at all.
    state.current = status({ resolved_at: '2026-05-01T12:00:00.000Z', resolve_met: true })
    await reopenSLA('c-one', 'inc-1', new Date('2026-05-01T14:00:00.000Z'))
    const w = lastWrite()
    expect(w.params['newResolve']).toBe('2026-05-01T19:00:00.000Z')   // 17:00 + 2h
    expect(w.params['reopenedAt']).toBe('2026-05-01T14:00:00.000Z')
    expect(w.cypher).toContain('s.resolved_at      = null')
    expect(w.cypher).toContain('s.resolve_met      = false')
  })

  it('a breach is NOT cleared by reopening: it stays in the compliance history', async () => {
    state.current = status({ resolved_at: '2026-05-01T12:00:00.000Z', breached: true })
    await reopenSLA('c-one', 'inc-1', new Date('2026-05-01T14:00:00.000Z'))
    // `s.breached` appears in the RETURN projection; what matters is that it
    // is not in the SET clause.
    const setClause = lastWrite().cypher.split('RETURN')[0]!
    expect(setClause).not.toContain('s.breached')
  })

  it('a reopen instant BEFORE the resolution never shortens the deadline', async () => {
    state.current = status({ resolved_at: '2026-05-01T12:00:00.000Z' })
    await reopenSLA('c-one', 'inc-1', new Date('2026-05-01T11:00:00.000Z'))
    expect(lastWrite().params['newResolve']).toBe('2026-05-01T17:00:00.000Z')
  })

  it('an SLA that was never resolved has nothing to reopen', async () => {
    state.current = status()
    expect(await reopenSLA('c-one', 'inc-1', new Date())).toBeNull()
    expect(state.writes).toHaveLength(0)
  })

  it('a corrupt resolved_at is an error naming the status, not a NaN deadline', async () => {
    // `new Date("ieri")` is Invalid Date: without this the shift becomes NaN
    // and the deadline written to the graph is unreadable.
    for (const bad of ['ieri', 42]) {
      state.current = status({ resolved_at: bad })
      await expect(reopenSLA('c-one', 'inc-1', new Date())).rejects.toThrow(/resolved_at of SLAStatus sla-1/)
    }
  })

  it('the status vanishing mid-update is an error, not a silent null', async () => {
    // The read answered, the write did not: somebody deleted the ticket in
    // between. A silent null here would leave the caller rescheduling timers
    // against a deadline that no longer exists.
    state.current = status({ resolved_at: '2026-05-01T12:00:00.000Z' })
    state.writeVanishes = true
    await expect(reopenSLA('c-one', 'inc-1', new Date('2026-05-01T14:00:00.000Z')))
      .rejects.toThrow('[sla:status] reopenSLA(inc-1): SLAStatus vanished during update')
  })
})
