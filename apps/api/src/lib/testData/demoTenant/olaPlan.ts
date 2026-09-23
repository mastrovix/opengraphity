/**
 * THE OLA AND UC CONTRACTS, WHERE THE TEAMS REALLY WORK (tour of 23 Sep 2026, D64).
 *
 * The contracts were drawn at random before any ticket existed: a team
 * picked for «service requests» that never received one («No data»), and
 * targets of four to eight hours against teams that hold an incident for two
 * business days — 37% of the evaluations met. An administrator agrees a
 * contract with a team that does that work, on a target the team can keep
 * most of the time. So the contracts are chosen AFTER the three years are
 * simulated:
 *  - for each kind of ticket, the teams that concluded the most of them;
 *  - the target is the first step of a ladder of round targets that the
 *    team met on at least 88% of its tickets, measured with the product's own
 *    function (`olaTeamMeasure`: the team's time on the ticket, on the
 *    contract's calendar, from when the contract exists) — so the OLA pages
 *    show 88-97% met, the band the owner asked for (85-95%, some months
 *    above and below).
 *
 * Every region's teams can have one. A contract counts on its team's
 * calendar, in the zone that calendar is read in: the tenant's for the
 * regions in the same zone (and the global teams, on the headquarters'
 * calendar), its own for the others — Europe/London, America/New_York,
 * Asia/Singapore (`OLAContract.timezone`, tour of 23 Sep 2026). Until the
 * contracts had a zone, only the teams in the tenant's zone could have one.
 */
import { parseServiceCalendar, type ServiceCalendar } from '@opengraphity/sla'
import { olaTeamMeasure, type OLATicketFacts } from '../../olaAttainment.js'
import type { Rng } from './random.js'
import { DAY } from './clock.js'
import type { ConfigPlan, PlannedCalendar, PlannedOla } from './config.js'
import type { PeoplePlan, PlannedTeam } from './people.js'
import type { TicketTrail } from './trail.js'

type OlaEntity = 'incident' | 'problem' | 'service_request'

/** What the OLA engine reads of a concluded ticket: when, and which team held it when. */
interface TicketFacts extends OLATicketFacts { entityType: OlaEntity }

/** Round targets an administrator writes, in minutes. */
const TARGET_LADDER = [30, 60, 120, 240, 480, 720, 960, 1440, 1920, 2400, 3600, 4800, 7200, 9600, 14400, 19200]
const MIN_ATTAINMENT = 0.88
/** Below this many concluded tickets a team's attainment is noise, not a measure. */
const MIN_TICKETS = 25

/** The concluded tickets of each team, collected while the tickets are simulated. */
export class OlaFacts {
  private readonly byTeam = new Map<string, TicketFacts[]>()

  add(entityType: OlaEntity, trail: TicketTrail): void {
    const concluded = entityType === 'service_request' ? trail.completedAtMs : trail.resolvedAtMs
    if (concluded === null || !trail.segments.length) return
    const facts: TicketFacts = {
      entityType,
      createdAt: new Date(trail.createdAtMs).toISOString(),
      concludedAt: new Date(concluded).toISOString(),
      currentTeamId: trail.teamId,
      segments: trail.segments.map((s) => ({ teamId: s.team_id, startedAt: s.started_at, endedAt: s.ended_at ?? null, inferred: false })),
    }
    for (const teamId of new Set(trail.segments.map((s) => s.team_id))) {
      const list = this.byTeam.get(teamId)
      if (list) list.push(facts)
      else this.byTeam.set(teamId, [facts])
    }
  }

  of(teamId: string, entityType: OlaEntity): TicketFacts[] {
    return (this.byTeam.get(teamId) ?? []).filter((f) => f.entityType === entityType)
  }
}

interface Choice { team: PlannedTeam; entityType: OlaEntity; type: 'ola' | 'uc' }

function entityLabel(e: OlaEntity): string {
  return { incident: 'Incidents', problem: 'Problems', service_request: 'Service requests' }[e]
}

/** The teams that concluded the most tickets of a kind, busiest first. */
function busiest(teams: readonly PlannedTeam[], facts: OlaFacts, entityType: OlaEntity): PlannedTeam[] {
  return teams
    .map((t) => ({ t, n: facts.of(t.id, entityType).length }))
    .filter((x) => x.n >= MIN_TICKETS)
    .sort((a, b) => b.n - a.n || a.t.name.localeCompare(b.t.name))
    .map((x) => x.t)
}

