/**
 * THE OLA AND UC CONTRACTS, WHERE THE TEAMS REALLY WORK (tour of 23 Sep 2026,
 * D64) — what olaPlan.test.ts does not already pin.
 *
 * The contracts are chosen AFTER the three years are simulated, from the
 * tickets the teams concluded:
 *
 *  - a ticket is a fact for every team that held it, once it is concluded
 *    (a request when it is completed, the others when they are resolved);
 *  - for each kind, the BUSIEST teams, and only as many as the owner's plan
 *    asks (four OLAs on incidents, two on requests, two on problems, two UCs
 *    on incidents and two on requests); below 25 concluded tickets a team's
 *    attainment is noise, and it gets none;
 *  - the target is the first ROUND target the team met on at least 88% of its
 *    tickets; a team no round target can hold gets no contract;
 *  - a supplier's contract is a UC, always on business hours; an internal one
 *    is an OLA, half of them on business hours; the hours are those of the
 *    team's region, read in that calendar's own zone — a global team counts on
 *    the headquarters' calendar.
 */
import { describe, it, expect, vi } from 'vitest'
import { Rng } from '../random.js'
import { DAY, HOUR } from '../clock.js'
import { OlaFacts, calibratedTarget, planOlaContracts } from '../olaPlan.js'

// @opengraphity/sla (the product's business-minutes arithmetic) also carries the SLA engine, which reaches Neo4j: no driver here.
vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(), runQueryOne: vi.fn(), getSession: vi.fn(), writeSession: vi.fn() }))
import type { TicketTrail } from '../trail.js'
import type { ConfigPlan, PlannedCalendar } from '../config.js'
import type { PeoplePlan, PlannedTeam } from '../people.js'

const NOW = Date.parse('2026-09-23T06:00:00Z')
const START = NOW - 365 * DAY
const TZ = 'Europe/Rome'
/** The round targets an administrator writes, in minutes. */
const ROUND_TARGETS = [30, 60, 120, 240, 480, 720, 960, 1440, 1920, 2400, 3600, 4800, 7200, 9600, 14400, 19200]

const calendar = (region: string, timeZone: string): PlannedCalendar => ({
  id: `cal-${region}`, name: `Business Hours ${region}`, days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', holidays: [], region, timeZone,
})
const CAL_IT = calendar('Italy', 'Europe/Rome')
const CAL_APAC = calendar('APAC', 'Asia/Singapore')
const CONFIG = { calendars: [CAL_IT, CAL_APAC], calendar: CAL_IT } as unknown as ConfigPlan

const team = (id: string, region: string | null, sourcing: 'internal' | 'external', over: Partial<PlannedTeam> = {}): PlannedTeam =>
  ({ id, name: `SUP_${id}`, type: 'support', isChangeManager: false, region, sourcing, area: 'Service Desk', ...over }) as unknown as PlannedTeam

type Kind = 'incident' | 'problem' | 'service_request'

/** A ticket the teams held one after the other for `hours` each, concluded at the end; the last team's segment is still open. */
function ticket(teamIds: readonly string[], i: number, hours: number, kind: Kind = 'incident', concluded = true): TicketTrail {
  const start = Date.parse('2026-03-02T07:00:00Z') + (i % 20) * 7 * DAY
  const end = start + teamIds.length * hours * HOUR
  const segments = teamIds.map((teamId, k) => ({
    id: `s-${String(k)}`, team_id: teamId, inferred: false as const,
    started_at: new Date(start + k * hours * HOUR).toISOString(),
    ...(k < teamIds.length - 1 ? { ended_at: new Date(start + (k + 1) * hours * HOUR).toISOString() } : {}),
  }))
  return {
    createdAtMs: start, teamId: teamIds[teamIds.length - 1] ?? null, segments,
    resolvedAtMs: concluded && kind !== 'service_request' ? end : null,
    completedAtMs: concluded && kind === 'service_request' ? end : null,
  } as unknown as TicketTrail
}

function factsOf(spec: Array<[teamId: string, count: number, hours: number, kind?: Kind]>): OlaFacts {
  const facts = new OlaFacts()
  for (const [teamId, count, hours, kind] of spec) for (let i = 0; i < count; i++) facts.add(kind ?? 'incident', ticket([teamId], i, hours, kind))
  return facts
}

const plan = (teams: PlannedTeam[], facts: OlaFacts) =>
  planOlaContracts(new Rng('ola-more'), { teams, users: [] } as unknown as PeoplePlan, CONFIG, facts, TZ, START, NOW)

describe('D64: what a team concluded', () => {
  it('a ticket counts for every team that held it, with the segment still open when it was concluded', () => {
    const facts = new OlaFacts()
    facts.add('incident', ticket(['t-1', 't-2'], 0, 3))
    for (const teamId of ['t-1', 't-2']) {
      const [f] = facts.of(teamId, 'incident')
      expect(f!.segments.map((s) => [s.teamId, s.endedAt === null])).toEqual([['t-1', false], ['t-2', true]])
      expect(f!.currentTeamId).toBe('t-2')
    }
  })

  it('a request is concluded when completed, an incident or a problem when resolved; one not concluded, or never with a team, is no fact', () => {
    const facts = new OlaFacts()
    facts.add('service_request', ticket(['t-1'], 0, 2, 'service_request'))
    facts.add('problem', ticket(['t-1'], 1, 2, 'problem'))
    facts.add('incident', ticket(['t-1'], 2, 2, 'incident', false))
    facts.add('incident', ticket([], 3, 2))
    // A request resolved but not completed is not concluded.
    facts.add('service_request', { ...ticket(['t-1'], 4, 2, 'incident'), completedAtMs: null } as unknown as TicketTrail)
    expect(facts.of('t-1', 'service_request')).toHaveLength(1)
    expect(facts.of('t-1', 'problem')).toHaveLength(1)
    expect(facts.of('t-1', 'incident')).toEqual([])
    expect(facts.of('t-nobody', 'incident')).toEqual([])
  })
})

