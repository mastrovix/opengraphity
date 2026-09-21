import { minutesOfDay, type ServiceCalendar } from './calendar.js'
export interface SLATier {
  severity: string
  response_minutes: number
  resolve_minutes: number
  business_hours: boolean
  /** Minuti di preavviso prima della scadenza di risoluzione (dalla policy). */
  warning_minutes: number
}

export interface SLAPolicy {
  id: string
  tenant_id: string
  name: string
  entity_type: 'incident' | 'change' | 'service_request' | 'problem'
  timezone: string
  /** Il calendario di servizio del cliente (F6); `null` se non configurato. Serve ai tier in orario lavorativo. */
  calendar: ServiceCalendar | null
  tiers: SLATier[]
}

/*
  NESSUNA POLICY DI FABBRICA. Qui c'erano quattro policy scritte nel codice
  («Default Incident SLA» e le sorelle) che il motore applicava a ogni ticket
  che non corrispondeva a nessuna policy del cliente: invisibili nella pagina
  SLA Policies, non modificabili, con fuso e orari fissi. Uno SLA nasce solo da
  una policy del tenant (o da una business rule); un ticket che non ne ha
  nessuna resta senza SLA e la diagnostica di configurazione lo conta.
*/

// ── Business hours helpers ───────────────────────────────────────────────────
// L'orario lavorativo è il calendario di servizio del cliente (calendar.ts):
// prima erano tre costanti qui (08:00, 18:00, lunedì–venerdì).

/**
 * A wall-clock instant in the policy timezone. `day` is the local calendar
 * date encoded as `Date.UTC(y, m-1, d)` (midnight UTC of that calendar date),
 * which makes day arithmetic and weekday lookups trivial and DST-free;
 * `minuteOfDay` is minutes since local midnight. Conversion back to a real
 * instant happens once, at the end, via `zonedTimeToUtc` — the business-hours
 * arithmetic itself never adds minutes to a UTC timestamp, so a DST shift
 * between the start and the deadline cannot skew the result (D-09).
 */
interface LocalDateTime {
  day: number
  minuteOfDay: number
}

const DAY_MS = 24 * 60 * 60_000

const partsFormatterCache = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timezone: string): Intl.DateTimeFormat {
  let fmt = partsFormatterCache.get(timezone)
  if (!fmt) {
    // Throws RangeError on an unknown timezone — a corrupt policy must fail
    // loudly, not silently compute deadlines in the host timezone.
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric', second: 'numeric',
      hour12: false,
    })
    partsFormatterCache.set(timezone, fmt)
  }
  return fmt
}

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** Wall-clock fields of `date` in `timezone`. */
function toWallClock(date: Date, timezone: string): WallClock {
  const parts = partsFormatter(timezone).formatToParts(date)
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const v = parts.find((p) => p.type === type)?.value
    if (v === undefined) throw new Error(`[sla:policy] Intl did not return "${type}" for timezone "${timezone}"`)
    return parseInt(v, 10)
  }
  const rawHour = get('hour')
  return {
    year:   get('year'),
    month:  get('month'),
    day:    get('day'),
    hour:   rawHour === 24 ? 0 : rawHour,   // hour12:false may render midnight as 24
    minute: get('minute'),
    second: get('second'),
  }
}

/** Offset (ms) of `timezone` from UTC at the given instant: local − UTC. */
function tzOffsetMs(utcMs: number, timezone: string): number {
  const w = toWallClock(new Date(utcMs), timezone)
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  // Drop the sub-second part of utcMs: the wall clock is second-precise.
  return asIfUtc - Math.floor(utcMs / 1000) * 1000
}

/**
 * Converts a wall-clock time in `timezone` to the corresponding UTC instant
 * (the inverse of Intl formatting). Two-pass offset resolution handles the
 * days on which the offset changes. No external dependency.
 * `month` is 1-based.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const guess   = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  const offset1 = tzOffsetMs(guess, timezone)
  let utc = guess - offset1
  const offset2 = tzOffsetMs(utc, timezone)
  if (offset2 !== offset1) utc = guess - offset2
  return new Date(utc)
}

function toLocal(date: Date, timezone: string): LocalDateTime {
  const w = toWallClock(date, timezone)
  return {
    day:         Date.UTC(w.year, w.month - 1, w.day),
    minuteOfDay: w.hour * 60 + w.minute,
  }
}

function fromLocal(local: LocalDateTime, timezone: string): Date {
  const d = new Date(local.day)
  return zonedTimeToUtc(
    d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
    Math.floor(local.minuteOfDay / 60), local.minuteOfDay % 60,
    timezone,
  )
}

/** La forma del calendario comoda per il calcolo: minuti e giorni già decodificati. */
interface CalendarRule { days: ReadonlySet<number>; start: number; end: number; holidays: ReadonlySet<number> }

