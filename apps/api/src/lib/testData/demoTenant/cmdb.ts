/**
 * THE DEMO TENANT'S CMDB (23 Sep 2026).
 *
 * The owner of the product fixed the shape:
 *  - business applications, applications (each realizing at least one
 *    business application), capabilities (each enabled by business
 *    applications), servers, database instances (hosted on servers),
 *    databases (on an instance, used by applications), certificates;
 *  - the only dependency chains are  application → server  and
 *    application → database → database instance → server;
 *  - a certificate is related only to applications, databases, database
 *    instances and servers, and a certificate used by an application is also
 *    installed on the servers that application runs on;
 *  - environments mixed, mostly production; 75% of the CIs active.
 *
 * Every edge is one the metamodel declares, in the direction the app writes
 * it (`addCIRelationship`): an undeclared edge is refused by the app and
 * hidden by the CI page, so writing one here would be a lie about what the
 * app can hold.
 *
 * Consistency a person would expect, and the app does not enforce: a CI runs
 * on CIs of its own environment, an active application is not hosted on a
 * decommissioned server, and nothing depends on a CI created after it.
 */
import type { Rng } from './random.js'
import { DAY, type DemoClock } from './clock.js'
import {
  APPLICATION_CODE_NAMES, APPLICATION_COMPONENTS, BA_KINDS, BA_QUALIFIERS, BA_SUBJECTS, BUSINESS_UNITS, CAPABILITY_ASPECTS, CAPABILITY_CAPACITY,
  CAPABILITY_TREE, CERTIFICATE_DOMAIN, DATABASE_PURPOSES, DB_ENGINE_CODES, DB_PORTS, DB_VERSIONS, HARDWARE_VENDORS, INFRASTRUCTURE_AREA,
  LINUX_VERSIONS, SERVER_ROLE_MIX, SITES, WINDOWS_VERSIONS, slug,
} from './names.js'
import { DEMO_RATIOS, type DemoCounts } from './options.js'
import type { PeoplePlan, PlannedTeam } from './people.js'

export type CILabel =
  | 'BusinessApplication' | 'Application' | 'BusinessCapability' | 'Server' | 'DatabaseInstance' | 'Database' | 'Certificate'

export type Environment = 'production' | 'staging' | 'development' | 'testing' | 'dr'
export const ENVIRONMENT_MIX: ReadonlyArray<readonly [Environment, number]> = [
  ['production', 55], ['staging', 15], ['development', 12], ['testing', 12], ['dr', 6],
]

export interface PlannedCI {
  id: string
  label: CILabel
  name: string
  status: string
  environment: Environment
  description: string
  /** Type fields, already under the snake_case key the app stores them with. */
  fields: Record<string, string>
  createdAtMs: number
  updatedAtMs: number
  ownerTeamId: string | null
  supportTeamId: string | null
  /** Filled by the plan for the lookups below (not written). */
  site?: string
  /** Servers: what the server is for (`SERVER_ROLE_MIX`); not written. */
  role?: string
}

export type CIRelationType = 'REALIZES' | 'ENABLED_BY' | 'PARENT_OF' | 'HOSTED_ON' | 'DEPENDS_ON' | 'INSTALLED_ON' | 'USES_CERTIFICATE'

export interface PlannedCIRelation {
  fromId: string
  type: CIRelationType
  toId: string
}

/** The prefix every CI name carries, by kind (the owner's convention). */
export const CI_NAME_PREFIX: Readonly<Record<CILabel, string>> = {
  BusinessApplication: 'BA_', Application: 'APP_', BusinessCapability: 'BC_',
  Server: 'SRV_', DatabaseInstance: 'DBINS_', Database: 'DB_', Certificate: 'CER_',
}

export interface CMDBPlan {
  cis: PlannedCI[]
  relations: PlannedCIRelation[]
  byId: Map<string, PlannedCI>
  /** For the tickets: the CIs of each kind, and what an application stands on. */
  byLabel: Record<CILabel, PlannedCI[]>
  appServers: Map<string, string[]>
  appDatabases: Map<string, string[]>
  databaseInstance: Map<string, string>
  instanceServers: Map<string, string[]>
}

/**
 * The edges the metamodel declares for these types (seed-metamodel.ts and
 * migration 20261007_1020): [source label, type, target label].
 */
