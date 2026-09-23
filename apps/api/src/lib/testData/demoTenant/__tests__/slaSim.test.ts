/**
 * THE SLA OF A SIMULATED TICKET, AS THE SLA ENGINE WOULD HAVE KEPT IT
 * (23 Sep 2026).
 *
 * The generator replays the SLA engine's events on a ticket's history at once
 * (packages/sla: selector.ts, status.ts). The tickets of tickets.test.ts walk
 * the factory workflows, where some of the engine's cases never happen; they
 * are pinned here on hand-made histories:
 *
 *  - the policy the selector would choose: every criterion it sets must
 *    match, more criteria win, and at the same number priority beats
 *    category beats team; a ticket with no policy has no SLA;
 *  - a business-hours policy whose calendar was not planned fails loud (the
 *    deadline would otherwise be computed on no calendar at all);
 *  - the pause (`pauseSLA` / `resumeSLA`): the clock the step's `sla_pause`
 *    names, both when it names none; resuming moves THAT deadline by the
 *    wall-clock time paused; a second waiting step keeps the first pause;
 *  - resolved straight from a waiting step, the open pause is written into
 *    the resolve deadline, as `markResolveMet` does — unless only the
 *    response clock was paused;
 *  - a ticket waiting now is paused, and a paused SLA is not breached.
 *
 * Deadlines are 24×7 here, so they read as plain arithmetic.
 */
import { describe, it, expect, vi } from 'vitest'
import { simulateSla, selectPolicy, plannedResolveDeadline, type SlaClock, type SlaTicket } from '../slaSim.js'
import type { PlannedSlaPolicy } from '../config.js'
import type { LiveStep } from '../workflowModel.js'
import { HOUR, MINUTE } from '../clock.js'

// @opengraphity/sla (the product's deadline arithmetic) also carries the SLA engine, which reaches Neo4j: no driver here.
vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), runQueryOne: vi.fn(), getSession: vi.fn(), writeSession: vi.fn() }))

const T0 = Date.parse('2026-09-01T08:00:00.000Z')
const CLOCK: SlaClock = { calendars: new Map(), tenantTimeZone: 'Europe/Rome' }
const iso = (ms: number) => new Date(ms).toISOString()

function policy(name: string, over: Partial<PlannedSlaPolicy> = {}): PlannedSlaPolicy {
  return {
    id: `p-${name}`, name, entityType: 'incident', priority: null, category: null, teamId: null, timezone: null,
    responseMinutes: 60, resolveMinutes: 24 * 60, warningMinutes: 60, calendarId: null, complianceTarget: 95, complianceWarning: 90,
    createdAtMs: T0 - 1000 * HOUR, ...over,
  }
}

function step(name: string, category: string, over: Partial<LiveStep> = {}): LiveStep {
  return { id: `s-${name}`, name, label: name, labels: null, category, type: 'standard', isInitial: false, isTerminal: false, isOpen: true, stepOrder: null, purpose: null, slaPause: null, ...over }
}
const ASSIGNED = step('assigned', 'active')
const IN_PROGRESS = step('in_progress', 'active')
/** The factory «pending»: `sla_pause: resolve`. */
const PENDING = step('pending', 'waiting', { slaPause: 'resolve' })
/** A tenant's own waiting step with no `sla_pause` action: both clocks stop. */
const WAITING_VENDOR = step('waiting_vendor', 'waiting')
const AWAITING_CONTACT = step('awaiting_contact', 'waiting', { slaPause: 'response' })
const RESOLVED = step('resolved', 'resolved', { isTerminal: true, isOpen: false })

const ticket = (moves: Array<[hours: number, step: LiveStep]>, over: Partial<SlaTicket> = {}): SlaTicket => ({
  entityType: 'incident', priority: 'high', category: 'network', teamId: 't-desk', createdAtMs: T0,
  moves: moves.map(([h, s]) => ({ atMs: T0 + h * HOUR, step: s })), ...over,
})
const run = (moves: Array<[number, LiveStep]>, nowHours = 1000) => simulateSla([policy('P2')], CLOCK, T0 + nowHours * HOUR, ticket(moves))!

describe('the policy the selector would choose', () => {
  const generic = policy('generic')
  const high = policy('high', { priority: 'high' })
  const highNetwork = policy('high-network', { priority: 'high', category: 'network' })
  const network = policy('network', { category: 'network' })
  const desk = policy('desk', { teamId: 't-desk' })
  const t = { entityType: 'incident' as const, priority: 'high', category: 'network', teamId: 't-desk' }

  it('every criterion a policy sets must match, and the one that sets more wins', () => {
    expect(selectPolicy([generic, high, desk, highNetwork, network], t)).toBe(highNetwork)
    expect(selectPolicy([generic, policy('critical', { priority: 'critical', category: 'network' })], t)).toBe(generic)
  })

  it('at the same number of criteria, priority beats category, and category beats team', () => {
    expect(selectPolicy([desk, network, high], t)).toBe(high)
    expect(selectPolicy([desk, network], t)).toBe(network)
    expect(selectPolicy([desk, generic], t)).toBe(desk)
  })

  it('a ticket no policy covers has no SLA, and no deadline to plan for', () => {
    const problem = { ...t, entityType: 'problem' as const }
    expect(selectPolicy([generic, high], problem)).toBeNull()
    expect(simulateSla([generic, high], CLOCK, T0 + HOUR, ticket([], { entityType: 'problem' }))).toBeNull()
    expect(plannedResolveDeadline([generic, high], CLOCK, { ...problem, createdAtMs: T0 })).toBeNull()
    expect(plannedResolveDeadline([generic], CLOCK, { ...t, createdAtMs: T0 })).toEqual({ responseMs: T0 + HOUR, resolveMs: T0 + 24 * HOUR })
  })
})

