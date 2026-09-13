export interface SLATier {
  severity: string
  response_minutes: number
  resolve_minutes: number
  business_hours: boolean
}

export interface SLAPolicy {
  id: string
  tenant_id: string
  name: string
  entity_type: 'incident' | 'change' | 'service_request' | 'problem'
  timezone: string
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

const BUSINESS_START = 8   // 08:00
const BUSINESS_END   = 18  // 18:00
const MINUTES_PER_BUSINESS_DAY = (BUSINESS_END - BUSINESS_START) * 60

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

function isWeekend(day: number): boolean {
  const dow = new Date(day).getUTCDay()
  return dow === 0 || dow === 6
}

/** 08:00 of the next business (Mon–Fri) calendar day strictly after `day`. */
function nextBusinessDayStart(day: number): LocalDateTime {
  let next = day + DAY_MS
  while (isWeekend(next)) next += DAY_MS
  return { day: next, minuteOfDay: BUSINESS_START * 60 }
}

/**
 * Advances a local wall-clock time to the next moment within business hours
 * (Mon–Fri, 08:00–18:00). Already inside business hours → unchanged.
 */
function advanceToBusinessStart(local: LocalDateTime): LocalDateTime {
  if (isWeekend(local.day) || local.minuteOfDay >= BUSINESS_END * 60) {
    return nextBusinessDayStart(local.day)
  }
  if (local.minuteOfDay < BUSINESS_START * 60) {
    return { day: local.day, minuteOfDay: BUSINESS_START * 60 }
  }
  return local
}

/**
 * Calculates the deadline by adding `minutes` of (optionally business-hours)
 * time to `startedAt`.
 *
 * Business hours: Mon–Fri 08:00–18:00 local time in `timezone`. The
 * computation runs on the local calendar (day + minute-of-day) and is
 * converted to UTC once at the end, so a DST transition between start and
 * deadline does not shift the result by an hour. O(days), not O(minutes).
 */
export function calculateDeadline(
  startedAt: Date,
  minutes: number,
  businessHours: boolean,
  timezone: string,
): Date {
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`[sla:policy] calculateDeadline: invalid minutes ${String(minutes)}`)
  }
  if (!businessHours) {
    return new Date(startedAt.getTime() + minutes * 60_000)
  }

  let current   = advanceToBusinessStart(toLocal(startedAt, timezone))
  let remaining = minutes

  // Skip whole business days first (keeps the loop O(remaining days) but cheap).
  while (remaining > 0) {
    const minsLeftToday = BUSINESS_END * 60 - current.minuteOfDay

    if (remaining <= minsLeftToday) {
      current   = { day: current.day, minuteOfDay: current.minuteOfDay + remaining }
      remaining = 0
    } else {
      remaining -= minsLeftToday
      current = nextBusinessDayStart(current.day)
      // Fast-forward full days while more than a business day remains.
      while (remaining > MINUTES_PER_BUSINESS_DAY) {
        remaining -= MINUTES_PER_BUSINESS_DAY
        current = nextBusinessDayStart(current.day)
      }
    }
  }

  return fromLocal(current, timezone)
}
