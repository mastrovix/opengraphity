/**
 * THE PEOPLE OF THE DEMO TENANT: USERS AND TEAMS (23 Sep 2026).
 *
 * Decided by the owner of the product:
 *  - 3000 users: 1200 operators (they work tickets, so they sit in teams),
 *    1700 end users (the portal: they open requests), 80 viewers, 20 admins;
 *  - 200 owner teams and 300 support teams, each with a manager; 90% internal
 *    and 10% external suppliers;
 *  - exactly one change-manager team, "Change Management Office": the change
 *    approvals of the CAB go to it.
 *
 * Users exist only in the graph: they are assignees, members, managers and
 * requesters everywhere in the app, but have no login.
 *
 * Every team has a manager who is also a member, and at least one more
 * member: a ticket assigned to a team is assigned to one of its members (the
 * app refuses an assignee outside the team), so an empty team would be a
 * team nobody could ever work for.
 */
import type { Rng } from './random.js'
import { DAY, type DemoClock } from './clock.js'
import {
  CHANGE_MANAGER_TEAM_NAME, COMPANY_COUNTRIES, EMAIL_DOMAIN, INFRASTRUCTURE_AREA, NAME_POOLS, OFFICE_SITES, OWNER_TEAM_AREAS, OWNER_TEAM_UNITS,
  REGION_COUNTRIES, SUPPLIERS, SUPPORT_TEAM_REGIONS, SUPPORT_TEAM_TOWERS, slug, type Country,
} from './names.js'
import { DEMO_RATIOS, type DemoCounts } from './options.js'

export type DemoRole = 'admin' | 'operator' | 'viewer' | 'end_user'

export interface PlannedUser {
  id: string
  name: string
  email: string
  role: DemoRole
  createdAtMs: number
  /** Where the person is from: their names and their office come from it (D22). */
  country: Country
  /** The office they work at (`office_site`), or `Remote`. */
  site: string
}

export type TeamType = 'owner' | 'support'

export interface PlannedTeam {
  id: string
  name: string
  description: string
  type: TeamType
  sourcing: 'internal' | 'external'
  createdAtMs: number
  managerId: string
  memberIds: string[]
  isChangeManager: boolean
  /** Owner teams: the business area. Support teams: the technology tower. */
  area: string
  /** Support teams only: where they work. */
  region: string | null
  /** Owner teams only: the part of the area it answers for (D69). */
  unit?: string
}

export interface PeoplePlan {
  users: PlannedUser[]
  teams: PlannedTeam[]
  changeManagerTeam: PlannedTeam
}

/** How many users of each role: the shares of `DEMO_RATIOS`, the rounding goes to the end users. */
export function roleCounts(total: number): Record<DemoRole, number> {
  const admin = Math.max(1, Math.round(total * DEMO_RATIOS.roles.admin))
  const viewer = Math.round(total * DEMO_RATIOS.roles.viewer)
  const operator = Math.round(total * DEMO_RATIOS.roles.operator)
  const endUser = total - admin - viewer - operator
  if (endUser < 0) throw new Error(`roleCounts: ${String(total)} users are too few for the role shares`)
  return { admin, operator, viewer, end_user: endUser }
}

/** The address a person gets: first.last, without accents, apostrophes or spaces. */
export function emailOf(first: string, last: string, suffix = ''): string {
  return `${slug(first, '.')}.${slug(last, '.')}${suffix}@${EMAIL_DOMAIN}`.replace(/\.{2,}/g, '.')
}

function supplierName(rng: Rng): string {
  return rng.pick(SUPPLIERS)
}