describe('a business-hours policy', () => {
  it('whose calendar was not planned fails loud instead of counting on no calendar', () => {
    const lost = policy('P3 office hours', { calendarId: 'cal-missing' })
    expect(() => simulateSla([lost], CLOCK, T0 + HOUR, ticket([]))).toThrow('SLA policy "P3 office hours": its calendar cal-missing is not planned')
    expect(() => plannedResolveDeadline([lost], CLOCK, { ...ticket([]) })).toThrow(/its calendar cal-missing is not planned/)
  })
})

describe('the pause, as pauseSLA and resumeSLA keep it', () => {
  it('a step that pauses the resolve clock: resuming moves only the resolve deadline, by the time paused', () => {
    const sla = run([[0.25, ASSIGNED], [1, PENDING], [3, IN_PROGRESS], [5, RESOLVED]])
    expect(sla.response_deadline).toBe(iso(T0 + HOUR))
    expect(sla.resolve_deadline).toBe(iso(T0 + 26 * HOUR))
    expect(sla.paused_total_ms).toBe(2 * HOUR)
    expect(sla).toMatchObject({ paused_at: null, paused_type: null, resolve_met: true, breached: false })
  })

  it('a waiting step that names no clock stops both', () => {
    const sla = run([[0.25, ASSIGNED], [1, WAITING_VENDOR], [4, IN_PROGRESS]])
    expect(sla.response_deadline).toBe(iso(T0 + 4 * HOUR))
    expect(sla.resolve_deadline).toBe(iso(T0 + 27 * HOUR))
    expect(sla.paused_total_ms).toBe(3 * HOUR)
  })

  it('a step that pauses the response clock moves only the response deadline', () => {
    const sla = run([[0.25, ASSIGNED], [0.5, AWAITING_CONTACT], [2.5, IN_PROGRESS]])
    expect(sla.response_deadline).toBe(iso(T0 + 3 * HOUR))
    expect(sla.resolve_deadline).toBe(iso(T0 + 24 * HOUR))
    expect(sla.paused_total_ms).toBe(2 * HOUR)
  })

  it('from one waiting step to another the SLA stays paused from the first, with the first one\'s clock', () => {
    const sla = run([[0.25, ASSIGNED], [1, PENDING], [2, WAITING_VENDOR], [5, IN_PROGRESS]])
    // Paused from 1h to 5h, the resolve clock only (the second step would have paused both).
    expect(sla.resolve_deadline).toBe(iso(T0 + 28 * HOUR))
    expect(sla.response_deadline).toBe(iso(T0 + HOUR))
    expect(sla.paused_total_ms).toBe(4 * HOUR)
  })

  it('resolved straight from a waiting step: the open pause is written into the resolve deadline, and it is met', () => {
    const sla = run([[0.25, ASSIGNED], [1, PENDING], [30, RESOLVED]])
    expect(sla.resolve_deadline).toBe(iso(T0 + 53 * HOUR))
    expect(sla).toMatchObject({ resolved_at: iso(T0 + 30 * HOUR), resolve_met: true, breached: false, breached_at: null, paused_at: null, paused_type: null })
    expect(sla.paused_total_ms).toBe(29 * HOUR)
  })

  it('resolved from a step that paused only the response: the resolve deadline does not move, and the late resolution is a breach', () => {
    const sla = run([[0.25, ASSIGNED], [1, AWAITING_CONTACT], [30, RESOLVED]])
    expect(sla.resolve_deadline).toBe(iso(T0 + 24 * HOUR))
    expect(sla).toMatchObject({ resolve_met: false, breached: true, breached_at: iso(T0 + 24 * HOUR), paused_total_ms: null })
  })

  it('a ticket waiting now is paused, says since when and on which clock, and is not breached while paused', () => {
    const sla = run([[0.25, ASSIGNED], [1, PENDING]], 100)
    expect(T0 + 100 * HOUR).toBeGreaterThan(Date.parse(sla.resolve_deadline))
    expect(sla).toMatchObject({ paused_at: iso(T0 + HOUR), paused_type: 'resolve', breached: false, breached_at: null, resolved_at: null, resolve_met: false })
    // Taken in 15 minutes: the response was met.
    expect(sla.response_met).toBe(true)
    expect(sla.response_breach_notified_at).toBeNull()
  })

  it('the same ticket, not waiting, is breached once its deadline has passed', () => {
    const sla = run([[0.25, ASSIGNED], [1, IN_PROGRESS]], 100)
    expect(sla).toMatchObject({ breached: true, breached_at: iso(T0 + 24 * HOUR), paused_at: null })
    expect(Date.parse(sla.response_deadline) - T0).toBe(60 * MINUTE)
  })
})
