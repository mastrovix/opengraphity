/**
 * THE HISTORY OF THE MONITORED SERVICES (tour of 23 Sep 2026, D43).
 *
 * The maps are created with the product's own mutation, which evaluates them
 * «now»: every one of the thirty services was «Operational for 40 min» or
 * «Degraded for 47 min», born at the minute of the generation. A service
 * watched for two months has two months of health behind it: the map is
 * dated when it was set up, and its history (`ServiceHealthEntry`, trigger
 * `ci_health`) holds each change the alarms of its components caused — a
 * component that went down or degraded, and its return — as the engine
 * writes them (services/serviceImpact/engine.ts, history.ts). The health
 * the engine computed now stays; «since when» is the start of what caused it.
 *
 * The history starts from the health the service had when it was set up —
 * what its components' alarms were saying then, the ones that began before
 * it included — and the creation's own entry says that health: the next
 * entry leaves from it.
 */
import type { Session } from 'neo4j-driver'
import { runQuery } from '@opengraphity/neo4j'
import { MINUTE } from './clock.js'
import type { Rng } from './random.js'
import type { PlannedEvent } from './monitoring.js'
import { int, type DemoWriter } from './writer.js'

interface MapNode { ciId: string; name: string; label: string | null; weight: unknown; critical: boolean | null; propagate: string | null }

interface MapRow {
  id: string
  health: string
  nodes: MapNode[]
}

interface Interval { ciId: string; health: 'down' | 'degraded'; from: number; to: number | null }

const RANK: Record<string, number> = { operational: 0, degraded: 1, down: 2 }

/** The health of the service at a moment: the worst of what fires on its components then, and what fires. */
export function healthAt(intervals: readonly Interval[], atMs: number): { health: string; causes: Interval[] } {
  const causes = intervals.filter((i) => i.from <= atMs && (i.to === null || i.to > atMs))
  return { health: causes.reduce((w, i) => (RANK[i.health]! > RANK[w]! ? i.health : w), 'operational'), causes }
}

/**
 * When the service was in which health after `fromMs`, from its components'
 * alarms: one entry per change, the first leaving from the health it had at
 * `fromMs`, none after `nowMs`.
 */
export function healthTimeline(intervals: readonly Interval[], fromMs: number, nowMs: number): Array<{ at: number; health: string; previous: string; causes: Interval[] }> {
  const moments = [...new Set(intervals.flatMap((i) => [i.from, i.to ?? nowMs + 1]).filter((t) => t > fromMs && t <= nowMs))].sort((a, b) => a - b)
  const out: Array<{ at: number; health: string; previous: string; causes: Interval[] }> = []
  let current = healthAt(intervals, fromMs).health
  for (const at of moments) {
    const { health, causes } = healthAt(intervals, at)
    if (health === current) continue
    out.push({ at, health, previous: current, causes })
    current = health
  }
  return out
}

/**
 * The spans in which an alarm gave its CI a health, at the severity it had
 * then (ciHealth.ts): from its first sighting — or from when the engine
 * lifted it from a release, since a silenced alarm gives none — to its
 * clearing; a certificate warns first and turns critical in its last week.
 * One silenced until it cleared gives none at all.
 */
export function alarmSpans(e: PlannedEvent): Array<{ severity: string; from: number; to: number | null }> {
  if (e.correlation === 'suppressed') return []
  const start = e.history.reduce((t, h) => (h.kind === 'unsuppressed' ? Math.max(t, h.atMs) : t), e.firstSeenAtMs)
  const levels = e.history.filter((h) => h.kind === 'first_seen' || h.kind === 'severity_changed')
  return levels.flatMap((h, i) => {
    const from = Math.max(h.atMs, start)
    const to = levels[i + 1]?.atMs ?? e.resolvedAtMs
    return to !== null && to <= from ? [] : [{ severity: h.severity ?? e.severity, from, to }]
  })
}

/** What the alarms of the period said about each CI: the spans still open at the setting up or after it. */
function spansByCI(events: readonly PlannedEvent[], createdAtMs: number): Map<string, Array<{ severity: string; from: number; to: number | null }>> {
  const byCI = new Map<string, Array<{ severity: string; from: number; to: number | null }>>()
  for (const e of events) {
    const spans = alarmSpans(e).filter((s) => s.severity !== 'info' && (s.to === null || s.to > createdAtMs))
    if (spans.length) byCI.set(e.ciId, [...(byCI.get(e.ciId) ?? []), ...spans])
  }
  return byCI
}