/** The teams, without people yet: names, kinds, regions (the people are chosen for them). */
function planTeamShells(rng: Rng, clock: DemoClock, counts: DemoCounts): PlannedTeam[] {
  /*
   * I prefissi per tipo, chiesti dal proprietario (22 set 2026): `OWN_` per i
   * team che POSSIEDONO un servizio, `SUP_` per quelli che lo tengono in
   * piedi. Stanno nel nome del team — è così che si leggono in un elenco e
   * nella casella «assegna a» — mentre l'area e la regione restano campi a sé.
   */
  const ownerNames: Array<{ name: string; area: string; unit: string }> = []
  for (const area of OWNER_TEAM_AREAS) {
    for (const unit of OWNER_TEAM_UNITS[area] ?? []) ownerNames.push({ name: `OWN_${area} - ${unit}`, area, unit })
  }
  const supportNames: Array<{ name: string; area: string; region: string }> = []
  for (const tower of SUPPORT_TEAM_TOWERS) for (const region of SUPPORT_TEAM_REGIONS) supportNames.push({ name: `SUP_${tower} ${region}`, area: tower, region })
  if (counts.ownerTeams > ownerNames.length) throw new Error(`planTeams: at most ${String(ownerNames.length)} owner teams have a name`)
  if (counts.supportTeams > supportNames.length) throw new Error(`planTeams: at most ${String(supportNames.length)} support teams have a name`)

  // The infrastructure's owners are always there: they own what no application claims (D75).
  const infra = ownerNames.filter((o) => o.area === INFRASTRUCTURE_AREA).slice(0, counts.ownerTeams)
  const owners = [...infra, ...rng.sample(ownerNames.filter((o) => o.area !== INFRASTRUCTURE_AREA), counts.ownerTeams - infra.length)]
  const supports = rng.sample(supportNames, counts.supportTeams)
  // 10% external in each kind, so both kinds have suppliers (an OLA with a
  // supplier is an underpinning contract, and needs an external team).
  const externalOwners = new Set(rng.sample(owners.map((_, i) => i), Math.round(owners.length * (1 - DEMO_RATIOS.internalTeams))))
  const externalSupports = new Set(rng.sample(supports.map((_, i) => i), Math.round(supports.length * (1 - DEMO_RATIOS.internalTeams))))

  const teamStart = clock.startMs
  const teamEnd = clock.startMs + 14 * DAY
  const teams: PlannedTeam[] = []
  owners.forEach((o, i) => {
    const external = externalOwners.has(i)
    const supplier = external ? supplierName(rng) : null
    teams.push({
      id: rng.uuid(),
      name: supplier ? `${o.name} (${supplier})` : o.name,
      // D69: the unit makes each description its own, not five copies of one.
      description: supplier
        ? `${supplier} team that owns the ${o.unit} applications of ${o.area} under contract.`
        : `Owns the ${o.unit} applications of ${o.area}: requirements, releases and business acceptance.`,
      type: 'owner', sourcing: external ? 'external' : 'internal',
      createdAtMs: clock.between(rng, teamStart, teamEnd), managerId: '', memberIds: [],
      isChangeManager: false, area: o.area, region: null, unit: o.unit,
    })
  })
  supports.forEach((s, i) => {
    const external = externalSupports.has(i)
    const supplier = external ? supplierName(rng) : null
    teams.push({
      id: rng.uuid(),
      name: supplier ? `${s.name} (${supplier})` : s.name,
      description: supplier
        ? `${supplier} engineers providing ${s.area} support for ${s.region} under contract.`
        : `${s.area} support for ${s.region}: operations, incidents and changes.`,
      type: 'support', sourcing: external ? 'external' : 'internal',
      createdAtMs: clock.between(rng, teamStart, teamEnd), managerId: '', memberIds: [],
      isChangeManager: false, area: s.area, region: s.region,
    })
  })
  teams.push({
    id: rng.uuid(), name: CHANGE_MANAGER_TEAM_NAME,
    description: 'Change Advisory Board: reviews and approves the normal and emergency changes.',
    type: 'support', sourcing: 'internal', createdAtMs: clock.between(rng, teamStart, teamEnd),
    managerId: '', memberIds: [], isChangeManager: true, area: 'Change Management', region: null,
  })
  return teams
}

/**
 * The team each operator works in first: every team gets its manager and one
 * more member, the rest go where the work is (support teams are larger).
 */
function homeTeams(rng: Rng, teams: readonly PlannedTeam[], operators: number): PlannedTeam[] {
  if (operators < teams.length * 2) throw new Error('planTeams: not enough operators for a manager and a member per team')
  const support = teams.filter((t) => t.type === 'support' && !t.isChangeManager)
  const out: PlannedTeam[] = [...teams, ...rng.shuffle(teams)]
  while (out.length < operators) out.push(rng.chance(0.7) && support.length ? rng.pick(support) : rng.pick(teams))
  return out
}

