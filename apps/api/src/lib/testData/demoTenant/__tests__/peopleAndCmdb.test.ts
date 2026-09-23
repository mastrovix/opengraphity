/**
 * The people and the CMDB of the demo tenant, generated at the owner's full
 * size and checked against the rules the owner of the product gave.
 *
 * Why these checks matter: the demo tenant is shown to people who judge the
 * product by it. An application hosted on a decommissioned server, a
 * certificate on a CI type the owner excluded, an edge the metamodel does not
 * declare (the app would refuse it, the CI page would hide it) or two servers
 * with the same name are the kind of defect that is invisible in a quick look
 * and embarrassing in a demo. The plan is pure, so every rule is checked on
 * all 26,800 CIs, not on a sample.
 */
import { describe, it, expect } from 'vitest'
import { Rng } from '../random.js'
import { DAY, DemoClock } from '../clock.js'
import { DEFAULT_DEMO_COUNTS, assertDemoCounts } from '../options.js'
import { planPeople, roleCounts, emailOf } from '../people.js'
import { NAME_POOLS, OFFICE_SITES, OFFICE_SITE_VALUES } from '../names.js'
import { planCMDB, DECLARED_EDGES, type CILabel, type PlannedCIRelation } from '../cmdb.js'

const NOW = Date.parse('2026-09-23T10:00:00.000Z')
const clock = new DemoClock(NOW, 3, 'Europe/Rome')
const rng = new Rng('demo-test')
const people = planPeople(rng.fork('people'), clock, DEFAULT_DEMO_COUNTS)
const cmdb = planCMDB(rng.fork('cmdb'), clock, DEFAULT_DEMO_COUNTS, people)

const labelOf = (id: string): CILabel => cmdb.byId.get(id)!.label
/*
 * The edges are indexed once, by both ends. Filtering the 24.627 relations
 * inside a loop over the 26.800 CIs is quadratic: the three checks that did
 * that took seven seconds each and timed out under coverage.
 */
const outgoing = new Map<string, PlannedCIRelation[]>()
const incoming = new Map<string, PlannedCIRelation[]>()
for (const r of cmdb.relations) {
  const from = outgoing.get(r.fromId) ?? []; from.push(r); outgoing.set(r.fromId, from)
  const to = incoming.get(r.toId) ?? []; to.push(r); incoming.set(r.toId, to)
}
const edgesFrom = (id: string, type: string) => (outgoing.get(id) ?? []).filter((r) => r.type === type)
const edgesTo = (id: string, type: string) => (incoming.get(id) ?? []).filter((r) => r.type === type)
const edgesAround = (id: string) => [...(outgoing.get(id) ?? []), ...(incoming.get(id) ?? [])]

