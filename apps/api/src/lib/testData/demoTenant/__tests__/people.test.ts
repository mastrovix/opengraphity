/**
 * THE PEOPLE OF THE DEMO TENANT AT THEIR EDGES (tour of 23 Sep 2026).
 *
 * peopleAndCmdb.test.ts checks the owner's decisions on the full-size tenant:
 * 3000 users, 200 owner and 300 support teams, where every name pool has room
 * and every team has neighbours. This file builds the tenants where that is
 * not so — one owner team, a single regional desk, more teams or people than
 * there are names — and pins what the plan does there: the shares of
 * `DEMO_RATIOS` at any size, the infrastructure's teams that always exist
 * (D75), the suppliers, and the pools that run out, which must stop the plan
 * with a sentence instead of repeating a team or a person (the owner's rule:
 * no silent fallbacks). The defect found on the way (23 Sep 2026) is fixed:
 * the test that found it says what was wrong.
 */
import { describe, it, expect } from 'vitest'
import { Rng } from '../random.js'
import { DemoClock } from '../clock.js'
import { DEFAULT_DEMO_COUNTS, DEMO_RATIOS, type DemoCounts } from '../options.js'
import { planPeople, roleCounts, type PlannedTeam } from '../people.js'
import {
  INFRASTRUCTURE_AREA, NAME_POOLS, OWNER_TEAM_AREAS, OWNER_TEAM_UNITS, REGION_COUNTRIES, SUPPLIERS, SUPPORT_TEAM_REGIONS,
  SUPPORT_TEAM_TOWERS,
} from '../names.js'

const NOW = Date.parse('2026-09-23T10:00:00.000Z')
const clock = new DemoClock(NOW, 3, 'Europe/Rome')
const withCounts = (ask: Partial<DemoCounts>): DemoCounts => ({ ...DEFAULT_DEMO_COUNTS, ...ask })
/** The one support team that is not the Change Management Office. */
const deskOf = (teams: readonly PlannedTeam[]): PlannedTeam => teams.find((t) => t.type === 'support' && !t.isChangeManager)!

/*
 * The fewest teams there can be — one owner team, one support team and the
 * Change Management Office — need six operators, and fifteen users make six
 * (40%). Each team then has exactly its two operators at home — the manager
 * and one member — and two operators (30%) are drawn for a second team.
 */
const SMALLEST = withCounts({ users: 15, ownerTeams: 1, supportTeams: 1 })

describe('how many users of each role', () => {
  it('the owner\'s shares hold at any size, and what the rounding leaves goes to the end users', () => {
    expect(roleCounts(400)).toEqual({ admin: 3, operator: 160, viewer: 11, end_user: 226 })
    expect(roleCounts(15)).toEqual({ admin: 1, operator: 6, viewer: 0, end_user: 8 })
    for (const total of [1, 2, 7, 15, 99, 400, 1234, 3000, 10000]) {
      const c = roleCounts(total)
      expect(c.admin + c.operator + c.viewer + c.end_user, String(total)).toBe(total)
      expect(c.operator, String(total)).toBe(Math.round(total * DEMO_RATIOS.roles.operator))
      expect(c.end_user, String(total)).toBeGreaterThanOrEqual(0)
    }
  })

  it('a tenant always has an admin; with no users at all nobody can be one, and the plan stops', () => {
    expect(roleCounts(1)).toEqual({ admin: 1, operator: 0, viewer: 0, end_user: 0 })
    expect(() => roleCounts(0)).toThrow('roleCounts: 0 users are too few for the role shares')
  })
})

