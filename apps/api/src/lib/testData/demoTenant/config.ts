/**
 * WHAT THE DEMO TENANT'S ADMINISTRATOR CONFIGURED (23 Sep 2026).
 *
 * The tenant was born with its factory data only: no service calendar, no
 * SLA policy, no OLA contract, no assessment question. Tickets need them
 * (an incident with no matching policy has no SLA, a change with no question
 * cannot pass its assessment), so the generator configures them the way an
 * administrator would from the pages — same nodes, same validations — before
 * the three years of operation start.
 *
 *  - one service calendar, Monday to Friday 08:00-18:00 with the Italian
 *    public holidays of the period: the tenant's timezone is Europe/Rome;
 *  - SLA policies that cover every priority of incidents, problems and
 *    service requests (plus a stricter one for security incidents): a ticket
 *    that matches no policy gets no SLA and shows up in the diagnostics;
 *  - OLA contracts for some internal support teams (type `ola`) and
 *    underpinning contracts for some external ones (type `uc`, as the app
 *    requires for a supplier);
 *  - five functional questions (answered by the owner team of a CI) and five
 *    technical ones (by the support team), written by the generator as the
 *    owner of the product asked, "core" so they apply to every CI type.
 */
import type { Rng } from './random.js'
import { DAY, type DemoClock } from './clock.js'
import type { PeoplePlan } from './people.js'

export interface PlannedCalendar {
  id: string
  name: string
  days: number[]
  start: string
  end: string
  holidays: string[]
  /** The region whose working days and public holidays it holds (D57). */
  region: string
  /**
   * The zone its hours are read in. A calendar node has no zone of its own:
   * the SLA policies and the OLA/UC contracts that use it carry it
   * (`SLAPolicyNode.timezone`, `OLAContract.timezone`).
   */
  timeZone: string
}

export type SlaEntity = 'incident' | 'problem' | 'service_request'

export interface PlannedSlaPolicy {
  id: string
  name: string
  entityType: SlaEntity
  priority: string | null
  category: string | null
  /** A policy for the tickets of one team (a regional service desk): it wins over the generic one. */
  teamId: string | null
  /** The zone its business hours are read in; null = the tenant's. */
  timezone: string | null
  responseMinutes: number
  resolveMinutes: number
  warningMinutes: number
  /** `null` = 24x7; the calendar id = business hours (the app derives `business_hours` from it). */
  calendarId: string | null
  complianceTarget: number
  complianceWarning: number
  createdAtMs: number
}

export interface PlannedOla {
  id: string
  type: 'ola' | 'uc'
  name: string
  description: string
  entityType: 'incident' | 'problem' | 'change' | 'service_request' | 'any'
  responseMinutes: number
  resolveMinutes: number
  calendarId: string | null
  partyType: 'team' | 'supplier'
  teamId: string
  complianceTarget: number
  complianceWarning: number
  createdAtMs: number
  /** The contract's own zone, when its calendar is read in another zone than the tenant's; null = the tenant's. */
  timezone: string | null
}

export interface PlannedQuestion {
  id: string
  text: string
  category: 'functional' | 'technical'
  /** Weight on every CI type (HAS_QUESTION.weight) and its order. */
  weight: number
  sortOrder: number
  options: Array<{ id: string; label: string; score: number; sortOrder: number }>
}

export interface ConfigPlan {
  /** The headquarters' calendar: the company-wide policies count on it. */
  calendar: PlannedCalendar
  /** Every calendar, the headquarters' first. */
  calendars: PlannedCalendar[]
  slaPolicies: PlannedSlaPolicy[]
  questions: PlannedQuestion[]
}

/** Easter Sunday of a year, as month-day (the Gregorian computus): the movable holidays hang off it. */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const n = h + l - 7 * m + 114
  return { month: Math.floor(n / 31), day: (n % 31) + 1 }
}