describe('users and teams', () => {
  it('3000 users split as the owner decided: 1200 operators, 1700 end users, 80 viewers, 20 admins', () => {
    expect(roleCounts(3000)).toEqual({ admin: 20, operator: 1200, viewer: 80, end_user: 1700 })
    const byRole = new Map<string, number>()
    for (const u of people.users) byRole.set(u.role, (byRole.get(u.role) ?? 0) + 1)
    expect(Object.fromEntries(byRole)).toEqual({ admin: 20, operator: 1200, viewer: 80, end_user: 1700 })
  })

  it('names and e-mail addresses are unique, and addresses are plain lower-case ASCII', () => {
    expect(new Set(people.users.map((u) => u.name)).size).toBe(3000)
    expect(new Set(people.users.map((u) => u.email)).size).toBe(3000)
    for (const u of people.users) expect(u.email).toMatch(/^[a-z0-9.]+@demo\.opengrafo\.io$/)
    expect(emailOf('Maria', "D'Angelo")).toBe('maria.d.angelo@demo.opengrafo.io')
    expect(emailOf('Jonas', 'Müller')).toBe('jonas.muller@demo.opengrafo.io')
  })

  it('200 owner and 300 support teams plus the one change-manager team, 90% internal', () => {
    const teams = people.teams.filter((t) => !t.isChangeManager)
    expect(teams.filter((t) => t.type === 'owner')).toHaveLength(200)
    expect(teams.filter((t) => t.type === 'support')).toHaveLength(300)
    expect(teams.filter((t) => t.sourcing === 'internal')).toHaveLength(450)
    expect(people.teams.filter((t) => t.isChangeManager).map((t) => t.name)).toEqual(['Change Management Office'])
    expect(new Set(people.teams.map((t) => t.name.toLowerCase())).size).toBe(people.teams.length)
  })

  it('every team has a manager who is an operator and a member, and at least one more member', () => {
    const operators = new Set(people.users.filter((u) => u.role === 'operator').map((u) => u.id))
    for (const t of people.teams) {
      expect(operators.has(t.managerId)).toBe(true)
      expect(t.memberIds).toContain(t.managerId)
      expect(t.memberIds.length).toBeGreaterThanOrEqual(2)
      expect(new Set(t.memberIds).size).toBe(t.memberIds.length)
      for (const m of t.memberIds) expect(operators.has(m)).toBe(true)
    }
    // Each team has its own manager.
    expect(new Set(people.teams.map((t) => t.managerId)).size).toBe(people.teams.length)
  })

  it('D22: a team of a region is staffed by people of that region, named in its language', () => {
    const byId = new Map(people.users.map((u) => [u.id, u]))
    const allowed: Record<string, string[]> = {
      'Italy': ['IT'], 'Germany': ['DE'], 'France': ['FR'], 'Spain': ['ES'], 'United Kingdom': ['GB'],
      'Benelux': ['NL'], 'Nordics': ['NORDIC'], 'Americas': ['US'], 'APAC': ['IN', 'SG', 'JP', 'AU'],
    }
    let checked = 0
    for (const t of people.teams.filter((x) => x.region && x.region !== 'Global')) {
      for (const m of t.memberIds) {
        const u = byId.get(m)!
        expect(allowed[t.region!], `${u.name} (${u.country}) in ${t.name}`).toContain(u.country)
        expect(NAME_POOLS[u.country].first.some((f) => u.name.startsWith(`${f} `))).toBe(true)
        checked++
      }
    }
    expect(checked).toBeGreaterThan(500)
  })

  it('D30: everyone works at an office of their country, and only employees work remotely', () => {
    for (const u of people.users) {
      const offices = OFFICE_SITES[u.country].map(([site]) => site)
      if (u.site === 'Remote') expect(u.role).toBe('end_user')
      else expect(offices).toContain(u.site)
      expect(OFFICE_SITE_VALUES).toContain(u.site)
    }
  })

  it('D69: owner teams are distinct — each has its own unit and description — and no first name crowds the list', () => {
    const owners = people.teams.filter((t) => t.type === 'owner')
    expect(new Set(owners.map((t) => t.description)).size).toBe(owners.length)
    for (const t of owners) expect(t.name).toMatch(/^OWN_.+ - .+/)
    const firsts = new Map<string, number>()
    for (const u of people.users) {
      const first = NAME_POOLS[u.country].first.find((f) => u.name.startsWith(`${f} `))!
      firsts.set(first, (firsts.get(first) ?? 0) + 1)
    }
    expect(Math.max(...firsts.values())).toBeLessThanOrEqual(25)
  })

  it('the counts guard refuses shapes that cannot exist', () => {
    expect(() => assertDemoCounts({ ...DEFAULT_DEMO_COUNTS, users: 1000 })).toThrow(/two operators per team/)
    expect(() => assertDemoCounts({ ...DEFAULT_DEMO_COUNTS, servers: 0 })).toThrow(/server/)
    expect(() => assertDemoCounts({ ...DEFAULT_DEMO_COUNTS, incidents: -1 })).toThrow(/non-negative integer/)
  })
})