/** The causes as the engine stores them (`StoredCause`, history.ts), and the impact score it keeps as an integer. */
function storedCauses(causes: readonly Interval[], nodeOf: ReadonlyMap<string, MapNode>): { cause: string; score: number } {
  const stored = causes.map((c) => {
    const n = nodeOf.get(c.ciId)!
    const ref = { id: c.ciId, name: n.name, type: n.label ?? 'ConfigurationItem', health: c.health }
    return { ciId: c.ciId, health: c.health, weight: Number(n.weight ?? 1), critical: n.critical === true, ci: ref, path: [ref] }
  })
  const score = Math.min(100, Math.round(stored.reduce((s, c) => s + (c.health === 'down' ? 40 : 15) * Math.max(1, c.weight / 5), 0)))
  return { cause: JSON.stringify(stored), score }
}

export async function backfillServiceHistory(
  session: Session, w: DemoWriter, rng: Rng, events: readonly PlannedEvent[], createdAtMs: number, nowMs: number,
): Promise<number> {
  const maps = await runQuery<MapRow>(session, `
    MATCH (m:ServiceMap {tenant_id: $tenantId}) WHERE m.demo_run_id = $runId
    OPTIONAL MATCH (m)-[r:INCLUDES]->(ci:ConfigurationItem {tenant_id: $tenantId})
    RETURN m.id AS id, m.health AS health,
           collect({ciId: ci.id, name: ci.name, label: head([l IN labels(ci) WHERE l <> 'ConfigurationItem']),
                    weight: r.weight, critical: r.critical, propagate: r.propagate}) AS nodes`,
  { tenantId: w.tenantId, runId: w.runId })
  const byCI = spansByCI(events, createdAtMs)
  const entries: Array<{ mapId: string; props: Record<string, unknown> }> = []
  const setUp: Array<{ id: string; since: string; health: string; score: number; cause: string }> = []
  for (const m of maps) {
    const nodes = m.nodes.filter((n) => n.ciId && n.propagate !== 'never')
    const nodeOf = new Map(nodes.map((n) => [n.ciId, n]))
    // A critical alarm takes a critical component down; anything else degrades it.
    const intervals: Interval[] = nodes.flatMap((n) => (byCI.get(n.ciId) ?? []).map((s) => ({
      ciId: n.ciId, health: s.severity === 'critical' && n.critical === true ? 'down' as const : 'degraded' as const, from: s.from, to: s.to,
    })))
    const timeline = healthTimeline(intervals, createdAtMs, nowMs)
    for (const change of timeline) {
      const { cause, score } = storedCauses(change.causes, nodeOf)
      entries.push({ mapId: m.id, props: {
        id: rng.uuid(), map_id: m.id, at: new Date(change.at).toISOString(), health: change.health, previous_health: change.previous,
        // `toInteger` in the engine: an integer here too.
        impact_score: int(score), cause, trigger: 'ci_health', note: null,
      } })
    }
    const start = healthAt(intervals, createdAtMs)
    // «Since when»: the last change that led to the health the engine computed now, or the setting up of the map.
    const last = [...timeline].reverse().find((c) => c.health === m.health)
    setUp.push({ id: m.id, since: new Date(last ? last.at : createdAtMs + MINUTE).toISOString(), health: start.health, ...storedCauses(start.causes, nodeOf) })
  }
  const created = new Date(createdAtMs).toISOString()
  await session.executeWrite((tx) => tx.run(`
    UNWIND $rows AS row
    MATCH (m:ServiceMap {id: row.id, tenant_id: $tenantId})
    SET m.created_at = $created, m.health_since = row.since
    WITH m, row
    OPTIONAL MATCH (m)-[:HAS_HEALTH_HISTORY]->(h:ServiceHealthEntry {tenant_id: $tenantId})
    // The map's first entry is its setting up, with the health it had then; what the creation evaluated «now» is the history's last word, rewritten below.
    FOREACH (_ IN CASE WHEN h.trigger = 'created' THEN [1] ELSE [] END |
      SET h.at = $created, h.health = row.health, h.impact_score = toInteger(row.score), h.cause = row.cause)
    FOREACH (_ IN CASE WHEN h IS NOT NULL AND h.trigger <> 'created' THEN [1] ELSE [] END | DETACH DELETE h)`,
  { rows: setUp, tenantId: w.tenantId, created }))
  await w.children('ServiceMap', 'HAS_HEALTH_HISTORY', ['ServiceHealthEntry'], entries.map((e) => ({ parent: e.mapId, props: e.props })))
  return entries.length
}
