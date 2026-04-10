import { getSession, runQuery } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { logger } from '../../lib/logger.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function toNum(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'number') return v
  if (typeof (v as { toNumber?: () => number }).toNumber === 'function')
    return (v as { toNumber: () => number }).toNumber()
  return Number(v)
}

const COLOR_MAP: Record<string, string> = {
  standard:  '#16a34a',
  normal:    '#0284c7',
  emergency: '#ef4444',
}

function colorForType(changeType: string): string {
  return COLOR_MAP[changeType?.toLowerCase()] ?? '#6b7280'
}

function durationMinutes(start: string | null, end: string | null): number | null {
  if (!start || !end) return null
  const ms = new Date(end).getTime() - new Date(start).getTime()
  return ms > 0 ? Math.round(ms / 60_000) : null
}

// ── changeCalendarEvents ────────────────────────────────────────────────────

interface CalendarEventsArgs {
  from: string
  to: string
}

async function changeCalendarEvents(_: unknown, args: CalendarEventsArgs, ctx: GraphQLContext) {
  const session = getSession()
  try {
    type Row = {
      id: string; title: string; changeType: string; status: string
      riskLevel: string | null; scheduledStart: string | null; scheduledEnd: string | null
      requiresDowntime: boolean | null; ciNames: string[]; teamName: string | null
    }
    const rows = await runQuery<Row>(session, `
      MATCH (c:Change {tenant_id: $tenantId})
      WHERE c.scheduled_start IS NOT NULL
        AND c.scheduled_start >= $from
        AND c.scheduled_start <= $to
      OPTIONAL MATCH (c)-[:AFFECTS]->(ci)
      OPTIONAL MATCH (c)-[:ASSIGNED_TO_TEAM]->(t:Team)
      RETURN c.id AS id, c.title AS title, c.type AS changeType, c.status AS status,
             c.priority AS riskLevel, c.scheduled_start AS scheduledStart,
             c.scheduled_end AS scheduledEnd,
             c.requires_downtime AS requiresDowntime,
             collect(DISTINCT ci.name) AS ciNames, t.name AS teamName
      ORDER BY c.scheduled_start ASC
    `, { tenantId: ctx.tenantId, from: args.from, to: args.to })

    logger.debug({ count: rows.length, tenantId: ctx.tenantId }, '[changeCalendar] events loaded')

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      changeType: r.changeType ?? 'normal',
      status: r.status,
      riskLevel: r.riskLevel,
      scheduledStart: r.scheduledStart,
      scheduledEnd: r.scheduledEnd,
      duration: durationMinutes(r.scheduledStart, r.scheduledEnd),
      ciNames: (r.ciNames ?? []).filter(Boolean),
      teamName: r.teamName,
      requiresDowntime: r.requiresDowntime ?? false,
      color: colorForType(r.changeType),
    }))
  } finally {
    await session.close()
  }
}

// ── changeCalendarConflicts ─────────────────────────────────────────────────

async function changeCalendarConflicts(_: unknown, args: CalendarEventsArgs, ctx: GraphQLContext) {
  const session = getSession()
  try {
    type Row = {
      c1Id: string; c1Title: string; c1Type: string; c1Status: string
      c1RiskLevel: string | null; c1Start: string | null; c1End: string | null
      c1Downtime: boolean | null
      c2Id: string; c2Title: string; c2Type: string; c2Status: string
      c2RiskLevel: string | null; c2Start: string | null; c2End: string | null
      c2Downtime: boolean | null
      sharedCIs: string[]
    }
    const rows = await runQuery<Row>(session, `
      MATCH (c1:Change {tenant_id: $tenantId})-[:AFFECTS]->(ci)<-[:AFFECTS]-(c2:Change {tenant_id: $tenantId})
      WHERE c1.id < c2.id
        AND c1.scheduled_start IS NOT NULL AND c2.scheduled_start IS NOT NULL
        AND c1.scheduled_start <= $to AND c2.scheduled_start <= $to
        AND (c1.scheduled_end IS NULL OR c1.scheduled_end >= $from)
        AND (c2.scheduled_end IS NULL OR c2.scheduled_end >= $from)
        AND (c1.scheduled_end IS NULL OR c1.scheduled_start <= c2.scheduled_end OR c2.scheduled_end IS NULL)
        AND (c2.scheduled_end IS NULL OR c2.scheduled_start <= c1.scheduled_end OR c1.scheduled_end IS NULL)
      WITH c1, c2, collect(DISTINCT ci.name) AS sharedCIs
      RETURN c1.id AS c1Id, c1.title AS c1Title, c1.type AS c1Type, c1.status AS c1Status,
             c1.priority AS c1RiskLevel, c1.scheduled_start AS c1Start, c1.scheduled_end AS c1End,
             c1.requires_downtime AS c1Downtime,
             c2.id AS c2Id, c2.title AS c2Title, c2.type AS c2Type, c2.status AS c2Status,
             c2.priority AS c2RiskLevel, c2.scheduled_start AS c2Start, c2.scheduled_end AS c2End,
             c2.requires_downtime AS c2Downtime,
             sharedCIs
    `, { tenantId: ctx.tenantId, from: args.from, to: args.to })

    logger.debug({ count: rows.length, tenantId: ctx.tenantId }, '[changeCalendar] conflicts found')

    return rows.map((r) => {
      const overlapStart = r.c1Start && r.c2Start
        ? (r.c1Start > r.c2Start ? r.c1Start : r.c2Start) : (r.c1Start ?? r.c2Start ?? '')
      const overlapEnd = r.c1End && r.c2End
        ? (r.c1End < r.c2End ? r.c1End : r.c2End) : (r.c1End ?? r.c2End ?? '')

      return {
        changeA: {
          id: r.c1Id, title: r.c1Title, changeType: r.c1Type ?? 'normal', status: r.c1Status,
          riskLevel: r.c1RiskLevel, scheduledStart: r.c1Start, scheduledEnd: r.c1End,
          duration: durationMinutes(r.c1Start, r.c1End),
          ciNames: [], teamName: null, requiresDowntime: r.c1Downtime ?? false,
          color: colorForType(r.c1Type),
        },
        changeB: {
          id: r.c2Id, title: r.c2Title, changeType: r.c2Type ?? 'normal', status: r.c2Status,
          riskLevel: r.c2RiskLevel, scheduledStart: r.c2Start, scheduledEnd: r.c2End,
          duration: durationMinutes(r.c2Start, r.c2End),
          ciNames: [], teamName: null, requiresDowntime: r.c2Downtime ?? false,
          color: colorForType(r.c2Type),
        },
        sharedCIs: r.sharedCIs ?? [],
        overlapStart,
        overlapEnd,
      }
    })
  } finally {
    await session.close()
  }
}

