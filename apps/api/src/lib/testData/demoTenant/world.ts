/**
 * WHAT EVERY SIMULATED TICKET CAN SEE (23 Sep 2026).
 *
 * The people, the teams and who is in them, the CMDB, the configuration and
 * the tenant's workflows — plus the few lookups the simulation asks all the
 * time: the members of a team, the CIs a ticket may name, the SLA deadline a
 * ticket runs against.
 */
import { parseServiceCalendar, type ServiceCalendar } from '@opengraphity/sla'
import type { Rng } from './random.js'
import type { DemoClock } from './clock.js'
import type { PeoplePlan, PlannedTeam, PlannedUser } from './people.js'
import type { CMDBPlan, PlannedCI } from './cmdb.js'
import type { ConfigPlan } from './config.js'
import type { TicketWorkflows } from './workflowModel.js'
import type { Actor, TrailContext } from './trail.js'
import type { SlaClock } from './slaSim.js'

export interface PriorityRules {
  /** impact|urgency → priority (the tenant's `priority` matrix, via `derivePriority`). */
  derive(impact: string, urgency: string): string
  /** priority → the impact and urgency the app back-fills (`invertPriority`). */
  invert(priority: string): { impact: string; urgency: string }
  /** change type|risk band → change priority, and the initial priority by type. */
  changePriority(type: string, band: string): string
  changeInitialPriority(type: string): string
  /** The risk band of an aggregate score (the tenant's thresholds). */
  riskBand(score: number): string
  /** environment → risk score of the `environment_risk` matrix, and its weight. */
  environmentRisk(environment: string): number
  environmentWeight: number
}

export class World {
  readonly usersById: Map<string, PlannedUser>
  readonly teamsById: Map<string, PlannedTeam>
  readonly membersOf: Map<string, Set<string>>
  /** The calendars of the SLA policies, and the tenant's zone: what `slaSim` counts with. */
  readonly sla: SlaClock
  readonly operators: PlannedUser[]
  readonly endUsers: PlannedUser[]
  readonly supportTeams: PlannedTeam[]
  readonly ownerTeams: PlannedTeam[]
  private readonly appsByServer = new Map<string, string[]>()

  constructor(
    readonly rng: Rng,
    readonly clock: DemoClock,
    readonly people: PeoplePlan,
    readonly cmdb: CMDBPlan,
    readonly config: ConfigPlan,
    readonly workflows: TicketWorkflows,
    readonly priority: PriorityRules,
    readonly trail: TrailContext,
    readonly timeZone: string,
  ) {
    this.usersById = new Map(people.users.map((u) => [u.id, u]))
    this.teamsById = new Map(people.teams.map((t) => [t.id, t]))
    this.membersOf = new Map(people.teams.map((t) => [t.id, new Set(t.memberIds)]))
    this.sla = {
      calendars: new Map<string, ServiceCalendar>(config.calendars.map((c) => [c.id, parseServiceCalendar({ days: c.days, start: c.start, end: c.end, holidays: c.holidays })])),
      tenantTimeZone: timeZone,
    }
    this.operators = people.users.filter((u) => u.role === 'operator')
    this.endUsers = people.users.filter((u) => u.role === 'end_user')
    this.supportTeams = people.teams.filter((t) => t.type === 'support' && !t.isChangeManager)
    this.ownerTeams = people.teams.filter((t) => t.type === 'owner')
    for (const [app, servers] of cmdb.appServers) {
      for (const srv of servers) {
        const list = this.appsByServer.get(srv)
        if (list) list.push(app)
        else this.appsByServer.set(srv, [app])
      }
    }
  }

  actor(userId: string): Actor {
    const u = this.usersById.get(userId)
    if (!u) throw new Error(`World.actor: unknown user ${userId}`)
    return { id: u.id, email: u.email, name: u.name }
  }

  /** The applications hosted on a server. */
  appsOnServer(serverId: string): string[] {
    return this.appsByServer.get(serverId) ?? []
  }

  isMember = (userId: string, teamId: string): boolean => this.membersOf.get(teamId)?.has(userId) === true

  /** A member of the team who existed at that moment (the manager is always there). */
  memberOf(rng: Rng, teamId: string, atMs: number): PlannedUser {
    const team = this.teamsById.get(teamId)
    if (!team) throw new Error(`World.memberOf: unknown team ${teamId}`)
    const present = team.memberIds.map((id) => this.usersById.get(id)!).filter((u) => u.createdAtMs <= atMs)
    return present.length ? rng.pick(present) : this.usersById.get(team.managerId)!
  }

  /** Someone of that role who had joined by then. */
  someone(rng: Rng, pool: readonly PlannedUser[], atMs: number): PlannedUser {
    for (let i = 0; i < 20; i++) {
      const u = rng.pick(pool)
      if (u.createdAtMs <= atMs) return u
    }
    const present = pool.filter((u) => u.createdAtMs <= atMs)
    if (!present.length) throw new Error('World.someone: nobody of that role existed at that time')
    return rng.pick(present)
  }

  /** A CI that existed at that moment and is running (active or in maintenance). */
  /**
   * A CI a ticket may name at that moment: it exists, it runs, and it was not
   * planted for CMDB Health (healthFindings.ts) — a planted CI is never a
   * ticket's, its defect stays the only story it tells, and one without its
   * group would leave a task without a team.
   */
  usableCI(c: PlannedCI, atMs: number): boolean {
    return c.createdAtMs <= atMs && (c.status === 'active' || c.status === 'maintenance') && !c.healthFinding
  }

  runningCI(rng: Rng, pool: readonly PlannedCI[], atMs: number): PlannedCI | null {
    for (let i = 0; i < 30; i++) {
      const c = rng.pick(pool)
      if (this.usableCI(c, atMs)) return c
    }
    const ok = pool.filter((c) => this.usableCI(c, atMs))
    return ok.length ? rng.pick(ok) : null
  }
}