export const DECLARED_EDGES: ReadonlyArray<readonly [CILabel, CIRelationType, CILabel]> = [
  ['BusinessApplication', 'REALIZES', 'Application'],
  ['BusinessCapability', 'ENABLED_BY', 'BusinessApplication'],
  ['BusinessCapability', 'PARENT_OF', 'BusinessCapability'],
  ['Application', 'HOSTED_ON', 'Server'],
  ['Application', 'DEPENDS_ON', 'Database'],
  ['Database', 'DEPENDS_ON', 'DatabaseInstance'],
  ['DatabaseInstance', 'HOSTED_ON', 'Server'],
  ['Certificate', 'INSTALLED_ON', 'Server'],
  ['Certificate', 'INSTALLED_ON', 'DatabaseInstance'],
  ['Application', 'USES_CERTIFICATE', 'Certificate'],
  ['Database', 'USES_CERTIFICATE', 'Certificate'],
]

/** 75% active; the rest spread over the other lifecycle states of the `ci_status` vocabulary. */
function statusOf(rng: Rng, label: CILabel): string {
  if (rng.chance(DEMO_RATIOS.activeCIs)) return 'active'
  if (label === 'Certificate') return rng.weighted([['expired', 45], ['revoked', 15], ['inactive', 20], ['decommissioned', 20]])
  return rng.weighted([['maintenance', 30], ['inactive', 35], ['decommissioned', 35]])
}

const ENV_CODE: Record<Environment, string> = { production: 'prd', staging: 'stg', development: 'dev', testing: 'tst', dr: 'dr' }

/** A running CI (it can host or be used by an active one). */
function isRunning(ci: PlannedCI): boolean {
  return ci.status === 'active' || ci.status === 'maintenance'
}

/** Appends to the list under `key` (a spread per item would be quadratic on 15,000 servers). */
function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

/**
 * THE SERVERS THINGS STAND ON, USED BEFORE THEY ARE REUSED (D7, tour of 23
 * Sep 2026). Each group of servers (application servers, database servers)
 * of an environment is walked in a shuffled order: every server hosts
 * something before any hosts two things. A running CI stands on running
 * servers; one that is not running on servers retired with it, if its
 * environment has any.
 */
class HostPool {
  private readonly lists = new Map<string, { items: PlannedCI[]; next: number }>()

  constructor(private readonly rng: Rng, private readonly servers: readonly PlannedCI[]) {}

  private list(key: string, keep: (s: PlannedCI) => boolean): { items: PlannedCI[]; next: number } {
    let l = this.lists.get(key)
    if (!l) {
      l = { items: this.rng.shuffle(this.servers.filter(keep)), next: 0 }
      this.lists.set(key, l)
    }
    return l
  }

  take(group: 'app' | 'db', env: Environment, running: boolean, count: number): PlannedCI[] {
    const inGroup = (s: PlannedCI): boolean => SERVER_ROLE_MIX.find(([role]) => role === s.role)?.[2] === group
    const candidates = [
      this.list(`${group}|${env}|${String(running)}`, (s) => inGroup(s) && s.environment === env && isRunning(s) === running),
      ...(running ? [] : [this.list(`${group}|${env}|any`, (s) => inGroup(s) && s.environment === env)]),
      this.list(`${group}|any|${String(running)}`, (s) => inGroup(s) && (!running || isRunning(s))),
      this.list(`any|${String(running)}`, (s) => !running || isRunning(s)),
    ]
    const l = candidates.find((c) => c.items.length > 0)
    if (!l) throw new Error('planCMDB: there is no server to host on')
    const out = new Map<string, PlannedCI>()
    for (let i = 0; out.size < Math.min(count, l.items.length) && i < l.items.length * 2; i++) {
      const s = l.items[l.next % l.items.length]!
      l.next += 1
      out.set(s.id, s)
    }
    return [...out.values()]
  }
}

/** How many servers an application stands on: a web tier, an application tier, the batch — two to two dozen. */
const APP_HOSTS: ReadonlyArray<readonly [number, number]> = [[2, 15], [3, 18], [4, 15], [6, 17], [8, 14], [12, 12], [16, 6], [24, 3]]

/**
 * WHO OWNS THE INFRASTRUCTURE (D75): a server or an instance belongs to the
 * owner of an application standing on it — a domain controller went to
 * «Retail Banking Solutions» at random — and what no application claims to
 * the infrastructure's own teams, by what it is for.
 */
