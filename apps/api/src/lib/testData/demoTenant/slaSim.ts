/**
 * THE SLA OF A SIMULATED TICKET, AS THE SLA ENGINE WOULD HAVE KEPT IT (23 Sep 2026).
 *
 * In the app the SLA is kept by events: created when the ticket is created,
 * responded when it leaves its initial step, paused in a waiting step and
 * resumed after it, concluded when it enters a resolved or terminal step,
 * breached by a job at the deadline (packages/sla engine.ts, status.ts,
 * scheduler.ts). The generator writes three years of tickets at once, so it
 * replays those events on the ticket's history here and writes the final
 * state — the one the app would hold now:
 *
 *  - policy: the same choice as `selector.ts` (every set criterion must match;
 *    more criteria win; ties: priority, then category, then team), with the
 *    team the ticket ended with — a team change re-selects it (SL-10);
 *  - hours: the policy's calendar, in the policy's zone or the tenant's;
 *  - deadlines: `calculateDeadline` of `@opengraphity/sla`, the app's own
 *    function, from the ticket's creation;
 *  - pause: the type the step's `sla_pause` action asks for, otherwise both;
 *    resuming moves the deadlines by the wall-clock time paused, as
 *    `resumeSLA` does (not by business minutes);
 *  - reopening (SL-3): back to an open step from a concluded one, the
 *    deadline moves by the time spent concluded and the SLA runs again;
 *  - conclusion: `resolve_met = resolved_at <= deadline (+ open pause)`, and
 *    `breached_at = resolve_deadline` when breached — what the breach job
 *    writes, and what migration 20261002_1000 wrote for older rows;
 *  - an open ticket past its deadline and not paused is breached: the job
 *    has fired;
 *  - a response not given by its deadline was notified by the scheduler at
 *    that deadline (`response_breach_notified_at`).
 */
import { calculateDeadline, type ServiceCalendar } from '@opengraphity/sla'
import type { PlannedSlaPolicy } from './config.js'
import type { LiveStep } from './workflowModel.js'

/**
 * Where a policy's business hours come from: its calendar, read in its own
 * zone or the tenant's (D57: the regional service desks count on theirs).
 */
export interface SlaClock {
  calendars: ReadonlyMap<string, ServiceCalendar>
  tenantTimeZone: string
}

function deadlineOf(policy: PlannedSlaPolicy, clock: SlaClock, from: Date, minutes: number): number {
  const businessHours = policy.calendarId !== null
  const calendar = businessHours ? clock.calendars.get(policy.calendarId!) : undefined
  if (businessHours && !calendar) throw new Error(`SLA policy "${policy.name}": its calendar ${policy.calendarId!} is not planned`)
  return calculateDeadline(from, minutes, businessHours, policy.timezone ?? clock.tenantTimeZone, calendar ?? null).getTime()
}

export interface SlaTicket {
  entityType: 'incident' | 'problem' | 'service_request'
  priority: string
  category: string | null
  teamId: string | null
  createdAtMs: number
  /** The steps the ticket entered after its initial one, in order. */
  moves: Array<{ atMs: number; step: LiveStep }>
}

export interface SlaStatusRow {
  started_at: string
  response_deadline: string
  resolve_deadline: string
  response_met: boolean
  resolve_met: boolean
  breached: boolean
  breached_at: string | null
  resolved_at: string | null
  paused_at: string | null
  paused_type: string | null
  paused_total_ms: number | null
  response_breach_notified_at: string | null
  /** SL-3: when the ticket last left a concluded step for an open one. */
  reopened_at: string | null
  tier_severity: string
  tier_response_minutes: number
  tier_resolve_minutes: number
  tier_business_hours: boolean
  tier_warning_minutes: number
  policy_id: string
  policy_name: string
}

/** The policy `selector.ts` would choose, or null (then the ticket has no SLA). */
export function selectPolicy(policies: readonly PlannedSlaPolicy[], t: Pick<SlaTicket, 'entityType' | 'priority' | 'category' | 'teamId'>): PlannedSlaPolicy | null {
  const candidates = policies
    .filter((p) => p.entityType === t.entityType)
    .filter((p) => (p.priority === null || p.priority === t.priority) && (p.category === null || p.category === t.category)
      && (p.teamId === null || p.teamId === t.teamId))
    .map((p) => ({
      p,
      criteria: (p.priority === null ? 0 : 1) + (p.category === null ? 0 : 1) + (p.teamId === null ? 0 : 1),
      weight: (p.priority === null ? 0 : 4) + (p.category === null ? 0 : 2) + (p.teamId === null ? 0 : 1),
    }))
    .sort((a, b) => b.criteria - a.criteria || b.weight - a.weight)
  return candidates[0]?.p ?? null
}

