/**
 * THE CMDB OF THE DEMO TENANT AT ITS EDGES (tour of 23 Sep 2026).
 *
 * peopleAndCmdb.test.ts checks the owner's rules on the full-size tenant
 * (26,800 CIs), where every pool is large and every fallback sleeps. This file
 * builds the small or odd tenants where they wake up — one business
 * application, only retired servers, a single instance, more certificates
 * than names — and pins what the plan does there: the names the owner chose
 * (the prefixes of 22 Sep, D39's renewals), who owns what nobody claims
 * (D75), where a database stands, and the pools that run out, which must stop
 * the plan with a sentence instead of repeating a name (the owner's rule: no
 * silent fallbacks). The defects found on the way (23 Sep 2026) are fixed:
 * each test that found one says what was wrong.
 *
 * Each tenant is planned from a fixed seed; where a test needs the seed to
 * produce a particular situation (the one server retired, an environment with
 * no application), the test states the situation before relying on it.
 */
import { describe, it, expect } from 'vitest'
import { Rng } from '../random.js'
import { DemoClock } from '../clock.js'
import { DEFAULT_DEMO_COUNTS, assertDemoCounts, type DemoCounts } from '../options.js'
import { planPeople, type PeoplePlan } from '../people.js'
import { monitoredServiceCandidates, planCMDB, CI_NAME_PREFIX, type CIRelationType, type CMDBPlan, type PlannedCI } from '../cmdb.js'
import {
  APPLICATION_CODE_NAMES, APPLICATION_COMPONENTS, BA_KINDS, BA_QUALIFIERS, BA_SUBJECTS, CAPABILITY_ASPECTS, CAPABILITY_CAPACITY, CAPABILITY_TREE,
  CERTIFICATE_DOMAIN, DATABASE_PURPOSES, INFRASTRUCTURE_AREA, OWNER_TEAM_UNITS, SERVER_ROLE_MIX, slug,
} from '../names.js'

const NOW = Date.parse('2026-09-23T10:00:00.000Z')
const clock = new DemoClock(NOW, 3, 'Europe/Rome')

/** The people: 400 users, 20 owner teams (the five of the infrastructure first) and 40 support teams. */
const PEOPLE: DemoCounts = { ...DEFAULT_DEMO_COUNTS, users: 400, ownerTeams: 20, supportTeams: 40 }
const people = planPeople(new Rng('cmdb-edges').fork('people'), clock, PEOPLE)

/** No CI at all: each test asks for the kinds it is about. */
const NO_CI: DemoCounts = {
  ...PEOPLE, businessApplications: 0, applications: 0, capabilities: 0, servers: 0, databaseInstances: 0, databases: 0, certificates: 0,
}
const countsOf = (ask: Partial<DemoCounts>): DemoCounts => ({ ...NO_CI, ...ask })
const plan = (seed: string, ask: Partial<DemoCounts>, who: PeoplePlan = people): CMDBPlan => planCMDB(new Rng(seed), clock, countsOf(ask), who)

const running = (ci: PlannedCI): boolean => ci.status === 'active' || ci.status === 'maintenance'
/** A CI's name before the prefix of its kind: what addresses, hosts and database names are made of. */
const raw = (ci: PlannedCI): string => ci.name.slice(CI_NAME_PREFIX[ci.label].length)
const targets = (p: CMDBPlan, fromId: string, type: CIRelationType): PlannedCI[] =>
  p.relations.filter((r) => r.fromId === fromId && r.type === type).map((r) => p.byId.get(r.toId)!)
const sources = (p: CMDBPlan, toId: string, type: CIRelationType): PlannedCI[] =>
  p.relations.filter((r) => r.toId === toId && r.type === type).map((r) => p.byId.get(r.fromId)!)
/** An application is called "<stem> <component>": the component is the one its name ends with. */
const stemOf = (app: PlannedCI): { stem: string; component: string } => {
  const component = APPLICATION_COMPONENTS.find((c) => raw(app).endsWith(` ${c}`))!
  return { stem: raw(app).slice(0, -(component.length + 1)), component }
}
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