function assignInfrastructureOwners(
  rng: Rng, people: PeoplePlan, byLabel: Record<CILabel, PlannedCI[]>, byId: Map<string, PlannedCI>, relations: readonly PlannedCIRelation[],
  appServers: Map<string, string[]>, instanceServers: Map<string, string[]>, appDatabases: Map<string, string[]>, databaseInstance: Map<string, string>,
): void {
  const infra = people.teams.filter((t) => t.type === 'owner' && t.area === INFRASTRUCTURE_AREA)
  const infraFor = (unit: string): string | null => (infra.find((t) => t.unit === unit) ?? infra[0])?.id ?? null
  const anyOwner = (): string => rng.pick(people.teams.filter((t) => t.type === 'owner')).id
  // An instance: the owner of the first application using one of its databases.
  const instanceOwner = new Map<string, string>()
  for (const [appId, dbs] of appDatabases) {
    for (const db of dbs) {
      const inst = databaseInstance.get(db)
      const owner = byId.get(appId)!.ownerTeamId
      if (inst && owner && !instanceOwner.has(inst)) instanceOwner.set(inst, owner)
    }
  }
  for (const inst of byLabel.DatabaseInstance) inst.ownerTeamId = instanceOwner.get(inst.id) ?? infraFor('Data Centre') ?? anyOwner()
  // A server: the owner of an application on it, else of an instance on it, else the infrastructure by role.
  const serverOwner = new Map<string, string>()
  for (const [appId, hosts] of appServers) for (const h of hosts) if (!serverOwner.has(h)) serverOwner.set(h, byId.get(appId)!.ownerTeamId!)
  for (const [instId, hosts] of instanceServers) for (const h of hosts) if (!serverOwner.has(h)) serverOwner.set(h, byId.get(instId)!.ownerTeamId!)
  for (const srv of byLabel.Server) {
    const unit = srv.role === 'ad' || srv.role === 'jmp' ? 'Identity and Directory'
      : srv.role === 'lb' ? 'Network and Security'
      : srv.site?.startsWith('aws') || srv.site?.startsWith('azr') ? 'Cloud Platform' : 'Data Centre'
    srv.ownerTeamId = serverOwner.get(srv.id) ?? infraFor(unit) ?? anyOwner()
  }
  // A certificate belongs to the owner of what it secures.
  const securedBy = new Map<string, string>()
  for (const rel of relations) {
    if (rel.type === 'USES_CERTIFICATE') securedBy.set(rel.toId, rel.fromId)
    else if (rel.type === 'INSTALLED_ON' && !securedBy.has(rel.fromId)) securedBy.set(rel.fromId, rel.toId)
  }
  for (const cert of byLabel.Certificate) {
    if (!cert.ownerTeamId) cert.ownerTeamId = byId.get(securedBy.get(cert.id) ?? '')?.ownerTeamId ?? infraFor('Network and Security') ?? anyOwner()
  }
}

type CapabilityNode = { name: string; level: 1 | 2 | 3; parent: string | null }

/**
 * The capabilities, as many as asked: the 12 of level 1 and their 72 of
 * level 2 first, then level 3 drawn among the aspects of each level 2. The
 * tree has names for `CAPABILITY_CAPACITY` of them: asking for more stops
 * the plan, as every other name pool does — never a silent cut.
 */
function capabilityNodes(rng: Rng, count: number): CapabilityNode[] {
  if (count > CAPABILITY_CAPACITY) throw new Error(`planCMDB: ${String(count)} capabilities asked, the capability tree has names for ${String(CAPABILITY_CAPACITY)}`)
  const upper: CapabilityNode[] = CAPABILITY_TREE.flatMap(([l1, children]) => [
    { name: l1, level: 1 as const, parent: null }, ...children.map((l2) => ({ name: l2, level: 2 as const, parent: l1 })),
  ])
  const level3 = upper.filter((x) => x.level === 2).flatMap((n) => CAPABILITY_ASPECTS.map((a) => ({ name: `${n.name} ${a}`, level: 3 as const, parent: n.name })))
  return [...upper, ...rng.sample(level3, Math.max(0, count - upper.length))].slice(0, count)
}

/**
 * The instance a database stands on (there is at least one): one of its own
 * environment when there is one, else any; a running database only on a
 * running instance (the rule of `HostPool` for the servers) — with none
 * running at all, the plan stops.
 */
function instanceFor(rng: Rng, instances: readonly PlannedCI[], byEnv: ReadonlyMap<Environment, PlannedCI[]>, env: Environment, running: boolean): PlannedCI {
  const ofEnv = byEnv.get(env) ?? instances
  const pool = !running ? ofEnv : ofEnv.some(isRunning) ? ofEnv.filter(isRunning) : instances.filter(isRunning)
  if (!pool.length) throw new Error('planCMDB: there is no running database instance to host a running database on')
  return rng.pick(pool)
}

class NameRegistry {
  private readonly used = new Set<string>()
  take(name: string): boolean {
    const key = name.toLowerCase()
    if (this.used.has(key)) return false
    this.used.add(key)
    return true
  }
}

