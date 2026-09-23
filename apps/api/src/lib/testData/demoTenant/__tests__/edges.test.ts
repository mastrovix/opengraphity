/**
 * THE EDGES OF THE GENERATOR'S SMALL TOOLS.
 *
 * The clock, the randomness, the world and the calendar are used by every
 * other module thousands of times, so what they do at the edges — an empty
 * window, a weight that is zero, a pool where nobody existed yet, a year the
 * holiday table does not reach — decides whether a whole run stops with a
 * clear sentence or writes something nobody asked for. Those are the cases
 * here: the ordinary path is already exercised by the ticket tests.
 */
import { describe, it, expect } from 'vitest'
import { Rng } from '../random.js'
import { DemoClock, DAY, HOUR, MINUTE } from '../clock.js'
import { easterSunday, italianHolidays, regionHolidays } from '../config.js'
import { DEFAULT_DEMO_COUNTS, DEMO_RATIOS, assertDemoCounts } from '../options.js'
import { arrivalInstants } from '../arrivals.js'
import { planClientLogs } from '../clientLogs.js'
import { DEMO_CATALOG, DEMO_VOCABULARIES, vocabularyValues } from '../catalogContent.js'
import { fieldName } from '../catalogSetup.js'
import { OFFICE_SITE_VALUES, SUPPORT_TEAM_TOWERS } from '../names.js'
import { REQUEST_STUCK_SHARE } from '../serviceRequests.js'
import { NOW, smallWorld } from './fixtures.js'

const clock = new DemoClock(NOW, 3, 'Europe/Rome')

describe('DemoClock', () => {
  it('reads the weekday and the hour in the tenant\'s zone, not in UTC', () => {
    // 22 Sep 2026 is a Tuesday; 23:30 UTC is already Wednesday 01:30 in Rome.
    expect(clock.local(Date.parse('2026-09-22T23:30:00Z'))).toEqual({ weekday: 3, hour: 1 })
    expect(clock.iso(Date.parse('2026-09-22T23:30:00Z'))).toBe('2026-09-22T23:30:00.000Z')
  })

  it('working time is Monday to Friday, 08:00 to 19:00 local', () => {
    expect(clock.isWorkingTime(Date.parse('2026-09-22T07:00:00Z'))).toBe(true)      // 09:00 in Rome
    expect(clock.isWorkingTime(Date.parse('2026-09-22T05:00:00Z'))).toBe(false)     // 07:00 in Rome
    expect(clock.isWorkingTime(Date.parse('2026-09-22T18:00:00Z'))).toBe(false)     // 20:00 in Rome
    expect(clock.isWorkingTime(Date.parse('2026-09-20T10:00:00Z'))).toBe(false)     // Sunday
  })

  it('an empty or backwards window gives back its own start', () => {
    const rng = new Rng('clock')
    expect(clock.between(rng, NOW, NOW)).toBe(NOW)
    expect(clock.between(rng, NOW, NOW - DAY)).toBe(NOW)
    expect(clock.workInstant(rng, NOW, NOW)).toBe(NOW)
  })

  it('a window with no working hour at all is used as it is', () => {
    // A Saturday night: no attempt can land inside working hours.
    const from = Date.parse('2026-09-19T22:00:00Z'), to = from + 2 * HOUR
    const ms = clock.workInstant(new Rng('weekend'), from, to, 0)
    expect(ms).toBeGreaterThanOrEqual(from)
    expect(ms).toBeLessThan(to)
  })

  it('work that would end after the cap is cut at the cap, and never takes less than a minute', () => {
    expect(clock.after(NOW - HOUR, 10 * HOUR)).toBe(NOW)
    expect(clock.after(NOW - HOUR, 0)).toBe(NOW - HOUR + MINUTE)
    expect(clock.after(NOW - 10 * DAY, HOUR, NOW - 9 * DAY)).toBe(NOW - 10 * DAY + HOUR)
  })

  it('the simulated period starts `years` before now', () => {
    expect(clock.startMs).toBeLessThan(NOW)
    expect(Math.round((NOW - clock.startMs) / DAY)).toBeGreaterThanOrEqual(365 * 3)
  })
})