describe('the teams', () => {
  it('D69: owner teams are named area × unit — all 205 names can be used, each once, and one more stops the plan', () => {
    const pool = Object.values(OWNER_TEAM_UNITS).reduce((n, units) => n + units.length, 0)
    expect(pool).toBe(205)
    // 1100 users make 440 operators: two for each of the 207 teams.
    const p = planPeople(new Rng('every-owner-team'), clock, withCounts({ users: 1100, ownerTeams: pool, supportTeams: 1 }))
    const owners = p.teams.filter((t) => t.type === 'owner')
    expect(new Set(owners.map((t) => `${t.area} - ${t.unit!}`)))
      .toEqual(new Set(OWNER_TEAM_AREAS.flatMap((area) => OWNER_TEAM_UNITS[area]!.map((unit) => `${area} - ${unit}`))))
    for (const t of owners) expect(t.name.startsWith(`OWN_${t.area} - ${t.unit!}`), t.name).toBe(true)
    expect(() => planPeople(new Rng('every-owner-team'), clock, withCounts({ users: 1100, ownerTeams: pool + 1, supportTeams: 1 })))
      .toThrow(`planTeams: at most ${String(pool)} owner teams have a name`)
  })

  it('support teams are named tower × region: the owner\'s 300 are the whole pool, and one more stops the plan', () => {
    const pool = SUPPORT_TEAM_TOWERS.length * SUPPORT_TEAM_REGIONS.length
    expect(pool).toBe(DEFAULT_DEMO_COUNTS.supportTeams)
    expect(() => planPeople(new Rng('every-desk'), clock, withCounts({ users: 1000, ownerTeams: 1, supportTeams: pool + 1 })))
      .toThrow(`planTeams: at most ${String(pool)} support teams have a name`)
  })

  it('D75: the infrastructure\'s owner teams come first — a tenant with a single owner team has its Data Centre', () => {
    const ownersOf = (ownerTeams: number): PlannedTeam[] =>
      planPeople(new Rng('infrastructure-first'), clock, withCounts({ users: 60, ownerTeams, supportTeams: 1 })).teams.filter((t) => t.type === 'owner')
    const infrastructureUnits = OWNER_TEAM_UNITS[INFRASTRUCTURE_AREA]!
    expect(ownersOf(1).map((t) => [t.area, t.unit])).toEqual([[INFRASTRUCTURE_AREA, 'Data Centre']])
    expect(ownersOf(5).map((t) => t.unit)).toEqual(infrastructureUnits)
    const eight = ownersOf(8)
    expect(eight.slice(0, 5).map((t) => t.unit)).toEqual(infrastructureUnits)
    for (const t of eight.slice(5)) expect(t.area).not.toBe(INFRASTRUCTURE_AREA)
  })

  it('a tenth of each kind of team is an external supplier, named and described as the supplier\'s (an OLA with a supplier is an underpinning contract)', () => {
    const p = planPeople(new Rng('suppliers'), clock, withCounts({ users: 400, ownerTeams: 20, supportTeams: 40 }))
    const external = (type: PlannedTeam['type']): PlannedTeam[] => p.teams.filter((t) => t.type === type && t.sourcing === 'external')
    expect(external('owner')).toHaveLength(2)
    expect(external('support')).toHaveLength(4)
    for (const t of p.teams) {
      const supplier = SUPPLIERS.find((s) => t.name.endsWith(` (${s})`))
      expect(supplier !== undefined, t.name).toBe(t.sourcing === 'external')
      if (supplier) {
        expect(t.description.startsWith(`${supplier} `), t.description).toBe(true)
        expect(t.description.endsWith(' under contract.'), t.description).toBe(true)
      }
    }
    expect(p.changeManagerTeam.sourcing).toBe('internal')
  })

  it('a manager and a member per team: five operators for three teams stop the plan, six are enough', () => {
    expect(roleCounts(12).operator).toBe(5)
    expect(() => planPeople(new Rng('few-operators'), clock, withCounts({ users: 12, ownerTeams: 1, supportTeams: 1 })))
      .toThrow('planTeams: not enough operators for a manager and a member per team')
    const p = planPeople(new Rng('few-operators'), clock, SMALLEST)
    const operators = new Set(p.users.filter((u) => u.role === 'operator').map((u) => u.id))
    expect(operators.size).toBe(6)
    for (const t of p.teams) {
      expect(operators.has(t.managerId), t.name).toBe(true)
      expect(t.memberIds, t.name).toContain(t.managerId)
      expect(t.memberIds.length, t.name).toBeGreaterThanOrEqual(2)
    }
    expect(new Set(p.teams.map((t) => t.managerId)).size).toBe(p.teams.length)
  })
})

describe('the people in the teams', () => {
  it('a name pool with no new name left stops the plan instead of listing a person twice', () => {
    // Seed s8: the one support team is a Benelux desk. The team shells do not
    // depend on the users, so a small tenant shows the desk of the large one.
    expect(deskOf(planPeople(new Rng('s8'), clock, SMALLEST).teams).region).toBe('Benelux')
    expect(REGION_COUNTRIES['Benelux']).toEqual([['NL', 1]])
    // 1225 Dutch and Flemish names. 5000 users make 2000 operators, four in
    // five of them at the only desk (70% of those beyond the first six go to a
    // support team, and a third of the rest): ~1600 people for 1225 names.
    expect(NAME_POOLS.NL.first.length * NAME_POOLS.NL.last.length).toBe(1225)
    expect(() => planPeople(new Rng('s8'), clock, withCounts({ users: 5000, ownerTeams: 1, supportTeams: 1 })))
      .toThrow('planUsers: the NL name pool ran out of unique names')
  })

  it('a team lists each person once, and an operator with no team near them gets no second team', () => {
    const p = planPeople(new Rng('s9'), clock, SMALLEST)
    for (const t of p.teams) expect(new Set(t.memberIds).size, t.name).toBe(t.memberIds.length)
    // Six operators at home, two in each team. The two drawn for a second
    // team are, with this seed, both of the owner team — which has no team
    // near it (no other owner team, no global desk): nobody was added.
    expect(p.teams.reduce((n, t) => n + t.memberIds.length, 0)).toBe(6)
  })

  it('D22: a second team is of the operator\'s own region or a global one — never a desk of another country, nor the Change Management Office — even with one owner team and no global desk', () => {
    // Found by this test (23 Sep 2026), fixed: when an operator had no team
    // "near" them — the operators of the only owner team, in a tenant with no
    // other owner team and no Global desk — the second team was
    // `rng.pick(teams)`: ANY team, a regional desk of another country
    // included (D22: «nobody from the APAC desk in the Italian one») and the
    // Change Management Office, which the `near` filter itself excludes. With
    // seed s38 an Italian owner-team operator joined the Nordics desk and
    // another one the CAB's team. Such an operator now has no second team
    // (people.ts, `staffTeams`).
    const p = planPeople(new Rng('s38'), clock, SMALLEST)
    const desk = deskOf(p.teams)
    // The scenario needs a regional desk.
    expect(desk.region === null || desk.region === 'Global').toBe(false)
    const byId = new Map(p.users.map((u) => [u.id, u]))
    const countries = REGION_COUNTRIES[desk.region!]!.map(([country]) => country)
    for (const id of desk.memberIds) expect(countries, `${byId.get(id)!.name} in ${desk.name}`).toContain(byId.get(id)!.country)
    // Its own two operators and nobody else: no one's near team is the CAB's.
    expect(p.changeManagerTeam.memberIds).toHaveLength(2)
  })
})