/** The country of someone who works in this team: the region's, or the company's for owner and global teams. */
function countryFor(rng: Rng, team: PlannedTeam | null): Country {
  const mix = team?.region ? REGION_COUNTRIES[team.region] ?? COMPANY_COUNTRIES : COMPANY_COUNTRIES
  return rng.weighted(mix)
}

/** A name of that country no one else has (the list of users must not repeat a person). */
function uniqueName(rng: Rng, country: Country, taken: Set<string>, emails: Set<string>): { name: string; email: string } {
  const pool = NAME_POOLS[country]
  for (let attempt = 0; attempt < 400; attempt++) {
    const first = rng.pick(pool.first)
    const last = rng.pick(pool.last)
    const name = `${first} ${last}`
    const email = emailOf(first, last)
    if (taken.has(name) || emails.has(email)) continue
    taken.add(name)
    emails.add(email)
    return { name, email }
  }
  throw new Error(`planUsers: the ${country} name pool ran out of unique names`)
}

function siteFor(rng: Rng, country: Country, role: DemoRole): string {
  // A share of the employees works from home; the staff sits in an office.
  if (role === 'end_user' && rng.chance(0.08)) return 'Remote'
  return rng.weighted(OFFICE_SITES[country])
}

export function planPeople(rng: Rng, clock: DemoClock, counts: DemoCounts): PeoplePlan {
  const teams = planTeamShells(rng.fork('teams'), clock, counts)
  const urng = rng.fork('users')
  const byRole = roleCounts(counts.users)
  const homes = urng.shuffle(homeTeams(urng, teams, byRole.operator))
  const roles: DemoRole[] = [
    ...Array<DemoRole>(byRole.admin).fill('admin'),
    ...Array<DemoRole>(byRole.operator).fill('operator'),
    ...Array<DemoRole>(byRole.viewer).fill('viewer'),
    ...Array<DemoRole>(byRole.end_user).fill('end_user'),
  ]
  const earlyEnd = clock.startMs + 30 * DAY
  const taken = new Set<string>()
  const emails = new Set<string>()
  let operatorIndex = 0
  const home = new Map<string, PlannedTeam>()
  const users: PlannedUser[] = roles.map((role) => {
    const team = role === 'operator' ? homes[operatorIndex++]! : null
    const country = countryFor(urng, team)
    const { name, email } = uniqueName(urng, country, taken, emails)
    // Staff is there from the start; a share of the portal users joins over the years.
    const joinsLater = role === 'end_user' && urng.chance(0.4)
    const createdAtMs = joinsLater
      ? clock.workInstant(urng, earlyEnd, clock.nowMs - 7 * DAY)
      : clock.workInstant(urng, clock.startMs, earlyEnd)
    const user: PlannedUser = { id: urng.uuid(), name, email, role, createdAtMs, country, site: siteFor(urng, country, role) }
    if (team) home.set(user.id, team)
    return user
  })
  staffTeams(rng.fork('members'), teams, users.filter((u) => u.role === 'operator'), home)
  return { users, teams, changeManagerTeam: teams.find((t) => t.isChangeManager)! }
}

/**
 * Managers and members. Each team's manager is its first operator; a share of
 * the operators also works for a second team — of their own region, or a
 * global one, as people do (D22: nobody from the APAC desk in the Italian one).
 */
function staffTeams(rng: Rng, teams: readonly PlannedTeam[], operators: readonly PlannedUser[], home: ReadonlyMap<string, PlannedTeam>): void {
  for (const u of operators) {
    const t = home.get(u.id)!
    if (!t.managerId) t.managerId = u.id
    t.memberIds.push(u.id)
  }
  for (const u of rng.sample([...operators], Math.round(operators.length * 0.3))) {
    const own = home.get(u.id)!
    const near = teams.filter((t) => t.id !== own.id && !t.isChangeManager && (t.region === own.region || t.region === 'Global' || t.region === null))
    // No team near them (a tenant with one owner team and no global desk): no second team, rather than a desk of another country.
    if (!near.length) continue
    // `near` leaves out their own team, and each operator is drawn once: they are not in it yet.
    rng.pick(near).memberIds.push(u.id)
  }
}