describe('Rng', () => {
  it('the same seed gives the same numbers, a fork gives different ones', () => {
    const a = new Rng('x'), b = new Rng('x')
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()])
    expect(new Rng('x').fork('people').next()).not.toBe(new Rng('x').fork('cmdb').next())
  })

  it('refuses a range that is not whole or is backwards', () => {
    const rng = new Rng('x')
    expect(() => rng.int(1.5, 3)).toThrow(/invalid range/)
    expect(() => rng.int(5, 1)).toThrow(/invalid range/)
    expect(rng.int(3, 3)).toBe(3)
  })

  it('picking from nothing, or weighing with nothing, stops instead of giving undefined', () => {
    const rng = new Rng('x')
    expect(() => rng.pick([])).toThrow(/empty list/)
    expect(() => rng.weighted([['a', 0], ['b', 0]])).toThrow(/more than 0/)
  })

  it('a weight of zero is never drawn', () => {
    const rng = new Rng('weights')
    const drawn = new Set(Array.from({ length: 200 }, () => rng.weighted([['never', 0], ['always', 1]])))
    expect([...drawn]).toEqual(['always'])
  })

  it('sample gives distinct items, and everything when asked for more than there is', () => {
    const rng = new Rng('sample')
    const items = ['a', 'b', 'c', 'd', 'e']
    expect(new Set(rng.sample(items, 3)).size).toBe(3)
    expect([...rng.sample(items, 9)].sort()).toEqual(items)
  })

  it('exactFlags gives exactly the asked share, at any size', () => {
    const rng = new Rng('flags')
    for (const [n, share, expected] of [[100, 0.2, 20], [7, 0.5, 4], [15000, 0.15, 2250], [3, 0, 0]] as const) {
      expect(rng.exactFlags(n, share).filter(Boolean)).toHaveLength(expected)
    }
  })

  it('logNormal stays positive and has its median about where it was asked', () => {
    const rng = new Rng('log')
    const values = Array.from({ length: 2000 }, () => rng.logNormal(4 * HOUR, 0.8))
    expect(Math.min(...values)).toBeGreaterThan(0)
    const median = values.sort((a, b) => a - b)[1000]!
    expect(median / HOUR).toBeGreaterThan(3)
    expect(median / HOUR).toBeLessThan(5)
  })

  it('the uuids it draws have the shape of a v4 and do not repeat', () => {
    const rng = new Rng('uuid')
    const ids = Array.from({ length: 500 }, () => rng.uuid())
    expect(new Set(ids).size).toBe(500)
    expect(ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))).toBe(true)
  })
})

describe('the counts the owner asked for', () => {
  it('the defaults are the request of the owner, with the problems brought back to scale', () => {
    expect(DEFAULT_DEMO_COUNTS).toMatchObject({
      users: 3000, ownerTeams: 200, supportTeams: 300, businessApplications: 1500, applications: 2000,
      capabilities: 300, servers: 15000, databaseInstances: 2000, databases: 3000, certificates: 3000,
      incidents: 50000, problems: 800, changes: 15000, serviceRequests: 120000, catalogItems: 50, reports: 20, clientLogs: 6000, monitoringEvents: 120000, monitoredServices: 30,
    })
    expect(DEMO_RATIOS.roles.operator + DEMO_RATIOS.roles.end_user + DEMO_RATIOS.roles.viewer + DEMO_RATIOS.roles.admin).toBeCloseTo(1, 10)
    assertDemoCounts({ ...DEFAULT_DEMO_COUNTS })
  })

  it('refuses a shape that cannot exist', () => {
    const c = { ...DEFAULT_DEMO_COUNTS }
    expect(() => assertDemoCounts({ ...c, users: -1 })).toThrow(/non-negative integer/)
    expect(() => assertDemoCounts({ ...c, users: 3.5 })).toThrow(/non-negative integer/)
    expect(() => assertDemoCounts({ ...c, ownerTeams: 0 })).toThrow(/at least one owner team/)
    expect(() => assertDemoCounts({ ...c, users: 100 })).toThrow(/two operators per team/)
    expect(() => assertDemoCounts({ ...c, businessApplications: 0 })).toThrow(/at least one business application/)
    expect(() => assertDemoCounts({ ...c, servers: 0 })).toThrow(/at least one server/)
    expect(() => assertDemoCounts({ ...c, databaseInstances: 0 })).toThrow(/at least one database instance/)
    expect(() => assertDemoCounts({ ...c, catalogItems: 0 })).toThrow(/at least one catalog item/)
  })

  it('a tenant with no applications and no databases is allowed', () => {
    assertDemoCounts({ ...DEFAULT_DEMO_COUNTS, applications: 0, databases: 0, databaseInstances: 0, servers: 0 })
  })
})