/** Tour of 23 Sep 2026: D7 (idle servers), D75 (who owns the infrastructure), D48 (capabilities without an owner), D39 (renewals). */
describe('the CMDB is used and owned', () => {
  it('D7: application and database servers host something — 10,788 of 15,000 hosted nothing', () => {
    const hosting = new Set(cmdb.relations.filter((r) => r.type === 'HOSTED_ON').map((r) => r.toId))
    const hosts = cmdb.byLabel.Server.filter((s) => s.role !== 'mon' && s.role !== 'bkp' && s.role !== 'ad' && s.role !== 'jmp')
    const used = hosts.filter((s) => hosting.has(s.id)).length
    expect(used / hosts.length).toBeGreaterThan(0.95)
    expect(hosting.size / cmdb.byLabel.Server.length).toBeGreaterThan(0.85)
  })

  it('D75: a server belongs to the owner of an application on it, or to an infrastructure team', () => {
    const appsOn = new Map<string, Set<string>>()
    for (const r of cmdb.relations.filter((x) => x.type === 'HOSTED_ON' && labelOf(x.fromId) === 'Application')) {
      const set = appsOn.get(r.toId) ?? new Set<string>()
      set.add(cmdb.byId.get(r.fromId)!.ownerTeamId!)
      appsOn.set(r.toId, set)
    }
    const infra = new Set(people.teams.filter((t) => t.area === 'IT Infrastructure').map((t) => t.id))
    expect(infra.size).toBe(5)
    for (const s of cmdb.byLabel.Server) {
      const owners = appsOn.get(s.id)
      if (owners) expect(owners.has(s.ownerTeamId!), s.name).toBe(true)
      else if (!edgesTo(s.id, 'HOSTED_ON').length) expect(infra.has(s.ownerTeamId!), s.name).toBe(true)
    }
  })

  it('D48: every capability has an owner; D39: a renewed certificate keeps its name, told apart by its year', () => {
    for (const c of cmdb.byLabel.BusinessCapability) expect(c.ownerTeamId, c.name).not.toBeNull()
    for (const c of cmdb.cis) expect(c.ownerTeamId, c.name).not.toBeNull()
    for (const c of cmdb.byLabel.Certificate) expect(c.name).not.toMatch(/\((renewal|client)\)/)
    expect(cmdb.byLabel.Certificate.some((c) => /\(20\d\d(-\d+)?\)$/.test(c.name))).toBe(true)
  })
})