function calendarRule(calendar: ServiceCalendar): CalendarRule {
  return {
    days: new Set(calendar.days),
    start: minutesOfDay(calendar.start),
    end: minutesOfDay(calendar.end),
    holidays: new Set(calendar.holidays.map((h) => Date.UTC(Number(h.slice(0, 4)), Number(h.slice(5, 7)) - 1, Number(h.slice(8, 10))))),
  }
}

function isWorkingDay(day: number, rule: CalendarRule): boolean {
  return rule.days.has(new Date(day).getUTCDay()) && !rule.holidays.has(day)
}

/** L'inizio della fascia del primo giorno lavorativo strettamente dopo `day`. */
function nextBusinessDayStart(day: number, rule: CalendarRule): LocalDateTime {
  let next = day + DAY_MS
  // Un calendario valido ha almeno un giorno lavorativo a settimana, ma le
  // festività possono coprire periodi lunghi: il limite dice che il calendario
  // non lascia giorni lavorativi invece di girare per sempre.
  for (let guard = 0; !isWorkingDay(next, rule); guard++) {
    if (guard > 3660) throw new Error('[sla:policy] the service calendar has no working day in the next ten years')
    next += DAY_MS
  }
  return { day: next, minuteOfDay: rule.start }
}

/** Porta un istante locale al primo momento dentro l'orario lavorativo. Già dentro → invariato. */
function advanceToBusinessStart(local: LocalDateTime, rule: CalendarRule): LocalDateTime {
  if (!isWorkingDay(local.day, rule) || local.minuteOfDay >= rule.end) {
    return nextBusinessDayStart(local.day, rule)
  }
  if (local.minuteOfDay < rule.start) {
    return { day: local.day, minuteOfDay: rule.start }
  }
  return local
}

/**
 * Calculates the deadline by adding `minutes` of (optionally business-hours)
 * time to `startedAt`.
 *
 * Business hours: the tenant's service calendar (days, time band, holidays)
 * in local time in `timezone`. The computation runs on the local calendar (day
 * + minute-of-day) and is converted to UTC once at the end, so a DST
 * transition between start and deadline does not shift the result by an hour.
 * O(days), not O(minutes).
 */
export function calculateDeadline(
  startedAt: Date,
  minutes: number,
  businessHours: boolean,
  timezone: string,
  calendar: ServiceCalendar | null,
): Date {
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`[sla:policy] calculateDeadline: invalid minutes ${String(minutes)}`)
  }
  if (!businessHours) {
    return new Date(startedAt.getTime() + minutes * 60_000)
  }
  if (!calendar) {
    throw new Error('[sla:policy] business-hours deadline without a service calendar: configure it in Settings → Organization')
  }
  const rule = calendarRule(calendar)
  const minutesPerDay = rule.end - rule.start

  let current   = advanceToBusinessStart(toLocal(startedAt, timezone), rule)
  let remaining = minutes

  while (remaining > 0) {
    const minsLeftToday = rule.end - current.minuteOfDay

    if (remaining <= minsLeftToday) {
      current   = { day: current.day, minuteOfDay: current.minuteOfDay + remaining }
      remaining = 0
    } else {
      remaining -= minsLeftToday
      current = nextBusinessDayStart(current.day, rule)
      // Fast-forward full days while more than a business day remains.
      while (remaining > minutesPerDay) {
        remaining -= minutesPerDay
        current = nextBusinessDayStart(current.day, rule)
      }
    }
  }

  return fromLocal(current, timezone)
}

/**
 * I minuti (in orario di servizio, se `businessHours`) fra due istanti: il
 * rovescio di `calculateDeadline`. Serve a sommare il tempo in cui un ticket è
 * stato di un team (OLA come «tempo del team», secondo giro UI del 15 set 2026).
 * `to` prima di `from` → 0. O(giorni), come `calculateDeadline`.
 */
export function businessMinutesBetween(
  from: Date,
  to: Date,
  businessHours: boolean,
  timezone: string,
  calendar: ServiceCalendar | null,
): number {
  if (to.getTime() <= from.getTime()) return 0
  if (!businessHours) return (to.getTime() - from.getTime()) / 60_000
  if (!calendar) {
    throw new Error('[sla:policy] business-hours interval without a service calendar: configure it in Settings → Organization')
  }
  const rule = calendarRule(calendar)
  const end = toLocal(to, timezone)
  let current = advanceToBusinessStart(toLocal(from, timezone), rule)
  let minutes = 0
  for (let guard = 0; current.day < end.day || (current.day === end.day && current.minuteOfDay < end.minuteOfDay); guard++) {
    if (guard > 36600) throw new Error('[sla:policy] businessMinutesBetween: interval longer than a hundred years')
    if (current.day === end.day) {
      // L'ultimo giorno: fino a `to`, dentro la fascia.
      if (isWorkingDay(current.day, rule)) minutes += Math.max(0, Math.min(end.minuteOfDay, rule.end) - current.minuteOfDay)
      break
    }
    if (isWorkingDay(current.day, rule)) minutes += Math.max(0, rule.end - current.minuteOfDay)
    current = nextBusinessDayStart(current.day, rule)
  }
  return minutes
}