describe('the Italian calendar', () => {
  it('gives the eleven days of every year, Easter Monday included', () => {
    const days = italianHolidays(2024, 2026)
    expect(days).toHaveLength(33)
    expect(days).toContain('2024-04-01')      // Easter Monday 2024
    expect(days).toContain('2026-08-15')
    expect([...days].sort()).toEqual(days)    // already sorted
  })

  it('Easter is computed, not looked up: any year works', () => {
    for (const [year, sunday] of [[2024, '03-31'], [2025, '04-20'], [2026, '04-05'], [2031, '04-13'], [2038, '04-25']] as const) {
      const e = easterSunday(year)
      expect(`${String(e.month).padStart(2, '0')}-${String(e.day).padStart(2, '0')}`).toBe(sunday)
    }
    expect(italianHolidays(2031, 2031)).toContain('2031-04-14')
  })
})

/** D57 (tour of 23 Sep 2026): every region stops on its own holidays. */
describe('the calendars of the regions', () => {
  it('the movable days land where they do (US Mondays and Thanksgiving, UK bank holidays, Swedish Midsummer Eve)', () => {
    expect(regionHolidays('Americas', 2026, 2026)).toEqual(expect.arrayContaining(['2026-01-19', '2026-02-16', '2026-05-25', '2026-09-07', '2026-11-26']))
    expect(regionHolidays('United Kingdom', 2026, 2026)).toEqual(expect.arrayContaining(['2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31']))
    expect(regionHolidays('Nordics', 2026, 2026)).toContain('2026-06-19')
    expect(regionHolidays('Germany', 2026, 2026)).toEqual(expect.arrayContaining(['2026-05-14', '2026-05-25', '2026-10-03']))
    expect(regionHolidays('APAC', 2026, 2026)).toEqual(expect.arrayContaining(['2026-02-17', '2026-02-18', '2026-08-09']))
  })

  it('an unknown region, or a lunar year missing from the table, stops instead of giving an empty calendar', () => {
    expect(() => regionHolidays('Atlantis', 2026, 2026)).toThrow(/no holidays for the region "Atlantis"/)
    expect(() => regionHolidays('APAC', 2031, 2031)).toThrow(/lunar new year of 2031/)
  })
})