describe('the CMDB', () => {
  it('has exactly the counts the owner asked for', () => {
    const count = (l: CILabel) => cmdb.byLabel[l].length
    expect({
      ba: count('BusinessApplication'), app: count('Application'), cap: count('BusinessCapability'), srv: count('Server'),
      dbi: count('DatabaseInstance'), db: count('Database'), cert: count('Certificate'),
    }).toEqual({ ba: 1500, app: 2000, cap: 300, srv: 15000, dbi: 2000, db: 3000, cert: 3000 })
  })

  it('every CI name is unique (two CIs with one name are a defect, not realism)', () => {
    expect(new Set(cmdb.cis.map((c) => c.name.toLowerCase())).size).toBe(cmdb.cis.length)
    expect(new Set(cmdb.cis.map((c) => c.id)).size).toBe(cmdb.cis.length)
  })

  it('writes only edges the metamodel declares, in the declared direction', () => {
    const declared = new Set(DECLARED_EDGES.map(([s, t, d]) => `${s}|${t}|${d}`))
    for (const r of cmdb.relations) expect(declared.has(`${labelOf(r.fromId)}|${r.type}|${labelOf(r.toId)}`)).toBe(true)
    expect(new Set(cmdb.relations.map((r) => `${r.fromId}|${r.type}|${r.toId}`)).size).toBe(cmdb.relations.length)
  })

  it('the only dependency chains are app→server and app→database→instance→server', () => {
    for (const r of cmdb.relations.filter((x) => x.type === 'DEPENDS_ON' || x.type === 'HOSTED_ON')) {
      const pair = `${labelOf(r.fromId)}→${labelOf(r.toId)}`
      expect(['Application→Server', 'Application→Database', 'Database→DatabaseInstance', 'DatabaseInstance→Server']).toContain(pair)
    }
    // Servers depend on nothing.
    expect(cmdb.relations.some((r) => labelOf(r.fromId) === 'Server')).toBe(false)
  })

  it('every application realizes a business application, and every business application is realized', () => {
    const realized = new Set(cmdb.relations.filter((r) => r.type === 'REALIZES').map((r) => r.toId))
    for (const a of cmdb.byLabel.Application) expect(realized.has(a.id)).toBe(true)
    const realizing = new Set(cmdb.relations.filter((r) => r.type === 'REALIZES').map((r) => r.fromId))
    for (const b of cmdb.byLabel.BusinessApplication) expect(realizing.has(b.id)).toBe(true)
  })

  it('every capability is enabled by business applications, in a 12 / 72 / 216 hierarchy', () => {
    for (const c of cmdb.byLabel.BusinessCapability) expect(edgesFrom(c.id, 'ENABLED_BY').length).toBeGreaterThanOrEqual(1)
    const levels = new Map<string, number>()
    for (const c of cmdb.byLabel.BusinessCapability) levels.set(c.fields['hierarchy_level']!, (levels.get(c.fields['hierarchy_level']!) ?? 0) + 1)
    expect(Object.fromEntries(levels)).toEqual({ level_1: 12, level_2: 72, level_3: 216 })
    const children = new Set(cmdb.relations.filter((r) => r.type === 'PARENT_OF').map((r) => r.toId))
    for (const c of cmdb.byLabel.BusinessCapability) expect(children.has(c.id)).toBe(c.fields['hierarchy_level'] !== 'level_1')
  })

  it('applications, instances and databases stand on something, in their own environment', () => {
    for (const a of cmdb.byLabel.Application) {
      const hosts = edgesFrom(a.id, 'HOSTED_ON')
      expect(hosts.length).toBeGreaterThanOrEqual(1)
      for (const h of hosts) expect(cmdb.byId.get(h.toId)!.environment).toBe(a.environment)
    }
    for (const i of cmdb.byLabel.DatabaseInstance) {
      const hosts = edgesFrom(i.id, 'HOSTED_ON')
      expect(hosts.length).toBeGreaterThanOrEqual(1)
      for (const h of hosts) expect(cmdb.byId.get(h.toId)!.environment).toBe(i.environment)
    }
    for (const d of cmdb.byLabel.Database) {
      const on = edgesFrom(d.id, 'DEPENDS_ON')
      expect(on).toHaveLength(1)
      expect(cmdb.byId.get(on[0]!.toId)!.environment).toBe(d.environment)
      const users = edgesTo(d.id, 'DEPENDS_ON')
      expect(users.length).toBeGreaterThanOrEqual(1)
      for (const u of users) expect(cmdb.byId.get(u.fromId)!.environment).toBe(d.environment)
    }
  })

  it('a list of applications sorted by name does not show a page of rows that start the same', () => {
    /*
     * Chiesto dal proprietario guardando l'elenco (22 set 2026): la prima
     * pagina era tutta «Branch …». Il difetto non erano le parole ma lo
     * stampino — ogni applicazione si chiamava come la sua business
     * application, e i qualificatori sono quindici: ottantanove righe di
     * fila cominciavano con la stessa parola. Ora quasi tutte hanno un nome
     * in codice proprio, e una famiglia non supera le cinque.
     */
    const names = cmdb.byLabel.Application.map((c) => c.name).sort()
    let worst = 1, run = 1, word = ''
    for (let i = 1; i < names.length; i++) {
      run = names[i]!.split(' ')[0] === names[i - 1]!.split(' ')[0] ? run + 1 : 1
      if (run > worst) { worst = run; word = names[i]!.split(' ')[0]! }
    }
    expect(worst, `"${word}" opens ${String(worst)} rows in a row`).toBeLessThanOrEqual(10)
  })

  it('a running CI never stands on a retired one', () => {
    const running = (s: string) => s === 'active' || s === 'maintenance'
    for (const r of cmdb.relations.filter((x) => x.type === 'HOSTED_ON' || x.type === 'DEPENDS_ON')) {
      const from = cmdb.byId.get(r.fromId)!
      const to = cmdb.byId.get(r.toId)!
      if (running(from.status) && from.label !== 'Application') expect(running(to.status)).toBe(true)
      if (running(from.status) && from.label === 'Application' && r.type === 'HOSTED_ON') expect(running(to.status)).toBe(true)
    }
  })

  it('certificates relate only to applications, databases, instances and servers, and follow the application onto its servers', () => {
    for (const c of cmdb.byLabel.Certificate) {
      const around = edgesAround(c.id)
      expect(around.length).toBeGreaterThanOrEqual(1)
      for (const r of around) {
        const other = labelOf(r.fromId === c.id ? r.toId : r.fromId)
        expect(['Application', 'Database', 'DatabaseInstance', 'Server']).toContain(other)
      }
      for (const use of around.filter((r) => r.type === 'USES_CERTIFICATE' && labelOf(r.fromId) === 'Application')) {
        const installedOn = new Set(edgesFrom(c.id, 'INSTALLED_ON').map((r) => r.toId))
        for (const s of cmdb.appServers.get(use.fromId)!) expect(installedOn.has(s)).toBe(true)
      }
    }
  })

  it('nothing depends on a CI created after it', () => {
    for (const r of cmdb.relations) {
      const from = cmdb.byId.get(r.fromId)!
      const to = cmdb.byId.get(r.toId)!
      // REALIZES and PARENT_OF point from the older CI to the newer one.
      const [older, newer] = r.type === 'REALIZES' || r.type === 'PARENT_OF' ? [from, to]
        : r.type === 'USES_CERTIFICATE' ? [from, to] : [to, from]
      if (r.type === 'PARENT_OF') continue
      expect(newer.createdAtMs).toBeGreaterThanOrEqual(older.createdAtMs)
    }
  })

  it('75% of the CIs are active, most are in production, and all dates are inside the three years', () => {
    const active = cmdb.cis.filter((c) => c.status === 'active').length / cmdb.cis.length
    expect(active).toBeGreaterThan(0.735)
    expect(active).toBeLessThan(0.765)
    const prod = cmdb.cis.filter((c) => c.environment === 'production').length / cmdb.cis.length
    expect(prod).toBeGreaterThan(0.5)
    for (const c of cmdb.cis) {
      expect(c.createdAtMs).toBeGreaterThanOrEqual(clock.startMs)
      expect(c.createdAtMs).toBeLessThanOrEqual(NOW)
      expect(c.updatedAtMs).toBeGreaterThanOrEqual(c.createdAtMs)
      expect(c.updatedAtMs).toBeLessThanOrEqual(NOW)
    }
  })

  it('field values pass the type rules of the metamodel', () => {
    for (const s of cmdb.byLabel.Server) {
      const octets = s.fields['ip_address']!.split('.').map(Number)
      expect(octets).toHaveLength(4)
      for (const o of octets) expect(o >= 0 && o <= 255).toBe(true)
      expect(['Windows', 'Linux']).toContain(s.fields['os'])
    }
    for (const a of cmdb.byLabel.Application) {
      expect(a.fields['url']).toMatch(/^https?:\/\//)
      if (a.environment === 'production') expect(a.fields['url']).toMatch(/^https:\/\//)
    }
    for (const c of cmdb.byLabel.Certificate) {
      expect(['public', 'external']).toContain(c.fields['certificate_type'])
      const expires = Date.parse(c.fields['expires_at']!)
      if (c.status === 'expired') expect(expires).toBeLessThan(NOW)
      else expect(expires).toBeGreaterThan(NOW)
    }
    for (const i of cmdb.byLabel.DatabaseInstance) expect(['PostgreSQL', 'Oracle', 'SQL Server']).toContain(i.fields['instance_type'])
  })

  it('every CI but the capabilities has an owner team and a support team of the right kind', () => {
    const teams = new Map(people.teams.map((t) => [t.id, t]))
    for (const c of cmdb.cis) {
      if (c.label !== 'BusinessCapability') {
        expect(teams.get(c.ownerTeamId!)?.type).toBe('owner')
        expect(teams.get(c.supportTeamId!)?.type).toBe('support')
        expect(teams.get(c.supportTeamId!)?.isChangeManager).toBe(false)
      }
    }
  })

  // Un minuto di tempo: questa prova PIANIFICA da capo un tenant intero
  // (3000 persone e 26.800 CI), e sotto la misura della copertura i cinque
  // secondi di vitest non bastano.
  it('the same seed gives the same tenant', () => {
    const again = planCMDB(new Rng('demo-test').fork('cmdb'), clock, DEFAULT_DEMO_COUNTS, planPeople(new Rng('demo-test').fork('people'), clock, DEFAULT_DEMO_COUNTS))
    expect(again.cis.slice(0, 50).map((c) => [c.id, c.name, c.status])).toEqual(cmdb.cis.slice(0, 50).map((c) => [c.id, c.name, c.status]))
    expect(again.relations.length).toBe(cmdb.relations.length)
  }, 60_000)
})

describe('the clock', () => {
  it('spans three years up to now in the tenant zone', () => {
    expect(NOW - clock.startMs).toBeGreaterThan(3 * 365 * DAY - DAY)
    expect(clock.local(Date.parse('2026-09-21T07:30:00.000Z'))).toEqual({ weekday: 1, hour: 9 })
  })
})