const concludes = (s: LiveStep): boolean => s.category === 'resolved' || s.isTerminal

export function simulateSla(
  policies: readonly PlannedSlaPolicy[], clock: SlaClock, nowMs: number, t: SlaTicket,
): SlaStatusRow | null {
  const policy = selectPolicy(policies, t)
  if (!policy) return null
  const businessHours = policy.calendarId !== null
  const started = new Date(t.createdAtMs)
  let responseDeadline = deadlineOf(policy, clock, started, policy.responseMinutes)
  let resolveDeadline = deadlineOf(policy, clock, started, policy.resolveMinutes)

  let respondedAtMs: number | null = null
  let pausedAt: number | null = null
  let pausedType: 'resolve' | 'response' | 'both' | null = null
  let pausedTotal = 0
  let resolvedAt: number | null = null
  let met = false
  let breached = false

  let reopenedAt: number | null = null
  for (const move of t.moves) {
    if (resolvedAt !== null) {
      // A second conclusion (resolved → closed) changes nothing (engine.ts).
      if (concludes(move.step)) continue
      // SL-3: back to an open step — the SLA reopens, its deadline moved by
      // the time spent concluded (`reopenSLA`); a breach already recorded stays.
      resolveDeadline += Math.max(0, move.atMs - resolvedAt)
      reopenedAt = move.atMs
      resolvedAt = null
      met = false
    }
    if (respondedAtMs === null) respondedAtMs = move.atMs // leaving the initial step
    if (concludes(move.step)) {
      const pausedResolve = pausedAt !== null && (pausedType ?? 'both') !== 'response'
      const shift = pausedResolve ? Math.max(0, move.atMs - pausedAt!) : 0
      resolveDeadline += shift
      pausedTotal += shift
      pausedAt = null; pausedType = null
      resolvedAt = move.atMs
      met = move.atMs <= resolveDeadline
      // `markResolveMet`: met keeps an earlier breach, a miss records one.
      breached = breached || !met
      continue
    }
    if (move.step.category === 'waiting') {
      if (pausedAt === null) { pausedAt = move.atMs; pausedType = move.step.slaPause ?? 'both' }
      continue
    }
    if (pausedAt !== null) {
      const shift = Math.max(0, move.atMs - pausedAt)
      resolveDeadline += (pausedType === 'response' ? 0 : shift)
      if (pausedType === 'response' || pausedType === 'both') responseDeadline += shift
      pausedTotal += shift
      pausedAt = null; pausedType = null
    }
  }

  // Still open: the breach job has fired if the deadline passed while not paused.
  if (resolvedAt === null && pausedAt === null && resolveDeadline < nowMs) breached = true

  const responseLate = (respondedAtMs ?? nowMs) > responseDeadline && responseDeadline < nowMs
  return {
    started_at: started.toISOString(),
    response_deadline: new Date(responseDeadline).toISOString(),
    resolve_deadline: new Date(resolveDeadline).toISOString(),
    response_met: respondedAtMs !== null,
    resolve_met: resolvedAt !== null && met,
    breached,
    breached_at: breached ? new Date(resolveDeadline).toISOString() : null,
    resolved_at: resolvedAt === null ? null : new Date(resolvedAt).toISOString(),
    paused_at: pausedAt === null ? null : new Date(pausedAt).toISOString(),
    paused_type: pausedType,
    paused_total_ms: pausedTotal > 0 ? pausedTotal : null,
    response_breach_notified_at: responseLate ? new Date(responseDeadline).toISOString() : null,
    reopened_at: reopenedAt === null ? null : new Date(reopenedAt).toISOString(),
    tier_severity: t.priority,
    tier_response_minutes: policy.responseMinutes,
    tier_resolve_minutes: policy.resolveMinutes,
    tier_business_hours: businessHours,
    tier_warning_minutes: policy.warningMinutes,
    policy_id: policy.id,
    policy_name: policy.name,
  }
}

/** The deadline a ticket must meet (to plan how long its resolution takes). */
export function plannedResolveDeadline(
  policies: readonly PlannedSlaPolicy[], clock: SlaClock,
  t: Pick<SlaTicket, 'entityType' | 'priority' | 'category' | 'teamId' | 'createdAtMs'>,
): { responseMs: number; resolveMs: number } | null {
  const policy = selectPolicy(policies, t)
  if (!policy) return null
  const started = new Date(t.createdAtMs)
  return {
    responseMs: deadlineOf(policy, clock, started, policy.responseMinutes),
    resolveMs: deadlineOf(policy, clock, started, policy.resolveMinutes),
  }
}