describe('the catalog the owner asked for', () => {
  it('fifty models; a field belongs to one model, except the five every company shares (D26)', () => {
    expect(DEMO_CATALOG).toHaveLength(50)
    expect(new Set(DEMO_CATALOG.map((i) => i.key)).size).toBe(50)
    expect(new Set(DEMO_CATALOG.map((i) => i.name)).size).toBe(50)
    const own = DEMO_CATALOG.flatMap((i) => i.sections.flatMap((s) => s.fields.filter((f) => !f.shared).map((f) => fieldName(i, f))))
    expect(new Set(own).size).toBe(own.length)
    const shared = DEMO_CATALOG.flatMap((i) => i.sections.flatMap((s) => s.fields.filter((f) => f.shared)))
    expect([...new Set(shared.map((f) => f.key))].sort()).toEqual(['device_model', 'full_name', 'office_site', 'size', 'software'])
    // One library field: the same definition wherever it is used.
    for (const key of new Set(shared.map((f) => f.key))) {
      const defs = new Set(shared.filter((f) => f.key === key).map((f) => JSON.stringify([f.type, f.label, f.labelIt, f.vocabulary ?? null, f.inList === true])))
      expect(defs.size, key).toBe(1)
    }
    expect(shared.filter((f) => f.key === 'office_site').length).toBeGreaterThanOrEqual(10)
  })

  it('the requests list shows four columns, all of them shared fields (D26: it had forty-six)', () => {
    const inList = new Set(DEMO_CATALOG.flatMap((i) => i.sections.flatMap((s) => s.fields.filter((f) => f.inList).map((f) => fieldName(i, f)))))
    expect([...inList].sort()).toEqual(['device_model', 'full_name', 'office_site', 'software'])
  })

  it('every value of every vocabulary reads in English and Italian (D54), and a model answers only with values of its vocabulary', () => {
    for (const v of DEMO_VOCABULARIES) {
      for (const [value, it] of v.entries) {
        expect(value.trim(), v.name).not.toBe('')
        expect(it.trim(), `${v.name}.${value}`).not.toBe('')
      }
    }
    const values = new Map(DEMO_VOCABULARIES.map((v) => [v.name, new Set(vocabularyValues(v))]))
    for (const item of DEMO_CATALOG) {
      for (const f of item.sections.flatMap((s) => s.fields)) {
        for (const x of f.answer?.values ?? []) expect(values.get(f.vocabulary!)?.has(x), `${item.key}.${f.key}: ${x}`).toBe(true)
      }
    }
    // D30: the offices are the company's, the same list people work at.
    expect(vocabularyValues(DEMO_VOCABULARIES.find((v) => v.name === 'office_site')!)).toEqual(OFFICE_SITE_VALUES)
  })

  it('every model has its fulfilment group and its duration; «Other» keeps what is really other (D28, D56)', () => {
    for (const item of DEMO_CATALOG) {
      expect(SUPPORT_TEAM_TOWERS, item.key).toContain(item.fulfilTower)
      expect(item.fulfilHours, item.key).toBeGreaterThan(0)
    }
    expect(DEMO_CATALOG.filter((i) => i.category === 'other').map((i) => i.key).sort()).toEqual(['procurement', 'report'])
    for (const c of ['infrastructure', 'workplace', 'people']) expect(DEMO_CATALOG.some((i) => i.category === c), c).toBe(true)
  })

  /**
   * D1 (tour of 23 Sep 2026): 628 requests were open, against the ~125 the
   * owner asked for. Little's law on the models' durations: arrivals a day ×
   * mean life. The durations are log-normal with σ = 0.5 around each model's
   * median, weighted by how often it is asked for; the stuck ones add theirs.
   */
  it('the durations give about 125 open requests and a median of about 16 hours', () => {
    const total = DEMO_CATALOG.reduce((n, i) => n + i.demand, 0)
    const meanHours = DEMO_CATALOG.reduce((n, i) => n + (i.demand / total) * i.fulfilHours * Math.exp(0.5 ** 2 / 2), 0)
    const perDay = DEFAULT_DEMO_COUNTS.serviceRequests / 1095
    const open = perDay * (meanHours / 24) + perDay * REQUEST_STUCK_SHARE * 14
    expect(open).toBeGreaterThan(105)
    expect(open).toBeLessThan(145)
    const medians = DEMO_CATALOG.flatMap((i) => Array<number>(i.demand).fill(i.fulfilHours)).sort((a, b) => a - b)
    expect(medians[Math.floor(medians.length / 2)]).toBeGreaterThanOrEqual(12)
    expect(medians[Math.floor(medians.length / 2)]).toBeLessThanOrEqual(20)
  })

  it('every model can be filled in: a section with fields, and a reason to write', () => {
    for (const item of DEMO_CATALOG) {
      expect(item.sections.length, item.key).toBeGreaterThan(0)
      expect(item.sections.flatMap((s) => s.fields).length, item.key).toBeGreaterThan(0)
      expect(item.details.length, item.key).toBeGreaterThan(0)
    }
  })

  it('every vocabulary a field points at is one this file creates, or one the tenant already has', () => {
    // These four come with the tenant (seed-metamodel): the forms use the
    // customer's own words for an environment or an operating system instead
    // of a second list that would drift from the CMDB's.
    const factory = new Set(['environment', 'certificate_type', 'os', 'instance_type'])
    const known = new Map(DEMO_VOCABULARIES.map((v) => [v.name, v]))
    const used = new Set<string>()
    for (const item of DEMO_CATALOG) {
      for (const section of item.sections) {
        for (const field of section.fields) {
          // A table's columns point at vocabularies too, like any other field.
          const picksFromAList = (type: string) => type === 'enum' || type === 'multi_enum'
          const names = [...(picksFromAList(field.type) ? [field.vocabulary ?? ''] : []),
            ...(field.table ?? []).filter((c) => picksFromAList(c.type)).map((c) => c.vocabulary ?? '')]
          for (const name of names) {
            used.add(name)
            expect(known.has(name) || factory.has(name), `${item.key}.${field.key} → "${name}"`).toBe(true)
            if (known.has(name)) expect(known.get(name)!.entries.length).toBeGreaterThan(1)
          }
        }
      }
    }
    // And nothing is created that no form uses.
    for (const v of DEMO_VOCABULARIES) expect(used.has(v.name), v.name).toBe(true)
  })
})