describe('the names (22 Sep 2026: a prefix for each kind, the raw name where a prefix would be a defect)', () => {
  const p = plan('names', { businessApplications: 3, applications: 4, capabilities: 5, servers: 30, databaseInstances: 2, databases: 3, certificates: 10 })

  it('every CI carries the prefix of its kind, and a description that opens with the CI follows it', () => {
    for (const ci of p.cis) expect(ci.name.startsWith(CI_NAME_PREFIX[ci.label]), ci.name).toBe(true)
    for (const ci of [...p.byLabel.BusinessApplication, ...p.byLabel.BusinessCapability, ...p.byLabel.Application]) {
      expect(ci.description.startsWith(`${ci.name}: `), ci.description).toBe(true)
    }
  })

  it('the raw name is what goes into an address, a certificate\'s host, a database\'s name and the prose that mentions a CI', () => {
    const businessApplications = p.byLabel.BusinessApplication.map(raw)
    let applicationCertificates = 0
    for (const app of p.byLabel.Application) {
      const { stem, component } = stemOf(app)
      const env = app.environment === 'production' ? '' : '\\.[a-z]+'
      expect(app.fields['url']).toMatch(new RegExp(`^https?://${slug(component)}\\.${slug(stem)}${env}\\.${escape(CERTIFICATE_DOMAIN)}$`))
      // «part of Retail Billing Suite»: the business application as people call it, not its record.
      expect(businessApplications.some((b) => app.description.endsWith(`: part of ${b} (${app.environment}).`)), app.description).toBe(true)
      // Its certificate is for the address it answers on (or the wildcard of that domain), renewals told apart by their year.
      const host = app.fields['url']!.replace(/^https?:\/\//, '')
      for (const cert of targets(p, app.id, 'USES_CERTIFICATE')) {
        expect([host, `*.${host.split('.').slice(1).join('.')}`]).toContain(raw(cert).replace(/ \(\d{4}(-\d+)?\)$/, ''))
        applicationCertificates++
      }
    }
    expect(applicationCertificates).toBeGreaterThan(0)
    for (const db of p.byLabel.Database) {
      const owner = sources(p, db.id, 'DEPENDS_ON')[0]!
      expect(raw(db).startsWith(`${slug(raw(owner), '_').slice(0, 30)}_`), db.name).toBe(true)
      expect(db.description).toContain(` database of ${raw(owner)}.`)
    }
    for (const inst of p.byLabel.DatabaseInstance) expect(inst.description).toContain(` instance ${raw(inst)} (${inst.environment}).`)
    // A host name has no underscore: none of the prefixes got into one.
    for (const cert of p.byLabel.Certificate) expect(raw(cert), cert.name).not.toContain('_')
  })
})

describe('business applications and capabilities', () => {
  it('a business application is named qualifier, subject, kind: 7,500 names, and asking for more stops the plan instead of naming two alike', () => {
    const pool = BA_QUALIFIERS.length * BA_SUBJECTS.length * BA_KINDS.length
    // Five times the owner's 1,500.
    expect(pool).toBe(7500)
    for (const ba of plan('ba-names', { businessApplications: 30 }).byLabel.BusinessApplication) {
      const words = raw(ba).split(' ')
      expect(BA_QUALIFIERS, ba.name).toContain(words[0])
      expect(BA_KINDS, ba.name).toContain(words.at(-1))
      expect(BA_SUBJECTS, ba.name).toContain(words.slice(1, -1).join(' '))
    }
    expect(() => plan('ba-names', { businessApplications: pool + 1 })).toThrow('planCMDB: the business application name pools are exhausted')
  })

  const level2 = CAPABILITY_TREE.reduce((n, [, children]) => n + children.length, 0)
  const wholeTree = CAPABILITY_TREE.length + level2 + level2 * CAPABILITY_ASPECTS.length

  it('the whole capability tree can be planned — 12 level-1, 72 level-2 and every level-3 aspect — each once, under its parent, enabled by business applications', () => {
    expect([CAPABILITY_TREE.length, level2, wholeTree]).toEqual([12, 72, 516])
    const p = plan('whole-tree', { businessApplications: 5, capabilities: wholeTree })
    const capabilities = p.byLabel.BusinessCapability
    expect(new Set(capabilities.map((c) => c.name.toLowerCase())).size).toBe(wholeTree)
    const levels = new Map<string, number>()
    for (const c of capabilities) levels.set(c.fields['hierarchy_level']!, (levels.get(c.fields['hierarchy_level']!) ?? 0) + 1)
    expect(Object.fromEntries(levels)).toEqual({ level_1: 12, level_2: 72, level_3: 432 })
    for (const c of capabilities) {
      const parents = sources(p, c.id, 'PARENT_OF')
      expect(parents, c.name).toHaveLength(c.fields['hierarchy_level'] === 'level_1' ? 0 : 1)
      if (c.fields['hierarchy_level'] === 'level_3') expect(CAPABILITY_ASPECTS.map((a) => `${raw(parents[0]!)} ${a}`)).toContain(raw(c))
      const enablers = targets(p, c.id, 'ENABLED_BY')
      expect(enablers.length, c.name).toBeGreaterThanOrEqual(1)
      expect(enablers.length, c.name).toBeLessThanOrEqual(5)
      // D48: its owner is the owner of a business application that enables it.
      expect(enablers.map((b) => b.ownerTeamId), c.name).toContain(c.ownerTeamId)
    }
  })

  it('asking for more capabilities than the tree holds stops the plan, as every other name pool does', () => {
    // Found by this test (23 Sep 2026), fixed: the level-3 capabilities were
    // `sample(level3, wantL3)`, which gives all 432 when asked for more, and
    // the list was cut at `counts.capabilities`: asking for 517 or 600
    // planned 516, and nothing said so — assertDemoCounts had no ceiling
    // either. The other name pools stop with a sentence when their names run
    // out (names.ts: «a name builder that runs out says so»). Now both do:
    // the counts guard before anything is written, and the plan itself
    // (cmdb.ts, `capabilityNodes`; options.ts). `--scale` is at most 1, 300
    // capabilities: it never gets there.
    expect(CAPABILITY_CAPACITY).toBe(wholeTree)
    const counts = countsOf({ businessApplications: 5, capabilities: wholeTree + 1 })
    expect(() => assertDemoCounts(counts)).toThrow(`Demo tenant: the capability tree has names for ${String(wholeTree)} capabilities, ${String(wholeTree + 1)} asked`)
    expect(() => planCMDB(new Rng('whole-tree'), clock, counts, people))
      .toThrow(`planCMDB: ${String(wholeTree + 1)} capabilities asked, the capability tree has names for ${String(wholeTree)}`)
    expect(() => assertDemoCounts(countsOf({ businessApplications: 5, capabilities: wholeTree }))).not.toThrow()
  })

  it('a capability is enabled by business applications: a tenant with capabilities and no business application is refused', () => {
    // Found by this test (23 Sep 2026), fixed: the owner's shape is
    // «capabilities, each enabled by business applications» (header of
    // cmdb.ts), and verify.ts checks «every capability is enabled by a
    // business application». With no business application planCMDB took
    // `bas.length ? … : []` and planned the capabilities enabled by nothing,
    // owned by a team drawn at random, and assertDemoCounts accepted it: the
    // generator wrote a tenant its own check then rejected. Both refuse it
    // now (cmdb.ts, options.ts).
    const counts = countsOf({ capabilities: 12 })
    expect(() => assertDemoCounts(counts)).toThrow('Demo tenant: capabilities need at least one business application to enable them')
    expect(() => planCMDB(new Rng('capabilities-alone'), clock, counts, people))
      .toThrow('planCMDB: capabilities are enabled by business applications, and there is none')
  })
})

describe('the servers things stand on (D7)', () => {
  it('with no server at all, an instance or an application has nothing to stand on, and the plan stops', () => {
    expect(() => plan('no-server', { databaseInstances: 1 })).toThrow('planCMDB: there is no server to host on')
    expect(() => plan('no-server', { businessApplications: 1, applications: 1 })).toThrow('planCMDB: there is no server to host on')
  })

  it('a running CI never stands on a retired server — with only retired ones the plan stops — while a retired CI stands on them', () => {
    // Seed c35: the tenant's one server is a retired database server. The one
    // instance is running, and no running server is left to put it on.
    const [retired] = plan('c35', { servers: 1 }).byLabel.Server
    expect([retired!.role, running(retired!)]).toEqual(['db', false])
    expect(() => plan('c35', { servers: 1, databaseInstances: 1 })).toThrow('planCMDB: there is no server to host on')
    // Seed c121: the one server and the one instance are both retired, and go together.
    const p = plan('c121', { servers: 1, databaseInstances: 1 })
    const [instance] = p.byLabel.DatabaseInstance
    const [server] = p.byLabel.Server
    expect([running(instance!), running(server!)]).toEqual([false, false])
    expect(targets(p, instance!.id, 'HOSTED_ON')).toEqual([server])
  })
})

describe('applications', () => {
  // Five for each code name; then the three names of the business application
  // (its subject, its name without the kind, its whole name) with each component.
  const capacity = APPLICATION_CODE_NAMES.length * 5 + 3 * APPLICATION_COMPONENTS.length

  it('a code name makes a family of at most five; when every family is full, the business application\'s own names take the rest — a sixth member and more', () => {
    // One business application: every application is named after the same one.
    const p = plan('app-names', { businessApplications: 1, applications: capacity, servers: 30 })
    const family = new Map<string, number>()
    for (const app of p.byLabel.Application) family.set(stemOf(app).stem, (family.get(stemOf(app).stem) ?? 0) + 1)
    for (const code of APPLICATION_CODE_NAMES) expect(family.get(code), code).toBe(5)
    const ba = raw(p.byLabel.BusinessApplication[0]!).split(' ')
    for (const stem of [ba.slice(1, -1).join(' '), ba.slice(0, -1).join(' '), ba.join(' ')]) {
      expect(family.get(stem), stem).toBe(APPLICATION_COMPONENTS.length)
    }
    expect(new Set(p.byLabel.Application.map((a) => a.name.toLowerCase())).size).toBe(capacity)
  })

  it('past the last free name the plan stops instead of naming two applications alike', () => {
    const ba = raw(plan('app-names', { businessApplications: 1 }).byLabel.BusinessApplication[0]!)
    expect(() => plan('app-names', { businessApplications: 1, applications: capacity + 1, servers: 30 }))
      .toThrow(`planCMDB: no free application name for "${ba}"`)
  })
})

describe('databases', () => {
  it('a database is named after the application that owns it and what it holds; past the ten purposes it is numbered, and past _db49 the plan stops', () => {
    const ask = { businessApplications: 1, applications: 1, servers: 10, databaseInstances: 2 }
    const names = DATABASE_PURPOSES.length + 48
    const p = plan('db-names', { ...ask, databases: names })
    const app = p.byLabel.Application[0]!
    const base = slug(raw(app), '_').slice(0, 30)
    expect(p.byLabel.Database.map(raw).sort()).toEqual([
      ...DATABASE_PURPOSES.map((purpose) => `${base}_${purpose}`),
      ...Array.from({ length: 48 }, (_, i) => `${base}_db${String(i + 2)}`),
    ].sort())
    expect(() => plan('db-names', { ...ask, databases: names + 1 })).toThrow(`planCMDB: no free database name for "${raw(app)}"`)
  })

  it('a running database stands on a running instance, even of another environment, and takes the environment of its instance', () => {
    const p = plan('e8', { businessApplications: 2, applications: 3, servers: 60, databaseInstances: 3, databases: 12 })
    // The situation: an environment whose only instances are retired.
    const instances = p.byLabel.DatabaseInstance
    const retiredOnly = [...new Set(instances.map((i) => i.environment))]
      .filter((env) => instances.filter((i) => i.environment === env).every((i) => !running(i)))
    expect(retiredOnly.length).toBeGreaterThan(0)
    expect(instances.some(running)).toBe(true)
    for (const db of p.byLabel.Database) {
      const [instance, ...more] = targets(p, db.id, 'DEPENDS_ON')
      expect(more, db.name).toEqual([])
      expect(db.environment, db.name).toBe(instance!.environment)
      if (running(db)) expect(running(instance!), `${db.name} on ${instance!.name}`).toBe(true)
    }
  })

  it('a database is used by applications of its own environment whenever there are some, and borrows them from another only where there are none (as a server would be)', () => {
    const p = plan('e9', { businessApplications: 2, applications: 3, servers: 60, databaseInstances: 3, databases: 12 })
    const withApplications = new Set(p.byLabel.Application.map((a) => a.environment))
    let borrowed = 0
    for (const db of p.byLabel.Database) {
      const users = sources(p, db.id, 'DEPENDS_ON')
      expect(users.length, db.name).toBeGreaterThanOrEqual(1)
      expect(users.length, db.name).toBeLessThanOrEqual(3)
      if (withApplications.has(db.environment)) for (const u of users) expect(u.environment, `${u.name} → ${db.name}`).toBe(db.environment)
      else borrowed++
    }
    // The situation: some databases stand where no application runs.
    expect(borrowed).toBeGreaterThan(0)
  })

  it('a running database never stands on a retired instance, even when every instance is retired: the plan stops, as it does for a server', () => {
    // Found by this test (23 Sep 2026), fixed: when no instance was running
    // at all, a running database took `instances` — the retired ones — and
    // stood on one. The full-size test pins «a running CI never stands on a
    // retired one», and HostPool stops the plan in the same situation for a
    // server; so does the plan for a database now (cmdb.ts, `instanceFor`).
    // Seed d0: the tenant's one instance is inactive, its databases run.
    const ask = { businessApplications: 1, applications: 2, servers: 30, databaseInstances: 1, databases: 4 }
    expect(() => plan('d0', ask)).toThrow('planCMDB: there is no running database instance to host a running database on')
    // The same tenant without its databases: the one instance is indeed not running.
    expect(plan('d0', { ...ask, databases: 0 }).byLabel.DatabaseInstance.map(running)).toEqual([false])
    // With a running instance, the running databases stand on it.
    const p = plan('d1', { ...ask, databaseInstances: 3 })
    for (const db of p.byLabel.Database.filter(running)) expect(running(targets(p, db.id, 'DEPENDS_ON')[0]!), db.name).toBe(true)
  })

  it('a database needs an application: the counts guard refuses databases without one, and planCMDB called without the guard stops too', () => {
    const ask = { servers: 3, databaseInstances: 1, databases: 1 }
    expect(() => assertDemoCounts(countsOf(ask))).toThrow('databases need at least one database instance and one application')
    // Without the guard it does not invent an owner: it stops, and says why.
    expect(() => plan('no-application', ask)).toThrow('planCMDB: databases need a database instance to stand on and applications to use them')
    // Nor without an instance to stand on.
    expect(() => plan('no-instance', { businessApplications: 1, applications: 1, servers: 3, databases: 1 }))
      .toThrow('planCMDB: databases need a database instance to stand on and applications to use them')
  })
})

describe('certificates', () => {
  // Seed "certs": six certificates on the tenant's one server; after the first two, four renewals — two issued in 2024, two in 2025.
  const p = plan('certs', { servers: 1, certificates: 6 })
  const host = `${raw(p.byLabel.Server[0]!)}.infra.${CERTIFICATE_DOMAIN}`

  it('a certificate secures only what exists: with servers alone, every one is installed on a server', () => {
    for (const cert of p.byLabel.Certificate) {
      expect(targets(p, cert.id, 'INSTALLED_ON'), cert.name).toEqual([p.byLabel.Server[0]])
      expect(sources(p, cert.id, 'USES_CERTIFICATE'), cert.name).toEqual([])
      // D75: it belongs to the owner of what it secures.
      expect(cert.ownerTeamId, cert.name).toBe(p.byLabel.Server[0]!.ownerTeamId)
    }
  })

  it('D39: after the host itself and the wildcard of its domain, a renewal keeps the common name, told apart by the year it was issued', () => {
    const [first, second, ...renewals] = p.byLabel.Certificate
    expect(raw(first!)).toBe(host)
    expect(raw(second!)).toBe(`*.infra.${CERTIFICATE_DOMAIN}`)
    const perYear = new Map<number, number>()
    for (const cert of renewals) {
      const year = new Date(cert.createdAtMs).getUTCFullYear()
      const n = (perYear.get(year) ?? 0) + 1
      perYear.set(year, n)
      expect(raw(cert)).toBe(n === 1 ? `${host} (${String(year)})` : `${host} (${String(year)}-${String(n)})`)
    }
    // The situation: two renewals of the same year, so the second is numbered.
    expect(Math.max(...perYear.values())).toBeGreaterThanOrEqual(2)
  })

  it('more certificates on one host than a name can tell apart stops the plan instead of naming two alike', () => {
    // A host has its own name, the wildcard, and 99 per year of issue ("(2025)",
    // "(2025-2)" … "(2025-99)"); three years up to now span four calendar years.
    expect(() => plan('certs', { servers: 1, certificates: 2 + 4 * 99 + 1 })).toThrow(`planCMDB: no free certificate name for "${host}"`)
  })
})

describe('who owns the infrastructure (D75)', () => {
  const team = new Map(people.teams.map((t) => [t.id, t]))
  /** The owner's rule: by what the server is for. */
  const unitFor = (s: PlannedCI): string => (s.role === 'ad' || s.role === 'jmp' ? 'Identity and Directory'
    : s.role === 'lb' ? 'Network and Security'
      : /^(aws|azr)-/.test(s.site!) ? 'Cloud Platform' : 'Data Centre')
  const ask = { businessApplications: 3, applications: 4, servers: 120, databaseInstances: 4, databases: 3, certificates: 12 }
  // Seed own5 (was own0 until 24 Sep 2026): a running application server now always carries an
  // application, so only a retired load balancer is left for Network and Security to own.
  const p = plan('own5', ask)

  it('what no application claims goes to the infrastructure team of what it is for', () => {
    const claimed = new Set(p.relations.filter((r) => r.type === 'HOSTED_ON').map((r) => r.toId))
    const unclaimed = p.byLabel.Server.filter((s) => !claimed.has(s.id))
    // The situation: unclaimed servers of every kind.
    expect(new Set(unclaimed.map(unitFor))).toEqual(new Set(['Identity and Directory', 'Network and Security', 'Cloud Platform', 'Data Centre']))
    for (const s of unclaimed) expect([team.get(s.ownerTeamId!)!.area, team.get(s.ownerTeamId!)!.unit], s.name).toEqual([INFRASTRUCTURE_AREA, unitFor(s)])
    // An instance no application uses belongs to the Data Centre.
    const used = new Set(p.relations.filter((r) => r.type === 'DEPENDS_ON').map((r) => r.toId))
    const unused = p.byLabel.DatabaseInstance.filter((i) => !used.has(i.id))
    expect(unused.length).toBeGreaterThan(0)
    for (const i of unused) expect(team.get(i.ownerTeamId!)!.unit, i.name).toBe('Data Centre')
  })

  it('a certificate belongs to the owner of what it secures: the application using it, else the server or instance it is on', () => {
    const secured = new Set<string>()
    for (const cert of p.byLabel.Certificate) {
      const by = sources(p, cert.id, 'USES_CERTIFICATE')[0] ?? targets(p, cert.id, 'INSTALLED_ON')[0]!
      secured.add(by.label)
      expect(cert.ownerTeamId, cert.name).toBe(by.ownerTeamId)
    }
    expect(secured).toEqual(new Set(['Application', 'Server', 'DatabaseInstance']))
  })

  /*
   * The owner's rules of 24 Sep 2026: a certificate is used by an application
   * or by a database instance and installed on the servers it runs on, or
   * installed on a server alone — never a database's, never on the instance.
   */
  it('a certificate has one of the owner\'s shapes, never a database\'s', () => {
    for (const cert of p.byLabel.Certificate) {
      const users = sources(p, cert.id, 'USES_CERTIFICATE')
      const hosts = targets(p, cert.id, 'INSTALLED_ON')
      expect(hosts.every((h) => h.label === 'Server'), cert.name).toBe(true)
      expect(users.length, cert.name).toBeLessThanOrEqual(1)
      const user = users[0]
      if (user) {
        // Used: installed on the servers its user runs on, and only there.
        expect(['Application', 'DatabaseInstance'], cert.name).toContain(user.label)
        const servers = (user.label === 'Application' ? p.appServers : p.instanceServers).get(user.id) ?? []
        expect(hosts.map((h) => h.id).sort(), cert.name).toEqual([...servers].sort())
      } else {
        expect(hosts, cert.name).toHaveLength(1)
      }
    }
  })

  /*
   * The infrastructure flag (owner, 24 Sep 2026): backup, monitoring, directory
   * and jump hosts, and the certificates installed only on flagged CIs. Nothing
   * an application uses, and never an instance: «le istanze che nessuna
   * applicazione usa non sono infrastrutturali».
   */
  it('what serves the whole company and no application is flagged as infrastructure, and nothing an application uses is', () => {
    const infraRoles = new Set(SERVER_ROLE_MIX.filter(([, , g]) => g === 'infra').map(([role]) => role))
    for (const s of p.byLabel.Server) expect(s.isInfrastructure === true, s.name).toBe(infraRoles.has(s.role!))
    for (const c of p.byLabel.Certificate) {
      const used = sources(p, c.id, 'USES_CERTIFICATE').length > 0
      const onFlaggedOnly = targets(p, c.id, 'INSTALLED_ON').every((h) => h.isInfrastructure === true)
      expect(c.isInfrastructure === true, c.name).toBe(!used && onFlaggedOnly)
    }
    // Applications, business applications, capabilities, databases and instances never are.
    for (const label of ['Application', 'BusinessApplication', 'BusinessCapability', 'Database', 'DatabaseInstance'] as const) {
      expect(p.byLabel[label].some((x) => x.isInfrastructure), label).toBe(false)
    }
    expect(p.byLabel.Server.some((s) => s.isInfrastructure)).toBe(true)
  })

  /*
   * Only the flag keeps a CI in service out of the application chains (owner,
   * 24 Sep 2026: «server che ospitano solo istanze non sono in una catena
   * valida»). Before, a database drew its instance at random: 586 instances of
   * 2000 hosted none, and the 228 servers under them were in no chain.
   */
  it('every instance in service hosts a database, every running application server an application, and a certificate in service stands on something that runs', () => {
    const q = plan('chains', { businessApplications: 3, applications: 6, servers: 120, databaseInstances: 12, databases: 12, certificates: 40 })
    const inService = q.byLabel.DatabaseInstance.filter(running)
    expect(inService.length).toBeLessThan(12)
    for (const i of inService) expect(sources(q, i.id, 'DEPENDS_ON').length, i.name).toBeGreaterThan(0)
    const appRoles = new Set(SERVER_ROLE_MIX.filter(([, , g]) => g === 'app').map(([role]) => role))
    for (const s of q.byLabel.Server.filter((x) => appRoles.has(x.role!) && running(x))) {
      const apps = sources(q, s.id, 'HOSTED_ON').filter((x) => x.label === 'Application')
      expect(apps.length, s.name).toBeGreaterThan(0)
      // An application stands only on servers created before it.
      for (const a of apps) expect(a.createdAtMs, a.name).toBeGreaterThan(s.createdAtMs)
    }
    for (const c of q.byLabel.Certificate.filter((x) => x.status === 'active')) {
      const on = [...targets(q, c.id, 'INSTALLED_ON'), ...sources(q, c.id, 'USES_CERTIFICATE')]
      expect(on.length && on.every(running), c.name).toBe(true)
    }
  })

  it('with fewer owner teams than infrastructure units, what has no team of its own goes to the first of them, the Data Centre', () => {
    const few = planPeople(new Rng('few-owners'), clock, { ...DEFAULT_DEMO_COUNTS, users: 30, ownerTeams: 3, supportTeams: 2 })
    const units = new Map(few.teams.filter((t) => t.type === 'owner').map((t) => [t.id, t.unit]))
    expect([...units.values()]).toEqual(OWNER_TEAM_UNITS[INFRASTRUCTURE_AREA]!.slice(0, 3))
    // Servers alone: nothing claims them.
    const servers = plan('few0', { servers: 150 }, few).byLabel.Server
    const directory = servers.filter((s) => s.role === 'ad' || s.role === 'jmp')
    expect(directory.length).toBeGreaterThan(0)
    for (const s of directory) expect(units.get(s.ownerTeamId!), s.name).toBe('Data Centre')
    for (const s of servers.filter((x) => unitFor(x) !== 'Identity and Directory')) expect(units.get(s.ownerTeamId!), s.name).toBe(unitFor(s))
  })

  it('a people plan without infrastructure teams (planPeople always makes them) still leaves no CI without an owner: one is drawn among the owner teams', () => {
    const noInfrastructure: PeoplePlan = { ...people, teams: people.teams.filter((t) => t.area !== INFRASTRUCTURE_AREA) }
    const owners = new Set(noInfrastructure.teams.filter((t) => t.type === 'owner').map((t) => t.id))
    expect(owners.size).toBe(15)
    const q = plan('own0', ask, noInfrastructure)
    const claimed = new Set(q.relations.filter((r) => r.type === 'HOSTED_ON').map((r) => r.toId))
    const used = new Set(q.relations.filter((r) => r.type === 'DEPENDS_ON').map((r) => r.toId))
    // The situation: servers and instances nobody claims.
    expect(q.byLabel.Server.some((s) => !claimed.has(s.id))).toBe(true)
    expect(q.byLabel.DatabaseInstance.some((i) => !used.has(i.id))).toBe(true)
    for (const ci of q.cis) expect(owners.has(ci.ownerTeamId!), ci.name).toBe(true)
  })
})

/** The monitored services (24 Sep 2026): 16 of 30 had an empty map, picked by components that were not in production. */
describe('monitoredServiceCandidates', () => {
  const cmdb = plan('monitored', { businessApplications: 120, applications: 300, servers: 200 })
  const productionAppsOf = (baId: string) => cmdb.relations
    .filter((r) => r.fromId === baId && r.type === 'REALIZES' && cmdb.byId.get(r.toId)?.environment === 'production').length

  it('every one realizes at least one production application: its service map is never empty', () => {
    const picked = monitoredServiceCandidates(cmdb, 30)
    expect(picked.length).toBeGreaterThan(0)
    for (const ba of picked) {
      expect(ba.status).toBe('active')
      expect(productionAppsOf(ba.id)).toBeGreaterThan(0)
    }
  })

  it('the ones with the most production applications first, at most the count asked', () => {
    const picked = monitoredServiceCandidates(cmdb, 5)
    expect(picked.length).toBeLessThanOrEqual(5)
    const weights = picked.map((b) => productionAppsOf(b.id))
    expect(weights).toEqual([...weights].sort((a, b) => b - a))
  })
})

/** Tour of 24 Sep 2026 (G34): «Buckthorn Search» on «meadowsweet_notification_servi_config». */
describe('the databases of the applications', () => {
  const p = plan('cmdb-g34', { businessApplications: 25, applications: 80, servers: 60, databaseInstances: 20, databases: 120 })

  it('a database is used only by applications of the same business application as its own', () => {
    let shared = 0
    for (const db of p.byLabel.Database) {
      const users = sources(p, db.id, 'DEPENDS_ON').filter((ci) => ci.label === 'Application')
      expect(users.length, raw(db)).toBeGreaterThan(0)
      if (users.length > 1) shared++
      const basOf = (app: PlannedCI) => new Set(sources(p, app.id, 'REALIZES').map((b) => b.id))
      const common = [...basOf(users[0]!)].filter((ba) => users.every((u) => basOf(u).has(ba)))
      expect(common.length, raw(db)).toBeGreaterThan(0)
    }
    expect(shared).toBeGreaterThan(0)
  })

  it('its name is cut at a whole word of the application, never in the middle of one', () => {
    for (const db of p.byLabel.Database) {
      const name = raw(db)
      const fits = sources(p, db.id, 'DEPENDS_ON').filter((ci) => ci.label === 'Application').some((app) => {
        const words = slug(raw(app), '_').split('_')
        for (let k = words.length; k >= 1; k--) {
          const base = words.slice(0, k).join('_')
          if (base.length > 30 || !name.startsWith(`${base}_`)) continue
          const rest = name.slice(base.length + 1)
          // The longest base of whole words within 30 characters, then the purpose.
          return (k === words.length || words.slice(0, k + 1).join('_').length > 30)
            && ((DATABASE_PURPOSES as readonly string[]).includes(rest) || /^db\d+$/.test(rest))
        }
        return false
      })
      expect(fits, name).toBe(true)
    }
  })
})