// ── changeCalendarSuggestedSlots ────────────────────────────────────────────

interface SuggestedSlotsArgs {
  duration: number
  ciIds?: string[] | null
  from: string
  to: string
}

async function changeCalendarSuggestedSlots(
  _: unknown, args: SuggestedSlotsArgs, ctx: GraphQLContext,
) {
  const { duration, from, to } = args
  const ciIds = args.ciIds ?? []
  const durationMs = duration * 60_000

  const session = getSession()
  try {
    // 1. Find existing change windows affecting the given CIs (or all if no CIs given)
    type BusyRow = { start: string; end: string }
    const busyQuery = ciIds.length > 0
      ? `
        MATCH (c:Change {tenant_id: $tenantId})-[:AFFECTS]->(ci)
        WHERE c.scheduled_start IS NOT NULL
          AND c.scheduled_start <= $to
          AND (c.scheduled_end IS NULL OR c.scheduled_end >= $from)
          AND ci.id IN $ciIds
        RETURN c.scheduled_start AS start, coalesce(c.scheduled_end, c.scheduled_start) AS end
      `
      : `
        MATCH (c:Change {tenant_id: $tenantId})
        WHERE c.scheduled_start IS NOT NULL
          AND c.scheduled_start <= $to
          AND (c.scheduled_end IS NULL OR c.scheduled_end >= $from)
        RETURN c.scheduled_start AS start, coalesce(c.scheduled_end, c.scheduled_start) AS end
      `
    const busyRows = await runQuery<BusyRow>(session, busyQuery, {
      tenantId: ctx.tenantId, from, to, ciIds,
    })

    const busyWindows = busyRows.map((r) => ({
      start: new Date(r.start).getTime(),
      end: new Date(r.end).getTime(),
    }))

    // 2. Generate candidate slots (every 2 hours)
    const TWO_HOURS = 2 * 60 * 60_000
    const fromMs = new Date(from).getTime()
    const toMs = new Date(to).getTime()

    interface Slot { start: number; end: number; score: number; reason: string }
    const candidates: Slot[] = []

    for (let t = fromMs; t + durationMs <= toMs; t += TWO_HOURS) {
      const slotStart = t
      const slotEnd = t + durationMs
      const dt = new Date(slotStart)
      const dayOfWeek = dt.getUTCDay() // 0=Sun, 6=Sat
      const hour = dt.getUTCHours()
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6
      const isNight = hour >= 22 || hour < 6

      // Check conflicts with busy windows
      const hasConflict = busyWindows.some(
        (w) => slotStart < w.end && slotEnd > w.start,
      )

      // Score: 100 max
      let score = 100
      const reasons: string[] = []

      if (hasConflict) {
        score -= 40
        reasons.push('conflicts with existing change')
      }
      if (!isWeekend) {
        score -= 10
        reasons.push('weekday')
      }
      if (!isNight) {
        score -= 15
        reasons.push('daytime hours')
      }
      if (isWeekend && isNight && !hasConflict) {
        reasons.push('weekend night, no conflicts — optimal')
      } else if (!hasConflict) {
        reasons.push('no conflicts')
      }

      candidates.push({
        start: slotStart,
        end: slotEnd,
        score,
        reason: reasons.join('; ') || 'available slot',
      })
    }

    // 3. Sort by score DESC and return top 10
    candidates.sort((a, b) => b.score - a.score)
    const top = candidates.slice(0, 10)

    logger.debug({ count: top.length, tenantId: ctx.tenantId }, '[changeCalendar] suggested slots')

    return top.map((s) => ({
      start: new Date(s.start).toISOString(),
      end: new Date(s.end).toISOString(),
      score: s.score,
      reason: s.reason,
    }))
  } finally {
    await session.close()
  }
}

// ── exports ─────────────────────────────────────────────────────────────────

export const changeCalendarResolvers = {
  Query: {
    changeCalendarEvents,
    changeCalendarConflicts,
    changeCalendarSuggestedSlots,
  },
}