describe('World', () => {
  const world = smallWorld()

  it('gives somebody who already existed at that moment', () => {
    const u = world.someone(new Rng('who'), world.operators, world.clock.nowMs)
    expect(u.createdAtMs).toBeLessThanOrEqual(world.clock.nowMs)
    // Early on only the first people are there: the search must still find one.
    const early = Math.min(...world.operators.map((o) => o.createdAtMs)) + HOUR
    expect(world.someone(new Rng('who'), world.operators, early).createdAtMs).toBeLessThanOrEqual(early)
  })

  it('stops when nobody of that role existed yet, instead of writing a ticket from a ghost', () => {
    expect(() => world.someone(new Rng('who'), world.operators, world.clock.startMs - DAY))
      .toThrow(/nobody of that role existed at that time/)
  })

  it('a team has at least two people, and its manager is one of them', () => {
    for (const team of [...world.ownerTeams, ...world.supportTeams].slice(0, 20)) {
      const members = world.membersOf.get(team.id)!
      expect(members.size).toBeGreaterThanOrEqual(2)
      expect(members.has(team.managerId)).toBe(true)
      expect(world.isMember(team.managerId, team.id)).toBe(true)
      expect(world.memberOf(new Rng('m'), team.id, world.clock.nowMs).id).toBeDefined()
    }
  })

  it('a CI it gives back was already there and is running', () => {
    const rng = new Rng('ci')
    for (let i = 0; i < 50; i++) {
      const ci = world.runningCI(rng, world.cmdb.byLabel.Server, world.clock.nowMs)
      if (!ci) continue
      expect(ci.createdAtMs).toBeLessThanOrEqual(world.clock.nowMs)
      expect(['active', 'maintenance']).toContain(ci.status)
    }
    expect(world.runningCI(rng, world.cmdb.byLabel.Server, world.clock.startMs - DAY)).toBeNull()
  })
})

/** D2 (tour of 23 Sep 2026): the month the demo is shown in was a peak, three times the average, and it filled the open queue. */
describe('the arrivals over three years', () => {
  it('grow, but the current month is an ordinary one — never a peak', () => {
    const clock = new DemoClock(NOW, 3, 'Europe/Rome')
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const at = arrivalInstants(new Rng(seed), clock, 50000, clock.startMs, NOW)
      const perDay = at.length / ((NOW - clock.startMs) / DAY)
      const lastMonth = at.filter((t) => t > NOW - 30 * DAY).length / 30
      expect(lastMonth / perDay, seed).toBeLessThan(1.7)
      expect(lastMonth / perDay, seed).toBeGreaterThan(0.6)
    }
  })
})

/** D65 (tour of 23 Sep 2026): the platform's retention deleted 5,300 browser logs of 6,172 while the tour was running. */
describe('the browser logs', () => {
  it('are all inside the retention window, and none after now', () => {
    const world = smallWorld('logs')
    const logs = planClientLogs(new Rng('logs'), world, 600)
    expect(logs).toHaveLength(600)
    for (const l of logs) {
      expect(Date.parse(l.timestamp)).toBeGreaterThan(NOW - 90 * DAY)
      expect(Date.parse(l.timestamp)).toBeLessThanOrEqual(NOW)
    }
  })
})