const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`

/** A day relative to Easter Sunday (Good Friday = -2, Easter Monday = +1, Ascension = +39, Whit Monday = +50). */
function fromEaster(year: number, offset: number): string {
  const e = easterSunday(year)
  return ymd(new Date(Date.UTC(year, e.month - 1, e.day + offset)))
}

/** The n-th given weekday of a month (n = -1: the last one). weekday: 0 = Sunday. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
    return ymd(new Date(Date.UTC(year, month - 1, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7)))
  }
  const last = new Date(Date.UTC(year, month, 0))
  return ymd(new Date(Date.UTC(year, month - 1, last.getUTCDate() - ((last.getUTCDay() - weekday + 7) % 7))))
}

/** Chinese New Year's two days in Singapore (lunar: a table, not a rule). */
const LUNAR_NEW_YEAR: Readonly<Record<number, readonly string[]>> = {
  2022: ['02-01', '02-02'], 2023: ['01-22', '01-23', '01-24'], 2024: ['02-10', '02-11', '02-12'], 2025: ['01-29', '01-30'],
  2026: ['02-17', '02-18'], 2027: ['02-06', '02-07', '02-08'], 2028: ['01-26', '01-27'], 2029: ['02-13', '02-14'], 2030: ['02-03', '02-04'],
}

/**
 * THE PUBLIC HOLIDAYS OF EACH REGION, per year. The fixed days and the ones
 * that move with Easter or with the calendar (the US Mondays, the Swedish
 * Midsummer Eve); the lunar holidays of Singapore come from a table.
 */
const REGION_HOLIDAYS: Readonly<Record<string, (y: number) => string[]>> = {
  'Italy': (y) => [...['01-01', '01-06', '04-25', '05-01', '06-02', '08-15', '11-01', '12-08', '12-25', '12-26'].map((md) => `${String(y)}-${md}`), fromEaster(y, 1)],
  'Germany': (y) => [...['01-01', '05-01', '10-03', '12-25', '12-26'].map((md) => `${String(y)}-${md}`), fromEaster(y, -2), fromEaster(y, 1), fromEaster(y, 39), fromEaster(y, 50)],
  'France': (y) => [...['01-01', '05-01', '05-08', '07-14', '08-15', '11-01', '11-11', '12-25'].map((md) => `${String(y)}-${md}`), fromEaster(y, 1), fromEaster(y, 39), fromEaster(y, 50)],
  'Spain': (y) => [...['01-01', '01-06', '05-01', '08-15', '10-12', '11-01', '12-06', '12-08', '12-25'].map((md) => `${String(y)}-${md}`), fromEaster(y, -2)],
  'United Kingdom': (y) => [`${String(y)}-01-01`, fromEaster(y, -2), fromEaster(y, 1), nthWeekday(y, 5, 1, 1), nthWeekday(y, 5, 1, -1), nthWeekday(y, 8, 1, -1), `${String(y)}-12-25`, `${String(y)}-12-26`],
  'Benelux': (y) => [...['01-01', '04-27', '12-25', '12-26'].map((md) => `${String(y)}-${md}`), fromEaster(y, 1), fromEaster(y, 39), fromEaster(y, 50)],
  'Nordics': (y) => {
    // Midsummer Eve: the Friday between 19 and 25 June.
    const june19 = new Date(Date.UTC(y, 5, 19)).getUTCDay()
    const midsummerEve = ymd(new Date(Date.UTC(y, 5, 19 + ((5 - june19 + 7) % 7))))
    return [...['01-01', '01-06', '05-01', '06-06', '12-24', '12-25', '12-26', '12-31'].map((md) => `${String(y)}-${md}`), fromEaster(y, -2), fromEaster(y, 1), fromEaster(y, 39), midsummerEve]
  },
  'Americas': (y) => [`${String(y)}-01-01`, nthWeekday(y, 1, 1, 3), nthWeekday(y, 2, 1, 3), nthWeekday(y, 5, 1, -1), `${String(y)}-06-19`, `${String(y)}-07-04`, nthWeekday(y, 9, 1, 1), nthWeekday(y, 11, 4, 4), `${String(y)}-12-25`],
  'APAC': (y) => {
    const lunar = LUNAR_NEW_YEAR[y]
    if (!lunar) throw new Error(`holidays: the lunar new year of ${String(y)} is not in the table`)
    return [...['01-01', '05-01', '08-09', '12-25'].map((md) => `${String(y)}-${md}`), ...lunar.map((md) => `${String(y)}-${md}`), fromEaster(y, -2)]
  },
}

/** The public holidays of a region for the years of the period, sorted. */
export function regionHolidays(region: string, fromYear: number, toYear: number): string[] {
  const of = REGION_HOLIDAYS[region]
  if (!of) throw new Error(`regionHolidays: no holidays for the region "${region}"`)
  const out: string[] = []
  for (let y = fromYear; y <= toYear; y++) out.push(...of(y))
  return [...new Set(out)].sort()
}

/** Italian public holidays, including Easter Monday, for the years of the period. */
export function italianHolidays(fromYear: number, toYear: number): string[] {
  return regionHolidays('Italy', fromYear, toYear)
}

/**
 * THE CALENDARS OF THE REGIONS (tour of 23 Sep 2026, D57). One calendar,
 * «Business Hours Italy», counted the working time of every SLA and OLA, the
 * APAC, Americas and Nordic service desks included. Each region works its own
 * days and hours and stops on its own holidays.
 */
const REGION_CALENDARS: ReadonlyArray<{ region: string; name: string; start: string; end: string; timeZone: string }> = [
  { region: 'Italy', name: 'Business Hours Italy', start: '08:00', end: '18:00', timeZone: 'Europe/Rome' },
  { region: 'Germany', name: 'Business Hours Germany', start: '08:00', end: '17:00', timeZone: 'Europe/Berlin' },
  { region: 'France', name: 'Business Hours France', start: '09:00', end: '18:00', timeZone: 'Europe/Paris' },
  { region: 'Spain', name: 'Business Hours Spain', start: '09:00', end: '18:00', timeZone: 'Europe/Madrid' },
  { region: 'United Kingdom', name: 'Business Hours United Kingdom', start: '09:00', end: '17:30', timeZone: 'Europe/London' },
  { region: 'Benelux', name: 'Business Hours Benelux', start: '08:30', end: '17:30', timeZone: 'Europe/Amsterdam' },
  { region: 'Nordics', name: 'Business Hours Nordics', start: '08:00', end: '16:30', timeZone: 'Europe/Stockholm' },
  { region: 'Americas', name: 'Business Hours Americas', start: '08:00', end: '18:00', timeZone: 'America/New_York' },
  { region: 'APAC', name: 'Business Hours APAC', start: '09:00', end: '18:00', timeZone: 'Asia/Singapore' },
]

/** Minutes in business days of the calendar (10 working hours a day). */
const BUSINESS_DAY = 10 * 60

function slaPolicies(rng: Rng, calendars: readonly PlannedCalendar[], people: PeoplePlan, createdAtMs: number): PlannedSlaPolicy[] {
  const hq = calendars[0]!.id
  const p = (name: string, entityType: SlaEntity, priority: string | null, category: string | null,
    responseMinutes: number, resolveMinutes: number, warningMinutes: number, businessHours: boolean,
    complianceTarget: number, complianceWarning: number,
    scope: { teamId: string; calendarId: string; timezone: string } | null = null): PlannedSlaPolicy => ({
    id: rng.uuid(), name, entityType, priority, category, teamId: scope?.teamId ?? null, timezone: scope?.timezone ?? null,
    responseMinutes, resolveMinutes, warningMinutes,
    calendarId: businessHours ? (scope?.calendarId ?? hq) : null, complianceTarget, complianceWarning, createdAtMs,
  })
  /*
   * D57: the service desks far from the headquarters answer the employees
   * of their region in their hours — the medium and low incidents they take
   * count on their calendar and in their zone (a policy of the team wins
   * over the generic one, `selector.ts`).
   */
  const regional: PlannedSlaPolicy[] = []
  for (const region of ['United Kingdom', 'Americas', 'APAC']) {
    const desk = people.teams.find((t) => t.area === 'Service Desk' && t.region === region)
    const cal = calendars.find((c) => c.region === region)
    if (!desk || !cal) continue
    const scope = { teamId: desk.id, calendarId: cal.id, timezone: cal.timeZone }
    regional.push(
      p(`Incident P3 - Medium (${region} business hours)`, 'incident', 'medium', null, 2 * 60, 2 * BUSINESS_DAY, 240, true, 92, 85, scope),
      p(`Incident P4 - Low (${region} business hours)`, 'incident', 'low', null, 4 * 60, 5 * BUSINESS_DAY, 480, true, 90, 80, scope),
    )
  }
  return [
    p('Incident P1 - Critical (24x7)', 'incident', 'critical', null, 15, 4 * 60, 60, false, 95, 90),
    p('Incident P2 - High (24x7)', 'incident', 'high', null, 30, 8 * 60, 120, false, 95, 90),
    p('Incident P3 - Medium (business hours)', 'incident', 'medium', null, 2 * 60, 2 * BUSINESS_DAY, 240, true, 92, 85),
    p('Incident P4 - Low (business hours)', 'incident', 'low', null, 4 * 60, 5 * BUSINESS_DAY, 480, true, 90, 80),
    // Category AND priority: it wins over the priority-only policies above for security incidents.
    p('Security Incident - Critical (24x7)', 'incident', 'critical', 'security', 10, 2 * 60, 30, false, 98, 95),
    p('Security Incident - High (24x7)', 'incident', 'high', 'security', 15, 4 * 60, 60, false, 97, 92),
    ...regional,
    p('Problem - Critical', 'problem', 'critical', null, 4 * 60, 10 * BUSINESS_DAY, 2 * BUSINESS_DAY, true, 90, 80),
    p('Problem - High', 'problem', 'high', null, 8 * 60, 20 * BUSINESS_DAY, 4 * BUSINESS_DAY, true, 90, 80),
    p('Problem - Medium and Low', 'problem', null, null, BUSINESS_DAY, 40 * BUSINESS_DAY, 5 * BUSINESS_DAY, true, 85, 75),
    p('Service Request - Urgent', 'service_request', 'critical', null, 60, BUSINESS_DAY, 120, true, 95, 90),
    p('Service Request - High', 'service_request', 'high', null, 2 * 60, 2 * BUSINESS_DAY, 240, true, 95, 90),
    p('Service Request - Standard', 'service_request', 'medium', null, 4 * 60, 3 * BUSINESS_DAY, 480, true, 92, 85),
    p('Service Request - Low', 'service_request', 'low', null, BUSINESS_DAY, 5 * BUSINESS_DAY, BUSINESS_DAY, true, 90, 80),
  ]
}

/** The questions the owner of the product asked for: five functional, five technical. */
const QUESTION_SEEDS: ReadonlyArray<{
  text: string; category: 'functional' | 'technical'; weight: number; options: ReadonlyArray<readonly [string, number]>
}> = [
  { text: 'How many business users are affected while the change is being implemented?', category: 'functional', weight: 4,
    options: [['None', 0], ['Fewer than 100', 1], ['100 to 1,000', 2], ['More than 1,000', 3]] },
  { text: 'Does the change affect a business-critical process or a customer-facing service?', category: 'functional', weight: 5,
    options: [['No', 0], ['Indirectly', 1], ['Yes, a supporting process', 2], ['Yes, a critical or customer-facing one', 3]] },
  { text: 'Is a business outage window needed?', category: 'functional', weight: 3,
    options: [['No outage', 0], ['Within the agreed maintenance window', 1], ['Outside the maintenance window', 3]] },
  { text: 'Does the change touch personal, financial or regulated data?', category: 'functional', weight: 4,
    options: [['No', 0], ['Internal data only', 1], ['Personal data', 2], ['Financial or regulated data', 3]] },
  { text: 'Have the business owners tested and accepted the change?', category: 'functional', weight: 3,
    options: [['Yes, signed off', 0], ['Tested, sign-off pending', 1], ['Not yet tested', 3]] },
  { text: 'How complex is the technical implementation?', category: 'technical', weight: 4,
    options: [['Configuration only', 0], ['Single component', 1], ['Several components', 2], ['Several systems and teams', 3]] },
  { text: 'Has the change been tested in a pre-production environment?', category: 'technical', weight: 5,
    options: [['Yes, fully', 0], ['Partially', 1], ['No', 3]] },
  { text: 'Is there a tested rollback plan?', category: 'technical', weight: 5,
    options: [['Yes, tested', 0], ['Yes, not tested', 2], ['No rollback possible', 3]] },
  { text: 'How many dependent CIs could be impacted?', category: 'technical', weight: 3,
    options: [['None', 0], ['1 to 5', 1], ['6 to 20', 2], ['More than 20', 3]] },
  { text: 'Does the change require downtime of the CI?', category: 'technical', weight: 3,
    options: [['No', 0], ['Less than 30 minutes', 1], ['Up to 4 hours', 2], ['More than 4 hours', 3]] },
]

function questions(rng: Rng): PlannedQuestion[] {
  return QUESTION_SEEDS.map((q, i) => ({
    id: rng.uuid(), text: q.text, category: q.category, weight: q.weight, sortOrder: i,
    options: q.options.map(([label, score], j) => ({ id: rng.uuid(), label, score, sortOrder: j })),
  }))
}

export function planConfig(rng: Rng, clock: DemoClock, people: PeoplePlan): ConfigPlan {
  // Configured in the first week, before the first ticket.
  const createdAtMs = clock.startMs + DAY
  const fromYear = new Date(clock.startMs).getUTCFullYear()
  const toYear = new Date(clock.nowMs).getUTCFullYear() + 1
  const crng = rng.fork('calendars')
  const calendars: PlannedCalendar[] = REGION_CALENDARS.map((c) => ({
    id: crng.uuid(), name: c.name, days: [1, 2, 3, 4, 5], start: c.start, end: c.end,
    holidays: regionHolidays(c.region, fromYear, toYear), region: c.region, timeZone: c.timeZone,
  }))
  return {
    calendar: calendars[0]!,
    calendars,
    slaPolicies: slaPolicies(rng.fork('sla'), calendars, people, createdAtMs),
    questions: questions(rng.fork('questions')),
  }
}