export function planCMDB(rng: Rng, clock: DemoClock, counts: DemoCounts, people: PeoplePlan): CMDBPlan {
  const r = {
    names: rng.fork('names'), status: rng.fork('status'), env: rng.fork('env'), links: rng.fork('links'),
    teams: rng.fork('teams'), fields: rng.fork('fields'), time: rng.fork('time'), ids: rng.fork('ids'),
  }
  const names = new NameRegistry()
  const cis: PlannedCI[] = []
  const relations: PlannedCIRelation[] = []
  const byId = new Map<string, PlannedCI>()
  const byLabel: Record<CILabel, PlannedCI[]> = {
    BusinessApplication: [], Application: [], BusinessCapability: [], Server: [], DatabaseInstance: [], Database: [], Certificate: [],
  }
  const add = (ci: PlannedCI): PlannedCI => {
    cis.push(ci); byId.set(ci.id, ci); byLabel[ci.label].push(ci)
    return ci
  }
  const relate = (fromId: string, type: CIRelationType, toId: string): void => { relations.push({ fromId, type, toId }) }

  // ── Teams by competence ────────────────────────────────────────────────────
  const ownerTeams = people.teams.filter((t) => t.type === 'owner')
  const supportTeams = people.teams.filter((t) => t.type === 'support' && !t.isChangeManager)
  const supportFor = (towers: readonly string[]): PlannedTeam => {
    const fit = supportTeams.filter((t) => towers.includes(t.area))
    return r.teams.pick(fit.length ? fit : supportTeams)
  }
  const anyOwner = (): PlannedTeam => r.teams.pick(ownerTeams)

  // Creation times: the CMDB is loaded in the first quarter, then grows.
  const early = (): number => clock.workInstant(r.time, clock.startMs + 2 * DAY, clock.startMs + 90 * DAY)
  const createdAt = (earlyShare: number): number =>
    r.time.chance(earlyShare) ? early() : clock.workInstant(r.time, clock.startMs + 90 * DAY, clock.nowMs - 2 * DAY)
  const updatedAfter = (createdMs: number): number =>
    r.time.chance(0.6) ? createdMs : clock.between(r.time, createdMs, clock.nowMs)
  const staffNames = people.users.filter((x) => x.role !== 'end_user').map((u) => u.name)

  // ── Business applications ──────────────────────────────────────────────────
  const baSubjectOf = new Map<string, string>()
  for (let i = 0; i < counts.businessApplications; i++) {
    let name = ''
    for (let attempt = 0; attempt < 200 && !name; attempt++) {
      const candidate = `${r.names.pick(BA_QUALIFIERS)} ${r.names.pick(BA_SUBJECTS)} ${r.names.pick(BA_KINDS)}`
      if (names.take(candidate)) name = candidate
    }
    if (!name) throw new Error('planCMDB: the business application name pools are exhausted')
    const subject = name.split(' ').slice(1, -1).join(' ')
    const owner = anyOwner()
    const created = createdAt(0.85)
    const ci = add({
      id: r.ids.uuid(), label: 'BusinessApplication', name, status: statusOf(r.status, 'BusinessApplication'),
      environment: 'production',
      description: `${name}: business application of the ${owner.area} area.`,
      fields: {
        business_owner: r.names.pick(staffNames),
        criticality: r.fields.weighted([['mission_critical', 15], ['business_critical', 35], ['business_operational', 35], ['office_productivity', 15]]),
        business_unit: r.fields.pick(BUSINESS_UNITS),
        cost_center: `CC-${String(r.fields.int(100, 990))}`,
        user_base: r.fields.pick(['~50 users', '~250 users', '~1,000 users', '~5,000 users', '~20,000 users', 'External customers']),
      },
      createdAtMs: created, updatedAtMs: updatedAfter(created),
      ownerTeamId: owner.id, supportTeamId: supportFor(['Application Support']).id,
    })
    baSubjectOf.set(ci.id, subject)
  }

  // ── Capabilities: 12 level-1, 72 level-2, the rest level-3 ─────────────────
  const capabilities = capabilityNodes(r.names, counts.capabilities)
  const capIdByName = new Map<string, string>()
  const bas = byLabel.BusinessApplication
  // Each is enabled by business applications (the owner's shape): with none, there is nothing to enable one.
  if (capabilities.length && !bas.length) throw new Error('planCMDB: capabilities are enabled by business applications, and there is none')
  for (const n of capabilities) {
    if (!names.take(n.name)) throw new Error(`planCMDB: capability name "${n.name}" is already used`)
    // Enabled by 1-5 business applications (random, as the owner asked), which exist before it.
    const enablers = r.links.sample(bas, r.links.int(1, Math.min(5, bas.length)))
    const created = Math.min(Math.max(createdAt(0.9), ...enablers.map((b) => b.createdAtMs + DAY)), clock.nowMs - DAY)
    const ci = add({
      id: r.ids.uuid(), label: 'BusinessCapability', name: n.name, status: statusOf(r.status, 'BusinessCapability'),
      environment: 'production',
      description: `${n.name}: level ${String(n.level)} business capability.`,
      fields: {
        capability_owner: r.names.pick(staffNames),
        hierarchy_level: `level_${String(n.level)}`,
        strategic_priority: r.fields.weighted([['core', 40], ['differentiating', 25], ['supporting', 35]]),
        maturity: r.fields.weighted([['initial', 10], ['developing', 20], ['defined', 30], ['managed', 28], ['optimized', 12]]),
      },
      createdAtMs: created, updatedAtMs: updatedAfter(created),
      // D48: every capability has its owner — the one of a business application that enables it.
      ownerTeamId: enablers[0]!.ownerTeamId, supportTeamId: null,
    })
    capIdByName.set(n.name, ci.id)
    if (n.parent) relate(capIdByName.get(n.parent)!, 'PARENT_OF', ci.id)
    for (const ba of enablers) relate(ci.id, 'ENABLED_BY', ba.id)
  }

  // ── Servers ────────────────────────────────────────────────────────────────
  const hostCounters = new Map<string, number>()
  for (let i = 0; i < counts.servers; i++) {
    const [siteCode, location] = r.names.pick(SITES)
    const env = r.env.weighted(ENVIRONMENT_MIX)
    const role = r.names.weighted(SERVER_ROLE_MIX.map(([x, weight]) => [x, weight] as const))
    const key = `${siteCode}-${ENV_CODE[env]}-${role}`
    const n = (hostCounters.get(key) ?? 0) + 1
    hostCounters.set(key, n)
    const name = `${key}${String(n).padStart(3, '0')}`
    if (!names.take(name)) throw new Error(`planCMDB: server name "${name}" is already used`)
    const linux = r.fields.chance(0.72)
    const cloud = siteCode.startsWith('aws') || siteCode.startsWith('azr')
    const vendor = cloud ? (siteCode.startsWith('aws') ? 'Amazon Web Services' : 'Microsoft Azure') : r.fields.pick(HARDWARE_VENDORS.slice(0, 6))
    const created = createdAt(0.6)
    add({
      id: r.ids.uuid(), label: 'Server', name, status: statusOf(r.status, 'Server'), environment: env,
      description: `${linux ? 'Linux' : 'Windows'} ${role} server in ${location} (${env}).`,
      fields: {
        ip_address: `10.${String(r.fields.int(0, 255))}.${String(r.fields.int(0, 255))}.${String(r.fields.int(1, 254))}`,
        location, vendor,
        os: linux ? 'Linux' : 'Windows',
        version: linux ? r.fields.pick(LINUX_VERSIONS) : r.fields.pick(WINDOWS_VERSIONS),
      },
      createdAtMs: created, updatedAtMs: updatedAfter(created),
      // Owned by what stands on it: set once the applications are planned (D75).
      ownerTeamId: null,
      supportTeamId: supportFor(linux
        ? ['Linux Operations', 'Virtualization', 'Cloud Operations', 'Kubernetes Platform']
        : ['Windows Server Operations', 'Virtualization', 'Cloud Operations']).id,
      site: siteCode, role,
    })
  }
  const hostPool = new HostPool(r.links, byLabel.Server)

  // ── Database instances ─────────────────────────────────────────────────────
  const instanceCounters = new Map<string, number>()
  const instanceServers = new Map<string, string[]>()
  for (let i = 0; i < counts.databaseInstances; i++) {
    const engine = r.fields.weighted([['Oracle', 35], ['PostgreSQL', 40], ['SQL Server', 25]])
    const env = r.env.weighted(ENVIRONMENT_MIX)
    const area = slug(r.names.pick(BA_SUBJECTS)).slice(0, 12)
    const key = `${DB_ENGINE_CODES[engine]!}-${ENV_CODE[env]}-${area}`
    const n = (instanceCounters.get(key) ?? 0) + 1
    instanceCounters.set(key, n)
    const name = `${key}-${String(n).padStart(2, '0')}`
    if (!names.take(name)) throw new Error(`planCMDB: instance name "${name}" is already used`)
    const status = statusOf(r.status, 'DatabaseInstance')
    const hosts = hostPool.take('db', env, isRunning({ status } as PlannedCI), r.links.weighted([[1, 70], [2, 25], [3, 5]]))
    const created = Math.max(createdAt(0.6), ...hosts.map((h) => h.createdAtMs + DAY))
    const ci = add({
      id: r.ids.uuid(), label: 'DatabaseInstance', name, status, environment: env,
      description: `${engine} instance ${name} (${env}).`,
      fields: {
        ip_address: hosts[0]!.fields['ip_address']!,
        port: DB_PORTS[engine]!, instance_type: engine, version: r.fields.pick(DB_VERSIONS[engine]!),
      },
      createdAtMs: Math.min(created, clock.nowMs - DAY), updatedAtMs: 0,
      // Owned by the applications that use its databases: set at the end (D75).
      ownerTeamId: null,
      supportTeamId: supportFor([engine === 'Oracle' ? 'Oracle DBA' : engine === 'PostgreSQL' ? 'PostgreSQL DBA' : 'SQL Server DBA']).id,
    })
    ci.updatedAtMs = updatedAfter(ci.createdAtMs)
    for (const h of hosts) relate(ci.id, 'HOSTED_ON', h.id)
    instanceServers.set(ci.id, hosts.map((h) => h.id))
  }
  const instances = byLabel.DatabaseInstance

  // ── Applications: each realizes at least one business application ──────────
  const appServers = new Map<string, string[]>()
  // How many applications already carry each first word: a family of five.
  const family = new Map<string, number>()
  const baIdsForApps: string[] = []
  // Every business application is realized by at least one application, then the rest at random.
  for (const ba of r.links.shuffle(bas)) baIdsForApps.push(ba.id)
  while (baIdsForApps.length < counts.applications && bas.length) baIdsForApps.push(r.links.pick(bas).id)
  for (let i = 0; i < counts.applications; i++) {
    const primary = byId.get(baIdsForApps[i]!)!
    const base = primary.name.split(' ').slice(0, -1).join(' ')
    // The few applications named after their business application start from
    // the SUBJECT ("Payments Web Frontend"), not from the qualifier: a
    // qualifier is one of fifteen words, and starting there put nineteen rows
    // that begin with "Customer" one under the other in a sorted list.
    const subject = primary.name.split(' ').slice(1, -1).join(' ')
    let name = ''
    let component = ''
    let stem = ''
    const shuffled = r.names.shuffle(APPLICATION_COMPONENTS)
    // Two thirds carry a CODE NAME of their own ("Kestrel API"), the rest are
    // called after the business they serve ("Retail Billing Web Frontend"):
    // that is what an estate looks like, and it is also what keeps the list
    // readable when somebody sorts it by name.
    // A code name belongs to a family of at most five applications: more than
    // that and a list sorted by name shows a page of rows that start the same.
    const freeCodeNames = r.names.shuffle(APPLICATION_CODE_NAMES).filter((n) => (family.get(n) ?? 0) < 5)
    const named = [subject, base, primary.name]
    const freeNamed = named.filter((n) => n !== '' && (family.get(n) ?? 0) < 5)
    // The last two are the way out when every family is full: a name must be
    // found, and a rare sixth member is better than a run that cannot finish.
    const prefixes = r.names.chance(0.9)
      ? [...freeCodeNames, ...freeNamed, ...named]
      : [...freeNamed, ...freeCodeNames, ...named]
    for (const prefix of prefixes) {
      for (const c of shuffled) {
        if (names.take(`${prefix} ${c}`)) { name = `${prefix} ${c}`; component = c; stem = prefix; break }
      }
      if (name) break
    }
    family.set(stem, (family.get(stem) ?? 0) + 1)
    if (!name) throw new Error(`planCMDB: no free application name for "${primary.name}"`)
    const env = r.env.weighted(ENVIRONMENT_MIX)
    const status = statusOf(r.status, 'Application')
    const hosts = hostPool.take('app', env, isRunning({ status } as PlannedCI), r.links.weighted(APP_HOSTS))
    const realized = [primary, ...(r.links.chance(0.15) ? r.links.sample(bas.filter((b) => b.id !== primary.id), 1) : [])]
    const created = Math.max(createdAt(0.7), ...hosts.map((h) => h.createdAtMs + DAY), ...realized.map((b) => b.createdAtMs + DAY))
    const ci = add({
      id: r.ids.uuid(), label: 'Application', name, status, environment: env,
      description: `${name}: part of ${primary.name} (${env}).`,
      fields: {
        // The validation script of the type: http(s), and https in production.
        url: `${env === 'production' || r.fields.chance(0.8) ? 'https' : 'http'}://${slug(component)}.${slug(stem)}${env === 'production' ? '' : `.${ENV_CODE[env]}`}.${CERTIFICATE_DOMAIN}`,
      },
      createdAtMs: Math.min(created, clock.nowMs - DAY), updatedAtMs: 0,
      // The owner of an application is the owner of its business application.
      ownerTeamId: primary.ownerTeamId,
      supportTeamId: supportFor(['Application Support', 'Middleware', 'Web Hosting', 'Integration Services', 'API Management']).id,
    })
    ci.updatedAtMs = updatedAfter(ci.createdAtMs)
    for (const b of realized) relate(b.id, 'REALIZES', ci.id)
    for (const h of hosts) relate(ci.id, 'HOSTED_ON', h.id)
    appServers.set(ci.id, hosts.map((h) => h.id))
  }
  const apps = byLabel.Application

  // ── Databases: on one instance, used by 1-3 applications of the same environment ──
  const appDatabases = new Map<string, string[]>()
  const databaseInstance = new Map<string, string>()
  const appsByEnv = new Map<Environment, PlannedCI[]>()
  for (const a of apps) push(appsByEnv, a.environment, a)
  const instancesByEnv = new Map<Environment, PlannedCI[]>()
  for (const d of instances) push(instancesByEnv, d.environment, d)
  // A database stands on an instance and is used by applications: without them it would have neither.
  if (counts.databases > 0 && (!instances.length || !apps.length)) throw new Error('planCMDB: databases need a database instance to stand on and applications to use them')
  for (let i = 0; i < counts.databases; i++) {
    const env = r.env.weighted(ENVIRONMENT_MIX)
    const status = statusOf(r.status, 'Database')
    const running = isRunning({ status } as PlannedCI)
    const instance = instanceFor(r.links, instances, instancesByEnv, env, running)
    const appPool = appsByEnv.get(instance.environment) ?? apps
    const users = r.links.sample(appPool, r.links.weighted([[1, 70], [2, 22], [3, 8]]))
    const owner = users[0]!
    const baseSlug = slug(owner.name, '_').slice(0, 30)
    let name = ''
    for (const purpose of r.names.shuffle(DATABASE_PURPOSES)) {
      const candidate = `${baseSlug}_${purpose}`
      if (names.take(candidate)) { name = candidate; break }
    }
    if (!name) {
      for (let n = 2; n < 50 && !name; n++) if (names.take(`${baseSlug}_db${String(n)}`)) name = `${baseSlug}_db${String(n)}`
    }
    if (!name) throw new Error(`planCMDB: no free database name for "${owner.name}"`)
    const engine = instance.fields['instance_type']!
    const created = Math.max(createdAt(0.6), instance.createdAtMs + DAY)
    const ci = add({
      id: r.ids.uuid(), label: 'Database', name, status, environment: instance.environment,
      description: `${engine} database of ${owner.name}.`,
      fields: { port: DB_PORTS[engine]!, instance_type: engine },
      createdAtMs: Math.min(created, clock.nowMs - DAY), updatedAtMs: 0,
      ownerTeamId: owner.ownerTeamId,
      supportTeamId: byId.get(instance.id)!.supportTeamId,
    })
    ci.updatedAtMs = updatedAfter(ci.createdAtMs)
    relate(ci.id, 'DEPENDS_ON', instance.id)
    databaseInstance.set(ci.id, instance.id)
    for (const a of users) {
      relate(a.id, 'DEPENDS_ON', ci.id)
      push(appDatabases, a.id, ci.id)
      // An application cannot depend on a database created after it: it is created later.
      if (a.createdAtMs < ci.createdAtMs) a.createdAtMs = Math.min(ci.createdAtMs + DAY, clock.nowMs - DAY)
      if (a.updatedAtMs < a.createdAtMs) a.updatedAtMs = a.createdAtMs
    }
  }

  // ── Certificates ───────────────────────────────────────────────────────────
  const databases = byLabel.Database
  for (let i = 0; i < counts.certificates; i++) {
    const target = r.links.weighted<CILabel>([
      ['Application', apps.length ? 45 : 0], ['Server', 20], ['DatabaseInstance', instances.length ? 20 : 0], ['Database', databases.length ? 15 : 0],
    ])
    const on = r.links.pick(byLabel[target])
    const host = target === 'Server' ? `${on.name}.infra.${CERTIFICATE_DOMAIN}`
      : target === 'Application' ? (on.fields['url'] ?? '').replace(/^https?:\/\//, '').split('/')[0]!
      : `${on.name.replace(/_/g, '-')}.db.${CERTIFICATE_DOMAIN}`
    const status = statusOf(r.status, 'Certificate')
    const created = Math.max(createdAt(0.4), on.createdAtMs + DAY)
    const createdMs = Math.min(created, clock.nowMs - DAY)
    // D39: a renewed certificate has the same common name — the CI is told
    // apart by the year it was issued, not by an invented «(renewal)».
    const issued = String(new Date(createdMs).getUTCFullYear())
    let name = ''
    for (const candidate of [host, `*.${host.split('.').slice(1).join('.')}`, `${host} (${issued})`]) {
      if (candidate && names.take(candidate)) { name = candidate; break }
    }
    for (let n = 2; !name && n < 100; n++) if (names.take(`${host} (${issued}-${String(n)})`)) name = `${host} (${issued}-${String(n)})`
    if (!name) throw new Error(`planCMDB: no free certificate name for "${host}"`)
    // Validity: one or two years from issue. Expired ones have a past date;
    // the others are valid today (the app requires a future date on create).
    const validity = r.fields.pick([365, 397, 730]) * DAY
    let expires = createdMs + validity
    if (status === 'expired') expires = Math.min(expires, clock.nowMs - r.fields.int(1, 200) * DAY)
    else if (expires <= clock.nowMs) expires = clock.nowMs + r.fields.int(5, 360) * DAY
    const ci = add({
      id: r.ids.uuid(), label: 'Certificate', name, status, environment: on.environment,
      description: `TLS certificate for ${host}.`,
      fields: {
        serial_number: Array.from({ length: 16 }, () => r.fields.int(0, 255).toString(16).padStart(2, '0')).join(':').toUpperCase(),
        expires_at: new Date(expires).toISOString(),
        certificate_type: r.fields.weighted([['public', 60], ['external', 40]]),
      },
      createdAtMs: createdMs, updatedAtMs: 0,
      // The owner of what it secures (for a server or an instance: known at the end, see assignInfrastructureOwners).
      ownerTeamId: on.ownerTeamId,
      supportTeamId: supportFor(['PKI & Certificates', 'Security Operations']).id,
    })
    ci.updatedAtMs = updatedAfter(ci.createdAtMs)
    if (target === 'Application') {
      relate(on.id, 'USES_CERTIFICATE', ci.id)
      // The owner's rule: the same certificate is on the servers the application runs on.
      for (const s of appServers.get(on.id) ?? []) relate(ci.id, 'INSTALLED_ON', s)
    } else if (target === 'Server') {
      relate(ci.id, 'INSTALLED_ON', on.id)
    } else if (target === 'DatabaseInstance') {
      relate(ci.id, 'INSTALLED_ON', on.id)
    } else {
      relate(on.id, 'USES_CERTIFICATE', ci.id)
    }
  }

  assignInfrastructureOwners(r.teams, people, byLabel, byId, relations, appServers, instanceServers, appDatabases, databaseInstance)

  /*
   * I PREFISSI PER TIPO, chiesti dal proprietario il 22 set 2026: `APP_`,
   * `SRV_`, `DB_`, `CER_`, `BA_`, `DBINS_`, `BC_`. Si mettono QUI, alla fine,
   * e non mentre si costruisce: il nome grezzo è quello che finisce
   * nell'indirizzo di un'applicazione, nel nome a dominio di un certificato e
   * nel nome del database su cui si connette un'istanza — lì un prefisso da
   * inventario non ci va, e un `SRV_` dentro un hostname sarebbe un difetto.
   * La descrizione che comincia col nome della CI segue il prefisso; il nome
   * delle ALTRE CI citate in prosa («part of Retail Billing Suite») resta
   * quello della cosa, non quello del record.
   */
  for (const ci of cis) {
    const prefixed = `${CI_NAME_PREFIX[ci.label]}${ci.name}`
    if (ci.description.startsWith(`${ci.name}:`)) ci.description = `${prefixed}${ci.description.slice(ci.name.length)}`
    ci.name = prefixed
  }

  return { cis, relations, byId, byLabel, appServers, appDatabases, databaseInstance, instanceServers }
}

/**
 * The business applications a company watches (the monitored services):
 * active ones, with the most PRODUCTION applications they realize. A service
 * map walks production only (D44, services/serviceImpact/build.ts): one
 * picked by all its components, as the generator did until 24 Sep 2026, came
 * out with an empty map when none of its applications was in production — 16
 * of the 30 on that run ("BusinessApplication has no REALIZES").
 */
export function monitoredServiceCandidates(cmdb: CMDBPlan, count: number): PlannedCI[] {
  const productionApps = new Map<string, number>()
  for (const r of cmdb.relations) {
    if (r.type !== 'REALIZES' || cmdb.byId.get(r.toId)?.environment !== 'production') continue
    productionApps.set(r.fromId, (productionApps.get(r.fromId) ?? 0) + 1)
  }
  return cmdb.byLabel.BusinessApplication
    .filter((b) => b.status === 'active' && (productionApps.get(b.id) ?? 0) > 0)
    .map((b) => ({ ba: b, weight: productionApps.get(b.id)! }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, count)
    .map((x) => x.ba)
}
