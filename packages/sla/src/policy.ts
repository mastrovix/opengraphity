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

export const DEFAULT_SLA_POLICIES: SLAPolicy[] = [
  {
    id: 'default-incident-sla',
    tenant_id: '*',
    name: 'Default Incident SLA',
    entity_type: 'incident',
    timezone: 'Europe/Rome',
    tiers: [
      { severity: 'critical', response_minutes: 15,   resolve_minutes: 240,  business_hours: false },
      { severity: 'high',     response_minutes: 60,   resolve_minutes: 480,  business_hours: false },
      { severity: 'medium',   response_minutes: 240,  resolve_minutes: 1440, business_hours: true  },
      { severity: 'low',      response_minutes: 480,  resolve_minutes: 4320, business_hours: true  },
    ],
  },
  {
    id: 'default-problem-sla',
    tenant_id: '*',
    name: 'Default Problem SLA',
    entity_type: 'problem',
    timezone: 'Europe/Rome',
    tiers: [
      { severity: 'critical', response_minutes: 60,  resolve_minutes: 2880, business_hours: false },
      { severity: 'high',     response_minutes: 240, resolve_minutes: 7200, business_hours: true  },
    ],
  },
  {
    id: 'default-request-sla',
    tenant_id: '*',
    name: 'Default Service Request SLA',
    entity_type: 'service_request',
    timezone: 'Europe/Rome',
    tiers: [
      { severity: 'high',   response_minutes: 240,  resolve_minutes: 1440, business_hours: true },
      { severity: 'medium', response_minutes: 480,  resolve_minutes: 4320, business_hours: true },
      { severity: 'low',    response_minutes: 1440, resolve_minutes: 7200, business_hours: true },
    ],
  },
  {
    id: 'default-change-sla',
    tenant_id: '*',
    name: 'Default Change SLA',
    entity_type: 'change',
    timezone: 'Europe/Rome',
    // Deadline is determined dynamically from window_end, not from tiers
    tiers: [
      { severity: 'any', response_minutes: 0, resolve_minutes: 0, business_hours: false },
    ],
  },
]

// ── Business hours helpers ───────────────────────────────────────────────────

const BUSINESS_START = 8   // 08:00
const BUSINESS_END   = 18  // 18:00

interface LocalTime {
  hour: number
  minute: number
  dayOfWeek: number // 0=Sun … 6=Sat
}

function getLocalTime(date: Date, timezone: string): LocalTime {
  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour:     'numeric',
    minute:   'numeric',
    hour12:   false,
  })
  const dayFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday:  'long',
  })

  const parts    = timeFmt.formatToParts(date)
  const rawHour  = parseInt(parts.find((p) => p.type === 'hour')?.value   ?? '0', 10)
  const minute   = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10)
  // hour12:false may return 24 for midnight
  const hour     = rawHour === 24 ? 0 : rawHour

  const DAY_MAP: Record<string, number> = {
    Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
    Thursday: 4, Friday: 5, Saturday: 6,
  }
  const dayOfWeek = DAY_MAP[dayFmt.format(date)] ?? 1

  return { hour, minute, dayOfWeek }
}

/**
 * Advances `date` to the next moment that is within business hours
 * (Mon–Fri, 08:00–18:00 in the given timezone). If already in business
 * hours, returns the same date unchanged.
 */
function advanceToBusinessStart(date: Date, timezone: string): Date {
  let current = date

  // Safety: max 14 iterations (never loops more than 2 weeks)
  for (let i = 0; i < 14; i++) {
    const { hour, minute, dayOfWeek } = getLocalTime(current, timezone)

    if (dayOfWeek === 6) {
      // Saturday → Monday 08:00: 2 days minus elapsed + 8h
      current = new Date(
        current.getTime() + ((2 * 24 - hour) * 60 - minute + BUSINESS_START * 60) * 60_000,
      )
      continue
    }

    if (dayOfWeek === 0) {
      // Sunday → Monday 08:00: 1 day minus elapsed + 8h
      current = new Date(
        current.getTime() + ((1 * 24 - hour) * 60 - minute + BUSINESS_START * 60) * 60_000,
      )
      continue
    }

    if (hour < BUSINESS_START) {
      // Before 08:00 on a weekday → advance to 08:00
      current = new Date(
        current.getTime() + ((BUSINESS_START - hour) * 60 - minute) * 60_000,
      )
      break
    }

    if (hour >= BUSINESS_END) {
      // After 18:00 on a weekday → advance to next day 08:00
      current = new Date(
        current.getTime() + ((24 - hour) * 60 - minute + BUSINESS_START * 60) * 60_000,
      )
      continue // re-check: next day might be weekend
    }

    // Already in business hours
    break
  }

  return current
}

/**
 * Calculates the deadline by adding `minutes` of (optionally business-hours)
 * time to `startedAt`.
 *
 * Business hours: Mon–Fri 08:00–18:00 local time in `timezone`.
 * Algorithm is O(days), not O(minutes).
 */
export function calculateDeadline(
  startedAt: Date,
  minutes: number,
  businessHours: boolean,
  timezone: string,
): Date {
  if (!businessHours) {
    return new Date(startedAt.getTime() + minutes * 60_000)
  }

  let current   = advanceToBusinessStart(startedAt, timezone)
  let remaining = minutes

  while (remaining > 0) {
    const { hour, minute } = getLocalTime(current, timezone)
    const minsLeftToday    = BUSINESS_END * 60 - (hour * 60 + minute)

    if (remaining <= minsLeftToday) {
      current   = new Date(current.getTime() + remaining * 60_000)
      remaining = 0
    } else {
      remaining -= minsLeftToday
      // Jump past end of business day, then advance to next business start
      current = new Date(current.getTime() + minsLeftToday * 60_000)
      current = advanceToBusinessStart(current, timezone)
    }
  }

  return current
}