/** The target the team met on at least 88% of its tickets, and the share it met. */
export function calibratedTarget(
  tickets: readonly OLATicketFacts[], teamId: string, contractFromMs: number, businessHours: boolean,
  calendar: ServiceCalendar | null, timeZone: string, nowMs: number, contractZone: string | null = null,
): { minutes: number; attainment: number } | null {
  const rule = { teamId, createdAt: new Date(contractFromMs).toISOString(), resolveMinutes: Number.MAX_SAFE_INTEGER, businessHours, calendar, timezone: contractZone }
  const used = tickets
    .map((t) => olaTeamMeasure(t, rule, timeZone, new Date(nowMs)))
    .filter((m) => m.applies)
    .map((m) => m.usedMinutes)
  if (used.length < MIN_TICKETS) return null
  for (const minutes of TARGET_LADDER) {
    const attainment = used.filter((u) => u <= minutes).length / used.length
    if (attainment >= MIN_ATTAINMENT) return { minutes, attainment }
  }
  return null
}

export function planOlaContracts(
  rng: Rng, people: PeoplePlan, config: ConfigPlan, facts: OlaFacts, tenantTimeZone: string, startMs: number, nowMs: number,
): PlannedOla[] {
  const createdAtMs = startMs + DAY
  const eligible = people.teams.filter((t) => t.type === 'support' && !t.isChangeManager && t.region !== null)
  const internal = eligible.filter((t) => t.sourcing === 'internal')
  const external = eligible.filter((t) => t.sourcing === 'external')
  const chosen: Choice[] = []
  const taken = new Set<string>()
  const pick = (pool: readonly PlannedTeam[], entityType: OlaEntity, type: 'ola' | 'uc', n: number): void => {
    for (const t of busiest(pool, facts, entityType)) {
      if (chosen.filter((c) => c.entityType === entityType && c.type === type).length >= n) break
      if (taken.has(`${t.id}|${entityType}`)) continue
      taken.add(`${t.id}|${entityType}`)
      chosen.push({ team: t, entityType, type })
    }
  }
  pick(internal, 'incident', 'ola', 4)
  pick(internal, 'service_request', 'ola', 2)
  pick(internal, 'problem', 'ola', 2)
  pick(external, 'incident', 'uc', 2)
  pick(external, 'service_request', 'uc', 2)

  const calendarOf = (t: PlannedTeam): PlannedCalendar =>
    config.calendars.find((c) => c.region === t.region) ?? config.calendar
  const out: PlannedOla[] = []
  chosen.forEach((c, i) => {
    // Half of the internal agreements count on business hours; a supplier's always does.
    const businessHours = c.type === 'uc' || i % 2 === 1
    const cal = calendarOf(c.team)
    const calendar = businessHours ? parseServiceCalendar({ days: cal.days, start: cal.start, end: cal.end, holidays: cal.holidays }) : null
    // The calendar's own zone when it is not the tenant's; a 24×7 contract has no hours to place.
    const timezone = businessHours && cal.timeZone !== tenantTimeZone ? cal.timeZone : null
    const target = calibratedTarget(facts.of(c.team.id, c.entityType), c.team.id, createdAtMs, businessHours, calendar, tenantTimeZone, nowMs, timezone)
    if (!target) return
    const label = entityLabel(c.entityType)
    out.push({
      id: rng.uuid(), type: c.type,
      name: `${c.type === 'ola' ? 'OLA' : 'UC'} ${c.team.name} - ${label}`,
      description: c.type === 'ola'
        ? `Internal agreement: ${c.team.name} works its share of ${label.toLowerCase()} within the target.`
        : `Underpinning contract with the supplier: ${label.toLowerCase()} handled by ${c.team.name}.`,
      entityType: c.entityType, responseMinutes: 60, resolveMinutes: target.minutes,
      calendarId: businessHours ? cal.id : null, partyType: c.type === 'ola' ? 'team' : 'supplier',
      teamId: c.team.id, complianceTarget: 90, complianceWarning: 85, createdAtMs, timezone,
    })
  })
  return out
}