describe('D64: the target a team can keep', () => {
  const facts = factsOf([['t-1', 80, 3]])
  const tickets = facts.of('t-1', 'incident')
  const at = (list: typeof tickets) => calibratedTarget(list, 't-1', START + DAY, false, null, TZ, NOW)

  it('is the first round target met on at least 88% of the tickets', () => {
    // All held three hours: 180 minutes is not a round target, four hours is.
    expect(at(tickets)).toEqual({ minutes: 240, attainment: 1 })
    // Nine in ten within three hours, the rest a day: still four hours (90% ≥ 88%).
    const mixed = [...tickets.slice(0, 72), ...factsOf([['t-1', 8, 24]]).of('t-1', 'incident')]
    expect(at(mixed)).toEqual({ minutes: 240, attainment: 0.9 })
  })

  it('below 25 concluded tickets there is no measure, and no target', () => {
    expect(at(tickets.slice(0, 24))).toBeNull()
    expect(at(tickets.slice(0, 25))).not.toBeNull()
  })

  it('a team that no round target can hold has none', () => {
    const slow = factsOf([['t-1', 30, 20 * 24]]).of('t-1', 'incident')
    expect(at(slow)).toBeNull()
  })
})

describe('D64: who gets a contract', () => {
  it('the busiest teams, only as many as the plan asks: four OLAs on incidents', () => {
    const teams = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => team(id, 'Italy', 'internal'))
    const olas = plan(teams, factsOf([['a', 80, 3], ['b', 70, 3], ['c', 60, 3], ['d', 50, 3], ['e', 40, 3], ['f', 24, 3]]))
    expect(olas.map((o) => o.teamId)).toEqual(['a', 'b', 'c', 'd'])
    expect(olas.every((o) => o.type === 'ola' && o.entityType === 'incident' && o.partyType === 'team')).toBe(true)
  })

  it('an OLA is an internal agreement on the team\'s share of the work; half count on business hours, the others round the clock', () => {
    const teams = [team('desk', 'Italy', 'internal'), team('ops', 'Italy', 'internal')]
    const olas = plan(teams, factsOf([['desk', 60, 3, 'service_request'], ['ops', 40, 3, 'service_request'], ['desk', 30, 3, 'problem']]))
    expect(olas.map((o) => [o.name, o.calendarId])).toEqual([
      ['OLA SUP_desk - Service requests', null],
      ['OLA SUP_ops - Service requests', CAL_IT.id],
      ['OLA SUP_desk - Problems', null],
    ])
    expect(olas[0]!.description).toBe('Internal agreement: SUP_desk works its share of service requests within the target.')
    for (const o of olas) {
      expect(ROUND_TARGETS).toContain(o.resolveMinutes)
      expect(o).toMatchObject({ responseMinutes: 60, complianceTarget: 90, complianceWarning: 85, createdAtMs: START + DAY, timezone: null })
    }
  })

  it('a supplier gets an underpinning contract, always on business hours, on its region\'s calendar read in that calendar\'s zone', () => {
    const olas = plan([team('apac', 'APAC', 'external')], factsOf([['apac', 30, 3]]))
    expect(olas).toHaveLength(1)
    expect(olas[0]).toMatchObject({
      type: 'uc', partyType: 'supplier', name: 'UC SUP_apac - Incidents', entityType: 'incident',
      description: 'Underpinning contract with the supplier: incidents handled by SUP_apac.',
      calendarId: CAL_APAC.id, timezone: 'Asia/Singapore',
    })
  })

  it('a global team has no calendar of its own: it counts on the headquarters\'', () => {
    const olas = plan([team('it', 'Italy', 'internal'), team('global', 'Global', 'internal')], factsOf([['it', 60, 3], ['global', 40, 3]]))
    const global = olas.find((o) => o.teamId === 'global')!
    expect(global.calendarId).toBe(CONFIG.calendar.id)
    // The headquarters' calendar is in the tenant's zone: no zone of its own.
    expect(global.timezone).toBeNull()
  })

  it('a team no round target fits gets no contract, even when it is the busiest', () => {
    const olas = plan([team('slow', 'Italy', 'internal'), team('fast', 'Italy', 'internal')], factsOf([['slow', 90, 20 * 24], ['fast', 40, 3]]))
    expect(olas.map((o) => o.teamId)).toEqual(['fast'])
  })

  it('no contract for teams without a region, change managers or owner teams', () => {
    const teams = [
      team('owner', null, 'internal', { type: 'owner' } as Partial<PlannedTeam>),
      team('cab', 'Italy', 'internal', { isChangeManager: true }),
      team('noregion', null, 'internal'),
    ]
    expect(plan(teams, factsOf([['owner', 60, 3], ['cab', 60, 3], ['noregion', 60, 3]]))).toEqual([])
  })
})
