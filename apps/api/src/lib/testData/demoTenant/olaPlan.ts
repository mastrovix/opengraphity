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

/**
 * Round targets an administrator writes, in minutes — up to 20 and 30 days
 * (review of 23 Sep 2026): a problem is worked for weeks, and its team's time
 * went past the old top of the ladder (19,200 minutes).
 */
const TARGET_LADDER = [30, 60, 120, 240, 480, 720, 960, 1440, 1920, 2400, 3600, 4800, 7200, 9600, 14400, 19200, 28800, 43200]
const MIN_ATTAINMENT = 0.88
/**
 * Below this many concluded tickets a team's attainment is noise, not a
 * measure. Problems are about one for every sixty incidents: 800 over ~300
 * support teams is two or three each, and with 25 no team ever qualified —
 * the two problem OLAs the owner asked for were never written, without a
 * word (review of 23 Sep 2026). Five is what a problem team can show.
 */
const MIN_TICKETS: Readonly<Record<OlaEntity, number>> = { incident: 25, service_request: 25, problem: 5 }

/**
 * The contracts the demo has, by kind and type: the owner's twelve. Exported
 * so that verify counts them — a contract that cannot be made stops the
 * generator, naming it, instead of disappearing.
 */
export const OLA_REQUESTS: ReadonlyArray<{ entityType: OlaEntity; type: 'ola' | 'uc'; n: number }> = [
  { entityType: 'incident',        type: 'ola', n: 4 },
  { entityType: 'service_request', type: 'ola', n: 2 },
  { entityType: 'problem',         type: 'ola', n: 2 },
  { entityType: 'incident',        type: 'uc',  n: 2 },
  { entityType: 'service_request', type: 'uc',  n: 2 },
]
export const OLA_CONTRACT_COUNT = OLA_REQUESTS.reduce((s, r) => s + r.n, 0)

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


function entityLabel(e: OlaEntity): string {
  return { incident: 'Incidents', problem: 'Problems', service_request: 'Service requests' }[e]
}

/** The teams that concluded the most tickets of a kind, busiest first. */
function busiest(teams: readonly PlannedTeam[], facts: OlaFacts, entityType: OlaEntity): PlannedTeam[] {
  return teams
    .map((t) => ({ t, n: facts.of(t.id, entityType).length }))
    .filter((x) => x.n >= MIN_TICKETS[entityType])
    .sort((a, b) => b.n - a.n || a.t.name.localeCompare(b.t.name))
    .map((x) => x.t)
}

/** The target the team met on at least 88% of its tickets, and the share it met. */
export function calibratedTarget(
  tickets: readonly OLATicketFacts[], teamId: string, contractFromMs: number, businessHours: boolean,
  calendar: ServiceCalendar | null, timeZone: string, nowMs: number, contractZone: string | null = null,
  minTickets = MIN_TICKETS.incident,
): { minutes: number; attainment: number } | null {
  const rule = { teamId, createdAt: new Date(contractFromMs).toISOString(), resolveMinutes: Number.MAX_SAFE_INTEGER, businessHours, calendar, timezone: contractZone }
  const used = tickets
    .map((t) => olaTeamMeasure(t, rule, timeZone, new Date(nowMs)))
    .filter((m) => m.applies)
    .map((m) => m.usedMinutes)
  if (used.length < minTickets) return null
  for (const minutes of TARGET_LADDER) {
    const attainment = used.filter((u) => u <= minutes).length / used.length
    if (attainment >= MIN_ATTAINMENT) return { minutes, attainment }
  }
  return null
}

/**
 * The contracts, and the ones that could not be made — each named with the
 * reason, never dropped in silence. The generator stops on a shortfall of the
 * full demo and reports it at a reduced scale (generate.ts).
 */
export function planOlaContracts(
  rng: Rng, people: PeoplePlan, config: ConfigPlan, facts: OlaFacts, tenantTimeZone: string, startMs: number, nowMs: number,
): { contracts: PlannedOla[]; shortfalls: string[] } {
  const createdAtMs = startMs + DAY
  const eligible = people.teams.filter((t) => t.type === 'support' && !t.isChangeManager && t.region !== null)
  const pools = { ola: eligible.filter((t) => t.sourcing === 'internal'), uc: eligible.filter((t) => t.sourcing === 'external') }
  const calendarOf = (t: PlannedTeam): PlannedCalendar =>
    config.calendars.find((c) => c.region === t.region) ?? config.calendar
  const out: PlannedOla[] = []
  const shortfalls: string[] = []
  const taken = new Set<string>()
  for (const req of OLA_REQUESTS) {
    const candidates = busiest(pools[req.type], facts, req.entityType)
    let made = 0
    // A team whose tickets reach no target on the ladder is passed over for
    // the next busiest, instead of taking its slot and being dropped.
    for (const team of candidates) {
      if (made >= req.n) break
      if (taken.has(`${team.id}|${req.entityType}`)) continue
      // Half of the internal agreements count on business hours; a supplier's always does.
      const businessHours = req.type === 'uc' || out.length % 2 === 1
      const cal = calendarOf(team)
      const calendar = businessHours ? parseServiceCalendar({ days: cal.days, start: cal.start, end: cal.end, holidays: cal.holidays }) : null
      // The calendar's own zone when it is not the tenant's; a 24×7 contract has no hours to place.
      const timezone = businessHours && cal.timeZone !== tenantTimeZone ? cal.timeZone : null
      const target = calibratedTarget(facts.of(team.id, req.entityType), team.id, createdAtMs, businessHours, calendar, tenantTimeZone, nowMs, timezone, MIN_TICKETS[req.entityType])
      if (!target) continue
      taken.add(`${team.id}|${req.entityType}`)
      made++
      out.push(plannedOla(rng, team, req.entityType, req.type, target.minutes, businessHours ? cal.id : null, createdAtMs, timezone))
    }
    if (made < req.n) {
      shortfalls.push(`${req.type.toUpperCase()} on ${entityLabel(req.entityType).toLowerCase()}: ${String(made)} of ${String(req.n)} — ${String(candidates.length)} ${req.type === 'ola' ? 'internal' : 'external'} teams concluded at least ${String(MIN_TICKETS[req.entityType])}, and a team counts only if ${String(MIN_ATTAINMENT * 100)}% of its tickets fit a target of at most ${String(TARGET_LADDER.at(-1)! / 1440)} days`)
    }
  }
  return { contracts: out, shortfalls }
}

function plannedOla(
  rng: Rng, team: PlannedTeam, entityType: OlaEntity, type: 'ola' | 'uc', minutes: number,
  calendarId: string | null, createdAtMs: number, timezone: string | null,
): PlannedOla {
  const label = entityLabel(entityType)
  return {
    id: rng.uuid(), type,
    name: `${type === 'ola' ? 'OLA' : 'UC'} ${team.name} - ${label}`,
    description: type === 'ola'
      ? `Internal agreement: ${team.name} works its share of ${label.toLowerCase()} within the target.`
      : `Underpinning contract with the supplier: ${label.toLowerCase()} handled by ${team.name}.`,
    entityType, responseMinutes: 60, resolveMinutes: minutes,
    calendarId, partyType: type === 'ola' ? 'team' : 'supplier',
    teamId: team.id, complianceTarget: 90, complianceWarning: 85, createdAtMs, timezone,
  }
}
