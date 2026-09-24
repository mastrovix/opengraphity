/**
 * THE MONITORING OF THREE YEARS (22-23 Sep 2026).
 *
 * The tenant has three sources — Prometheus (through Alertmanager), Grafana
 * and Dynatrace — and they alarm on what those tools really watch:
 *
 *  - PROMETHEUS the infrastructure it scrapes: servers (cpu, memory, disk,
 *    host down) and database instances (connections, replication, instance
 *    down), plus the blackbox probe on the CERTIFICATES;
 *  - DYNATRACE the applications, because APM is what it is for: response
 *    time, failure rate, service down — and the database services behind;
 *  - GRAFANA what a dashboard alerts on: thresholds and SLOs over
 *    applications and databases (error budget, latency, missed backup).
 *
 * ## Every alarm gets the outcome the engine would have given it
 * The first version wrote the alarms with `correlation: 'none'`, which for
 * the engine means "nobody has looked at this yet". Its periodic safety net
 * (`reevaluatePendingEvents`) picked them up three minutes after the run and
 * did what the tenant policy says: warnings skipped, criticals turned into
 * five brand-new incidents — unmarked, dated "now", surviving `--clean`. The
 * engine was right; the simulation was lying about the past. So here each
 * alarm carries the outcome of the pipeline (services/events/pipeline.ts) at
 * the moment it fired, in its order:
 *
 *   1. a change deploying on that CI         → `suppressed`, SUPPRESSED_BY it,
 *      until the release ends: cleared by then it stays silenced (and
 *      resolved); still firing, the engine lifts it when the release ends
 *      (`reevaluateSuppressedEvents`, passes.ts) and decides it then;
 *   2. below `open_incident_from`            → `skipped_severity` (`never`:
 *      always — the product's `meetsOpenThreshold`, grouping.ts);
 *   3. an incident already open on the CI    → `attached` (group_by: ci);
 *   4. otherwise                             → `opened`: an INCIDENT IS BORN
 *      from the alarm, and when the alarm clears the engine resolves it on
 *      its own (`auto_resolve`), unless a person fixed it first.
 *
 * No alarm is left silenced: at the end of its release the engine would
 * decide it after the run, dated then (verify.ts refuses a silenced alarm).
 *
 * ## Retention is the tenant's, not ours
 * The policy keeps alarms `retention_days` (90 by default) and the nightly
 * job deletes the older ones — except those linked to an incident or a change
 * still open — leaving a counter on what they were linked to
 * (`Incident.correlated_events_purged`, `Change.suppressed_events_purged`).
 * Writing three years of alarms would be writing data the product throws
 * away the same night. So the alarms of the last `retention_days` exist, and
 * the older ones exist only as what they left behind: the incidents they
 * opened, and those counters.
 *
 * ## The certificates are not invented
 * A certificate CI carries its own `expires_at`. The probe starts warning
 * thirty days before it, turns critical in the last week — and that is the
 * moment the engine opens an incident — and the alarm clears when the
 * certificate is renewed. A production certificate is renewed within days of
 * its expiry at the latest (D38: some kept firing for months after it).
 *
 * ## As the tools send them, as the product stores them (tour of 23 Sep 2026)
 *  - the title is what the connector reads: the `alertname` for Prometheus
 *    and Grafana, the problem title for Dynatrace; the resource is the tool's
 *    own name for the thing, found through the CI's aliases (D37, toolNames.ts);
 *  - the occurrences are the tool's repeats: Alertmanager and Grafana re-send
 *    a firing alert every four hours, Dynatrace only on a change (D35);
 *  - the first sighting carries its severity (D41), the correlation its own
 *    instant (D40), and nothing happens after «now» (D46);
 *  - a missed backup is information, not an outage (D45);
 *  - a critical alarm that opens an incident is taken in minutes and mostly
 *    cleared within the working day (D63).
 */
import type { Rng } from './random.js'
import type { World } from './world.js'
import type { PlannedCI, CILabel } from './cmdb.js'
import { arrivalInstants, lifetimes, type Lifetime } from './arrivals.js'
import { DAY, HOUR, MINUTE } from './clock.js'
import type { ToolIdentity, ToolNames } from './toolNames.js'
import { OPEN_INCIDENT_FROM } from '../../eventVocabularies.js'

/** The three tools, as the product knows them (`InboundWebhook.connector_kind`). */
export const MONITORING_SOURCES = [
  { key: 'prometheus', name: 'Prometheus (Alertmanager)', connectorKind: 'alertmanager' },
  { key: 'grafana', name: 'Grafana', connectorKind: 'grafana' },
  { key: 'dynatrace', name: 'Dynatrace', connectorKind: 'dynatrace' },
] as const

export type SourceKey = typeof MONITORING_SOURCES[number]['key']

interface AlarmKind {
  source: SourceKey
  on: CILabel
  /** The title the connector reads: `alertname` (Prometheus, Grafana) or the problem title (Dynatrace). */
  name: string
  /** The summary annotation: `{resource}` is the tool's name for the thing. */
  summary: string
  description: string
  /** Share of this alarm's cycles that reach `critical` (the rest are warnings). */
  critical: number
  /** The severity of the cycles that are not critical (default `warning`). */
  base?: 'warning' | 'info'
  life: Lifetime
  weight: number
}

const SHORT: Lifetime = { medianHours: 0.6, spread: 1.2, stuckShare: 0.04, stuckMedianDays: 3 }
const MEDIUM: Lifetime = { medianHours: 4, spread: 1.1, stuckShare: 0.06, stuckMedianDays: 6 }
const LONG: Lifetime = { medianHours: 26, spread: 1.0, stuckShare: 0.1, stuckMedianDays: 21 }
/**
 * A CRITICAL alarm that opened an incident (D63): the on-call engineer is on
 * it, and most are cleared or fixed within hours — the P2 resolution target
 * is eight. A few drag on for days.
 */
const CRITICAL_LIFE: Lifetime = { medianHours: 1.5, spread: 0.9, stuckShare: 0.03, stuckMedianDays: 2 }

/**
 * Most alarms are warnings: that is what a tuned estate looks like, and it is
 * what keeps the incidents born from monitoring at a believable share of the
 * incident volume instead of drowning the service desk.
 */
export const ALARM_KINDS: readonly AlarmKind[] = [
  // ── Prometheus: the infrastructure it scrapes ────────────────────────────
  { source: 'prometheus', on: 'Server', name: 'HostHighCpuLoad', summary: 'CPU above 90% for 15 minutes on {resource}',
    description: 'The 5-minute load average has been above the number of cores for 15 minutes.', critical: 0.05, life: MEDIUM, weight: 16 },
  { source: 'prometheus', on: 'Server', name: 'HostOutOfMemory', summary: 'Available memory below 8% on {resource}',
    description: 'Free memory has been under 8% for 10 minutes; the kernel has started reclaiming.', critical: 0.1, life: MEDIUM, weight: 12 },
  { source: 'prometheus', on: 'Server', name: 'HostDiskWillFillIn4Hours', summary: 'Filesystem of {resource} fills up within 4 hours',
    description: 'At the current rate the filesystem fills up within four hours.', critical: 0.12, life: LONG, weight: 11 },
  { source: 'prometheus', on: 'Server', name: 'HostDown', summary: '{resource} is not answering the scrape',
    description: 'The exporter has not answered for 3 minutes: the host is unreachable or the agent is down.', critical: 1, life: SHORT, weight: 1.5 },
  { source: 'prometheus', on: 'Server', name: 'NodeFilesystemReadOnly', summary: 'Filesystem mounted read-only on {resource}',
    description: 'A filesystem went read-only: usually the storage underneath.', critical: 1, life: MEDIUM, weight: 0.8 },
  { source: 'prometheus', on: 'DatabaseInstance', name: 'PostgresTooManyConnections', summary: 'Connections above 90% of the limit on {resource}',
    description: 'The instance is close to max_connections: new sessions are about to be refused.', critical: 0.08, life: MEDIUM, weight: 8 },
  { source: 'prometheus', on: 'DatabaseInstance', name: 'DatabaseReplicationLag', summary: 'Replication lag above 5 minutes on {resource}',
    description: 'The standby is behind the primary by more than five minutes.', critical: 0.08, life: LONG, weight: 6 },
  { source: 'prometheus', on: 'DatabaseInstance', name: 'DatabaseInstanceDown', summary: '{resource} does not accept connections',
    description: 'The listener does not answer: the instance is down or is refusing connections.', critical: 1, life: SHORT, weight: 0.8 },

  // ── Dynatrace: the applications ──────────────────────────────────────────
  { source: 'dynatrace', on: 'Application', name: 'Response time degradation', summary: 'Response time of {resource} above the baseline',
    description: 'The median response time is more than three times the usual baseline.', critical: 0.05, life: MEDIUM, weight: 14 },
  { source: 'dynatrace', on: 'Application', name: 'Failure rate increase', summary: 'Failure rate of {resource} above 5%',
    description: 'One request in twenty is failing: the rate has tripled against the baseline.', critical: 0.1, life: MEDIUM, weight: 12 },
  { source: 'dynatrace', on: 'Application', name: 'Service unavailable', summary: '{resource} is not answering',
    description: 'Every request to the service fails: the process is down or the pool is exhausted.', critical: 1, life: SHORT, weight: 1.2 },
  { source: 'dynatrace', on: 'Database', name: 'Slow database statements', summary: 'Slow statements on {resource}',
    description: 'The statements of this database are over their usual time by an order of magnitude.', critical: 0.04, life: MEDIUM, weight: 6 },

  // ── Grafana: thresholds and SLOs on the dashboards ───────────────────────
  { source: 'grafana', on: 'Application', name: 'ErrorBudgetBurnRate', summary: 'Error budget of {resource} burning too fast',
    description: 'At this rate the monthly error budget of the service ends in two days.', critical: 0.04, life: LONG, weight: 7 },
  { source: 'grafana', on: 'Application', name: 'LatencySLOBreach', summary: '95th percentile of {resource} over the SLO',
    description: 'The 95th percentile has been above the promised threshold for thirty minutes.', critical: 0.03, life: MEDIUM, weight: 6 },
  // D45: a missed backup is information for the DBAs, not an outage of the database.
  { source: 'grafana', on: 'Database', name: 'BackupNotSeen', summary: 'No backup of {resource} in the last 26 hours',
    description: 'The daily backup has not been seen: either the job did not run or it did not report.', critical: 0, base: 'info', life: LONG, weight: 5 },
  { source: 'grafana', on: 'Database', name: 'TablespaceUsageHigh', summary: 'Space of {resource} above 90%',
    description: 'The data files are over 90% of the space they are allowed to take.', critical: 0.08, life: LONG, weight: 4 },
]

const CERT = { source: 'prometheus' as SourceKey, name: 'SSLCertExpiringSoon' }
/** How long before the expiry the blackbox probe starts complaining. */
export const CERT_WARNING_DAYS = 30
/** And when it turns critical: from here the engine opens an incident. */
export const CERT_CRITICAL_DAYS = 7

/** The ranks `open_incident_from` compares (`SEVERITY_RANK`, services/events/shared.ts). */
const SEVERITY_RANK: Readonly<Record<string, number>> = { info: 0, warning: 1, critical: 2 }

/**
 * Whether the pipeline lets an alarm of this severity open or join an
 * incident: the product's own rule, `meetsOpenThreshold`
 * (services/events/grouping.ts) — `never` lets none through, otherwise the
 * severity must reach the threshold. Below it the alarm is `skipped_severity`
 * and joins nothing either. A threshold the Event Policy does not know, or a
 * severity that is not an alarm's, stops the plan.
 */
export function alarmMeetsThreshold(severity: string, openFrom: string): boolean {
  if (!(OPEN_INCIDENT_FROM as readonly string[]).includes(openFrom)) {
    throw new Error(`planMonitoring: open_incident_from "${openFrom}" is not a threshold of the Event Policy (${OPEN_INCIDENT_FROM.join(', ')})`)
  }
  const rank = SEVERITY_RANK[severity]
  if (rank === undefined) throw new Error(`planMonitoring: "${severity}" is not an alarm severity`)
  return openFrom !== 'never' && rank >= SEVERITY_RANK[openFrom]!
}

/** The health a severity means, as the factory `ci_health` matrix says. */
const HEALTH_BY_SEVERITY: Record<string, string> = { critical: 'down', warning: 'degraded', info: 'operational' }
/** How often a tool re-sends an alert that keeps firing (Alertmanager and Grafana default repeat interval). */
const REPEAT_INTERVAL = 4 * HOUR

// ── What the planner takes and gives ───────────────────────────────────────

export interface MonitoringPolicy {
  /** `event_policy.retention_days` of the tenant (0 = never). */
  retentionDays: number
  /** `event_policy.open_incident_from`: the lowest severity that opens an incident. */
  openFrom: string
  /** `event_policy.auto_resolve`. */
  autoResolve: boolean
}

/** An incident open on a CI for a while (someone else's, or born from an alarm). */
export interface IncidentWindow {
  id: string
  ciId: string
  fromMs: number
  toMs: number
}

/** A change releasing on some CIs: an alarm there is silenced. */
export interface DeployWindow {
  changeId: string
  ciIds: readonly string[]
  startMs: number
  endMs: number
}

export interface MonitoringInput {
  /** Alarm cycles over the whole period, all severities (only the retained ones become nodes). */
  alarmCycles: number
  /** Incidents born from an alarm over the period (they are part of the incident count). */
  openedTarget: number
  /** Of the other incidents on a monitored CI, the share that had a critical alarm attached. */
  attachShare: number
  humanWindows: readonly IncidentWindow[]
  deployWindows: readonly DeployWindow[]
  policy: MonitoringPolicy
  /** How each tool names each CI (toolNames.ts). */
  names: ToolNames
}

export interface PlannedEventHistory {
  kind: string
  atMs: number
  outcome?: string | null
  incidentId?: string | null
  changeId?: string | null
  note?: string | null
  severity?: string | null
}

export interface PlannedEvent {
  id: string
  sourceKey: SourceKey
  ciId: string
  fingerprint: string
  externalId: string
  alertName: string
  title: string
  description: string
  severity: string
  maxSeverity: string
  status: 'firing' | 'resolved' | 'suppressed'
  firstSeenAtMs: number
  lastSeenAtMs: number
  resolvedAtMs: number | null
  count: number
  /** The tool's name for the thing, and what kind of name it is (the connector's `RESOURCE_KINDS`). */
  resource: string
  resourceKind: 'hostname' | 'name'
  /** Dynatrace's entity id: the product matches it with the `external_id` alias. */
  resourceExternalId: string | null
  matchReason: 'alias' | 'alias_external_id'
  labels: Record<string, string>
  correlation: 'opened' | 'attached' | 'skipped_severity' | 'suppressed'
  /** When the pipeline decided (D40: it was written as the first sighting). */
  correlatedAtMs: number
  incidentId: string | null
  suppressedByChangeId: string | null
  /** When a release first silenced it (the date of its SUPPRESSED_BY edge); null if none did. */
  suppressedAtMs: number | null
  history: PlannedEventHistory[]
}

/** An incident the engine opened from an alarm, and what happened to it. */
export interface BornIncident {
  incidentId: string
  ciId: string
  eventId: string
  /** The alarm's own words: the engine copies them into the incident. */
  title: string
  alarmDescription: string
  resource: string
  resourceKind: string
  count: number
  firstSeenMs: number
  lastSeenMs: number
  /** When the alarm cleared; null = still firing today. */
  clearedAtMs: number | null
  /** When the support team took it; null = nobody touched it before it cleared. */
  takenAtMs: number | null
  /** When a person resolved it before the alarm cleared; null = the engine closed it. */
  fixedAtMs: number | null
}

export interface MonitoringPlan {
  /** The alarms still in the database today (the policy deleted the others). */
  events: PlannedEvent[]
  born: BornIncident[]
  purgedByIncident: Map<string, number>
  purgedByChange: Map<string, number>
  /** The health of each CI an alarm looked at: `atMs` the last event, `sinceMs` when this health began. */
  health: Array<{ ciId: string; health: string; atMs: number; sinceMs: number }>
}

// ── The planner ─────────────────────────────────────────────────────────────

/** The occurrences a tool sends for one alarm cycle (D35: the old cap of 400 was the generator's, not a tool's). */
export function occurrences(rng: Rng, source: SourceKey, firstSeenMs: number, lastSeenMs: number): number {
  const lasted = Math.max(0, lastSeenMs - firstSeenMs)
  // Dynatrace notifies a problem when it opens and when it changes, not on a timer.
  if (source === 'dynatrace') return 1 + (lasted > HOUR ? rng.int(0, 2) : 0)
  return 1 + Math.floor(lasted / REPEAT_INTERVAL)
}

class MonitoringPlanner {
  readonly cycles: PlannedEvent[] = []
  readonly born: BornIncident[] = []
  private readonly windows = new Map<string, IncidentWindow[]>()
  private readonly deployOn = new Map<string, DeployWindow[]>()
  readonly now: number
  readonly cutoff: number

  constructor(readonly rng: Rng, readonly w: World, readonly input: MonitoringInput) {
    // The threshold is checked once, here, instead of on the ten-thousandth alarm.
    alarmMeetsThreshold('critical', input.policy.openFrom)
    this.now = w.clock.nowMs
    this.cutoff = input.policy.retentionDays > 0 ? this.now - input.policy.retentionDays * DAY : Number.NEGATIVE_INFINITY
    for (const win of input.humanWindows) this.addWindow(win)
    for (const d of input.deployWindows) for (const ci of d.ciIds) this.deployOn.set(ci, [...(this.deployOn.get(ci) ?? []), d])
  }

  private addWindow(win: IncidentWindow): void { this.windows.set(win.ciId, [...(this.windows.get(win.ciId) ?? []), win]) }
  /** `toMs` is when the incident was RESOLVED (or now): an alarm inside that span is attached to it (group_by: ci). */
  openOn(ciId: string, atMs: number): IncidentWindow | undefined {
    return (this.windows.get(ciId) ?? []).find((x) => x.fromMs <= atMs && atMs <= x.toMs)
  }
  /**
   * Between the resolution and the 72-hour close the engine does not attach:
   * it REOPENS the resolved incident. Nothing new is planted there, so the
   * simulation never has to pretend a reopening it did not write.
   */
  inReopenTail(ciId: string, atMs: number): boolean {
    return (this.windows.get(ciId) ?? []).some((x) => x.toMs < atMs && atMs <= x.toMs + 72 * HOUR)
  }
  deployingOn(ciId: string, atMs: number): DeployWindow | undefined {
    return (this.deployOn.get(ciId) ?? []).find((d) => d.startMs <= atMs && atMs <= d.endMs)
  }
  private opens(severity: string): boolean {
    return alarmMeetsThreshold(severity, this.input.policy.openFrom)
  }

  /**
   * The releases that silence an alarm fired at `atMs` (suppression.ts), one
   * after the other: a release silences it until it ends; still firing then,
   * the engine lifts it (`reevaluateSuppressedEvents`, passes.ts) — and a
   * release running at that moment silences it again. `decideAtMs` is when
   * the pipeline gets to decide it: `atMs` when no release runs, null when it
   * cleared while silenced.
   */
  silences(ciId: string, atMs: number, clearedAtMs: number | null): { releases: Array<{ d: DeployWindow; fromMs: number }>; decideAtMs: number | null } {
    const releases: Array<{ d: DeployWindow; fromMs: number }> = []
    let at = atMs
    for (let d = this.deployingOn(ciId, at); d; d = this.deployingOn(ciId, at)) {
      releases.push({ d, fromMs: at })
      if (clearedAtMs !== null && clearedAtMs <= d.endMs) return { releases, decideAtMs: null }
      at = d.endMs + MINUTE
    }
    return { releases, decideAtMs: at }
  }

  /**
   * An alarm a release would still keep silenced now: the engine would lift
   * it after the run and decide it then — a critical one opening an incident
   * dated «now». verify.ts refuses any silenced alarm for that reason.
   */
  stillSilenced(ciId: string, atMs: number, clearedAtMs: number | null): boolean {
    const { releases, decideAtMs } = this.silences(ciId, atMs, clearedAtMs)
    return releases.length > 0 && decideAtMs !== null && decideAtMs > this.now - MINUTE
  }

  /** One alarm cycle as the connector turns it into an event (normalize.ts), capped at «now» (D46). */
  newEvent(ci: PlannedCI, kind: Pick<AlarmKind, 'source' | 'name' | 'summary' | 'description'>, severity: string, firstSeenAtMs: number, clearedAtMs: number | null, firstSeverity = severity): PlannedEvent {
    const rng = this.rng
    const first = Math.min(firstSeenAtMs, this.now - 2 * MINUTE)
    const cleared = clearedAtMs === null ? null : Math.min(Math.max(clearedAtMs, first + MINUTE), this.now - MINUTE)
    const lastSeen = cleared ?? Math.max(first, this.now - rng.int(1, 30) * MINUTE)
    const tool = this.input.names.byCI.get(ci.id) ?? {}
    const r = resourceOf(kind.source, ci, tool)
    const hex = (n: number): string => Array.from({ length: n }, () => rng.int(0, 15).toString(16)).join('')
    const externalId = kind.source === 'dynatrace' ? `-${String(rng.int(1e9, 9e9))}${String(rng.int(1e8, 9e8))}_${String(first)}V2` : hex(16)
    return {
      id: rng.uuid(), sourceKey: kind.source, ciId: ci.id,
      fingerprint: `${kind.source}:${externalId}`, externalId,
      alertName: kind.name, title: kind.name,
      description: [kind.summary.replace('{resource}', r.resource), kind.description].join('\n'),
      severity, maxSeverity: severity,
      status: cleared === null ? 'firing' : 'resolved',
      firstSeenAtMs: first, lastSeenAtMs: lastSeen, resolvedAtMs: cleared,
      count: occurrences(rng, kind.source, first, lastSeen),
      resource: r.resource, resourceKind: r.resourceKind, resourceExternalId: r.resourceExternalId, matchReason: r.matchReason,
      labels: labelsOf(kind.source, kind.name, severity, ci, r, tool),
      correlation: 'skipped_severity', correlatedAtMs: first, incidentId: null, suppressedByChangeId: null, suppressedAtMs: null,
      history: [{ kind: 'first_seen', atMs: first, severity: firstSeverity }],
    }
  }

  /**
   * The pipeline's decision for one alarm, at the moment it reached the
   * severity it has (for a certificate: the day it turned critical). An alarm
   * the releases would still keep silenced now is a planning error: the
   * callers do not plant one (verify.ts would refuse it).
   */
  decide(ev: PlannedEvent, atMs: number, attachTo?: IncidentWindow): void {
    const rng = this.rng
    const { releases, decideAtMs } = this.silences(ev.ciId, atMs, ev.resolvedAtMs)
    if (releases.length > 0 && decideAtMs !== null && decideAtMs > this.now - MINUTE) {
      throw new Error(`planMonitoring: ${ev.alertName} on CI ${ev.ciId} would still be silenced now by change ${releases[releases.length - 1]!.d.changeId}: the engine would decide it after the run`)
    }
    const decidedAt = Math.min((decideAtMs ?? atMs) + rng.int(5, 90) * 1000, this.now - MINUTE)
    releases.forEach(({ d, fromMs }, i) => {
      const silencedAt = Math.min(fromMs + rng.int(1, 30) * 1000, this.now - MINUTE)
      ev.correlation = 'suppressed'
      ev.correlatedAtMs = silencedAt
      ev.suppressedByChangeId = d.changeId
      ev.suppressedAtMs ??= silencedAt
      ev.history.push({ kind: 'suppressed', atMs: silencedAt, changeId: d.changeId })
      // Still firing when the release ends: the engine lifts it — the pointer goes, the SUPPRESSED_BY edge stays.
      if (i < releases.length - 1 || decideAtMs !== null) ev.history.push({ kind: 'unsuppressed', atMs: d.endMs + MINUTE, changeId: d.changeId })
    })
    /*
     * Silenced until it cleared, it is RESOLVED, not suppressed: the engine's
     * transition table (transitions.ts) turns an open alarm — firing or
     * suppressed — into `resolved` when the resolved payload arrives.
     */
    if (decideAtMs === null) ev.status = 'resolved'
    else this.correlate(ev, decideAtMs, decidedAt, releases.length > 0, attachTo)
    if (ev.resolvedAtMs !== null) ev.history.push({ kind: 'cycle_resolved', atMs: ev.resolvedAtMs })
    ev.history.sort((a, b) => a.atMs - b.atMs)
    this.cycles.push(ev)
  }

  /** Steps 3-6 of the pipeline at `atMs` (grouping.ts): the threshold, then the incident open on the CI, or a new one. */
  private correlate(ev: PlannedEvent, atMs: number, decidedAt: number, lifted: boolean, attachTo?: IncidentWindow): void {
    if (!this.opens(ev.severity)) {
      ev.correlation = 'skipped_severity'
      // Decided when it was first seen — or when the engine lifted it from a release.
      ev.correlatedAtMs = lifted ? decidedAt : ev.firstSeenAtMs
      return
    }
    const open = attachTo ?? this.openOn(ev.ciId, atMs)
    ev.correlatedAtMs = decidedAt
    if (open) {
      ev.correlation = 'attached'
      ev.incidentId = open.id
      ev.history.push({ kind: 'correlated', atMs: decidedAt, outcome: 'attached', incidentId: open.id })
      return
    }
    const b = this.bearIncident(ev, atMs)
    ev.correlation = 'opened'
    ev.incidentId = b.incidentId
    ev.history.push({ kind: 'correlated', atMs: decidedAt, outcome: 'opened', incidentId: b.incidentId })
    if (b.clearedAtMs !== null && b.fixedAtMs === null && this.input.policy.autoResolve) {
      ev.history.push({ kind: 'auto_resolved', atMs: Math.min(b.clearedAtMs + this.rng.int(5, 60) * 1000, this.now - MINUTE), incidentId: b.incidentId })
    }
  }

  /** The incident the engine opens: who takes it (minutes: D63), and whether a person or the clearing alarm closes it. */
  private bearIncident(ev: PlannedEvent, atMs: number): BornIncident {
    const rng = this.rng
    const incidentId = rng.uuid()
    const cleared = ev.resolvedAtMs
    const lasting = (cleared ?? this.now) - atMs
    // Somebody looks at it only if it lasts: a blip of a few minutes is closed
    // by the engine before the on-call engineer has read the title.
    const takenAt = lasting > 20 * MINUTE && rng.chance(0.95)
      ? Math.min(atMs + Math.round(rng.logNormal(8 * MINUTE, 0.7)), (cleared ?? this.now) - 2 * MINUTE)
      : null
    // A person who takes it fixes it about one time in two, a little before
    // the alarm clears (the fix is what clears it); otherwise the engine closes it.
    const fixedAt = takenAt !== null && cleared !== null && rng.chance(0.5)
      ? Math.max(takenAt + MINUTE, cleared - rng.int(1, 8) * MINUTE)
      : null
    const b: BornIncident = {
      incidentId, ciId: ev.ciId, eventId: ev.id, title: ev.title, alarmDescription: ev.description,
      resource: ev.resource, resourceKind: ev.resourceKind, count: 1,
      firstSeenMs: atMs, lastSeenMs: ev.lastSeenAtMs, clearedAtMs: cleared, takenAtMs: takenAt !== null && takenAt > atMs ? takenAt : null,
      fixedAtMs: fixedAt,
    }
    this.born.push(b)
    // Until it is resolved the incident is the CI's: a later alarm there attaches to it.
    this.addWindow({ id: incidentId, ciId: ev.ciId, fromMs: atMs, toMs: fixedAt ?? cleared ?? this.now })
    return b
  }

  kindsCritical(): Array<readonly [AlarmKind, number]> {
    return ALARM_KINDS.filter((k) => k.critical > 0).map((k) => [k, k.weight * k.critical] as const)
  }

  /**
   * THE CERTIFICATES: the CMDB date decides. Renewed while warning for most,
   * in the last week for some — the incident is born then — and a
   * production certificate at the latest a few days after it expired (D38).
   * A certificate still in its warning month today may not be renewed yet.
   */
  certificates(): void {
    const { rng, now } = this
    for (const cert of this.w.cmdb.byLabel.Certificate) {
      // A certificate planted for CMDB Health (healthFindings.ts) raises no alarm: no ticket is its.
      if (cert.healthFinding) continue
      const expiresAt = Date.parse(cert.fields['expires_at'] ?? '')
      if (!Number.isFinite(expiresAt)) continue
      const warnAt = expiresAt - CERT_WARNING_DAYS * DAY
      const critAt = expiresAt - CERT_CRITICAL_DAYS * DAY
      if (warnAt > now - HOUR || warnAt < cert.createdAtMs) continue
      const pending = expiresAt > now && rng.chance(0.25)
      const renewAt = pending ? null
        : rng.chance(0.7) ? warnAt + rng.float(0.2, 0.75) * (critAt - warnAt)
        : rng.chance(0.75) ? critAt + rng.float(0.1, 0.9) * (expiresAt - critAt)
        : expiresAt + rng.int(1, cert.environment === 'production' ? 3 : 10) * DAY
      const firstSeen = Math.min(this.w.clock.workInstant(rng, warnAt, warnAt + 6 * HOUR), now - 2 * MINUTE)
      const clearedAt = this.renewedByRelease(cert.id, firstSeen, critAt, renewAt !== null && renewAt < now ? renewAt : null)
      const reachedCritical = (clearedAt ?? now) > critAt
      const expired = (clearedAt ?? now) > expiresAt
      const ev = this.newEvent(cert, {
        source: CERT.source, name: CERT.name,
        summary: expired ? 'The certificate of {resource} has expired' : `The certificate of {resource} expires in less than ${String(reachedCritical ? CERT_CRITICAL_DAYS : CERT_WARNING_DAYS)} days`,
        description: expired
          ? 'The certificate is past its expiry date and is still served: browsers and clients refuse the connection.'
          : 'The blackbox probe reports that the certificate expires shortly: plan the renewal.',
      }, reachedCritical ? 'critical' : 'warning', firstSeen, clearedAt, 'warning')
      if (reachedCritical) ev.history.push({ kind: 'severity_changed', atMs: Math.min(critAt, now - 2 * MINUTE), severity: 'critical' })
      this.decide(ev, reachedCritical ? Math.min(critAt, now - 2 * MINUTE) : ev.firstSeenAtMs)
    }
  }

  /**
   * A certificate a release is still running on is being renewed by it — the
   * changes on a certificate renew it, install its chain or automate its
   * renewal: the probe sees the new expiry during the release, instead of the
   * alarm staying silenced past the run.
   */
  private renewedByRelease(ciId: string, firstSeenMs: number, critAtMs: number, clearedAtMs: number | null): number | null {
    const decisionAt = (clearedAtMs ?? this.now) > critAtMs ? Math.min(critAtMs, this.now - 2 * MINUTE) : firstSeenMs
    if (!this.stillSilenced(ciId, decisionAt, clearedAtMs)) return clearedAtMs
    const { releases } = this.silences(ciId, decisionAt, clearedAtMs)
    const running = releases[releases.length - 1]!.d
    return this.w.clock.between(this.rng, Math.max(decisionAt, running.startMs) + MINUTE, this.now - MINUTE)
  }

  /**
   * THE INCIDENTS BORN FROM AN ALARM: EXACTLY as many as planned. They are
   * part of the tenant's incident count, so the certificates that opened one
   * count too, and every slot is filled: an instant where no CI is free
   * (everything open, deploying or just resolved) moves a few hours instead
   * of being dropped. A policy that opens nothing from a critical alarm
   * (`never`) cannot give them: the plan stops.
   */
  bornAlarms(): void {
    const { rng, now, w, input } = this
    const certificateBorn = this.born.length
    if (certificateBorn > input.openedTarget) {
      throw new Error(`planMonitoring: the certificates alone open ${String(certificateBorn)} incidents, more than the ${String(input.openedTarget)} planned`)
    }
    if (input.openedTarget > certificateBorn && !this.opens('critical')) {
      throw new Error(`planMonitoring: ${String(input.openedTarget - certificateBorn)} incidents born from alarms are planned, and the event policy opens none (open_incident_from: ${input.policy.openFrom})`)
    }
    const kinds = this.kindsCritical()
    for (const start of arrivalInstants(rng, w.clock, input.openedTarget - certificateBorn, w.clock.startMs + 5 * DAY, now - 10 * MINUTE)) {
      let at = start
      let placed = false
      for (let attempt = 0; attempt < 300 && !placed; attempt++) {
        if (attempt > 0 && attempt % 30 === 0) at = Math.min(now - 10 * MINUTE, Math.max(w.clock.startMs + 5 * DAY, at + rng.int(-12, 12) * HOUR))
        const kind = rng.weighted(kinds)
        const ci = w.runningCI(rng, w.cmdb.byLabel[kind.on], at)
        // Only where nothing is open and nothing is deploying: otherwise the
        // engine would have attached or silenced it, not opened an incident.
        if (!ci || this.openOn(ci.id, at) || this.inReopenTail(ci.id, at) || this.deployingOn(ci.id, at)) continue
        const life = lifetimes(rng, 1, CRITICAL_LIFE)[0]!
        this.decide(this.newEvent(ci, kind, 'critical', at, at + life < now ? at + life : null), at)
        placed = true
      }
      if (!placed) throw new Error(`planMonitoring: no CI free for an alarm around ${new Date(start).toISOString()}`)
    }
  }

  /**
   * The incidents born from alarms are EXACTLY the planned ones — verify.ts
   * counts them — checked once every alarm is decided: with a threshold
   * below critical the warnings open incidents too (the product's rule), and
   * the demo plans its incidents from critical alarms.
   */
  assertBornCount(): void {
    const { born, input } = this
    if (born.length === input.openedTarget) return
    const lower = this.cycles.filter((e) => e.correlation === 'opened' && e.severity !== 'critical').length
    const why = lower > 0
      ? ` — ${String(lower)} opened by alarms below critical: open_incident_from is «${input.policy.openFrom}», and the demo plans its incidents from critical alarms`
      : ''
    throw new Error(`planMonitoring: ${String(born.length)} incidents born from alarms, ${String(input.openedTarget)} planned${why}`)
  }

  /** THE ALARMS THAT FOUND AN INCIDENT ALREADY OPEN (the people noticed first, or at the same time). */
  attachedAlarms(): void {
    const { rng, now, w, input } = this
    const kinds = this.kindsCritical()
    for (const win of input.humanWindows) {
      const ci = w.cmdb.byId.get(win.ciId)
      if (!ci || !rng.chance(input.attachShare)) continue
      const candidates = kinds.filter(([k]) => k.on === ci.label)
      if (!candidates.length) continue
      const kind = rng.weighted(candidates)
      const at = Math.min(now - 5 * MINUTE, Math.max(ci.createdAtMs, win.fromMs + rng.int(-40, 90) * MINUTE))
      if (at < win.fromMs - 2 * HOUR || at > win.toMs || this.deployingOn(ci.id, at)) continue
      const life = Math.min(lifetimes(rng, 1, kind.life)[0]!, Math.max(MINUTE, win.toMs - at))
      this.decide(this.newEvent(ci, kind, 'critical', at, at + life < now ? at + life : null), at, win)
    }
  }

  /**
   * THE ALARMS FIRED DURING A RELEASE: silenced by the change. Only the ones
   * that CLEARED during the release — a restart blip: one still firing when
   * the window closes is lifted by the engine and opens an incident on its
   * own. Every release of the three years has them: those older than the
   * retention are then deleted, and the change keeps their number
   * (`suppressed_events_purged`).
   */
  deployAlarms(): void {
    const { rng, now, w, input } = this
    for (const d of input.deployWindows) {
      if (d.startMs > now || !rng.chance(0.35)) continue
      for (let k = rng.int(1, 3); k > 0; k--) {
        const ci = w.cmdb.byId.get(rng.pick(d.ciIds))
        if (!ci) continue
        const candidates = ALARM_KINDS.filter((x) => x.on === ci.label).map((x) => [x, x.weight] as const)
        if (!candidates.length) continue
        const kind = rng.weighted(candidates)
        const at = d.startMs + rng.float(0.05, 0.7) * (Math.min(d.endMs, now) - d.startMs)
        // A blip clears inside its release, before the window closes.
        const clearedAt = Math.min(at + rng.int(2, 25) * MINUTE, d.endMs - MINUTE, now - MINUTE)
        if (clearedAt <= at) continue
        const severity = rng.chance(kind.critical) ? 'critical' : kind.base ?? 'warning'
        this.decide(this.newEvent(ci, kind, severity, at, clearedAt), at)
      }
    }
  }

  /** THE WARNINGS (and the information): they never open anything, and only the recent survive. */
  warnings(): void {
    const { rng, now, w, input } = this
    const kinds = ALARM_KINDS.filter((k) => k.critical < 1).map((k) => [k, k.weight * (1 - k.critical)] as const)
    const cycles = Math.max(0, input.alarmCycles - this.cycles.length)
    const periodDays = (now - w.clock.startMs) / DAY
    const windowDays = Number.isFinite(this.cutoff) ? input.policy.retentionDays : periodDays
    const retained = Math.round(cycles * Math.min(1, windowDays / periodDays))
    const from = Math.max(w.clock.startMs + DAY, Number.isFinite(this.cutoff) ? this.cutoff - 7 * DAY : w.clock.startMs + DAY)
    for (const at of arrivalInstants(rng, w.clock, retained, from, now - 5 * MINUTE)) {
      const kind = rng.weighted(kinds)
      const ci = w.runningCI(rng, w.cmdb.byLabel[kind.on], at)
      if (!ci) continue
      const life = lifetimes(rng, 1, kind.life)[0]!
      const ev = this.newEvent(ci, kind, kind.base ?? 'warning', at, at + life < now ? at + life : null)
      // On a CI a release is still running on, and firing through it: the engine would decide it after the run.
      if (this.stillSilenced(ci.id, at, ev.resolvedAtMs)) continue
      this.decide(ev, at)
    }
  }

  /** What the nightly retention job left in the database, and the counters it left behind. */
  retention(): Pick<MonitoringPlan, 'events' | 'purgedByIncident' | 'purgedByChange'> {
    const { now, input } = this
    const purgedByIncident = new Map<string, number>()
    const purgedByChange = new Map<string, number>()
    const bornById = new Map(this.born.map((b) => [b.incidentId, b]))
    const openIncidentToday = (id: string | null): boolean => {
      if (!id) return false
      const b = bornById.get(id)
      if (b) return b.clearedAtMs === null && b.fixedAtMs === null
      return input.humanWindows.some((x) => x.id === id && x.toMs >= now - MINUTE)
    }
    const events = this.cycles.filter((e) => {
      const keep = e.lastSeenAtMs >= this.cutoff || e.status === 'firing' || openIncidentToday(e.incidentId)
      if (keep) return true
      if (e.incidentId) purgedByIncident.set(e.incidentId, (purgedByIncident.get(e.incidentId) ?? 0) + 1)
      if (e.suppressedByChangeId) purgedByChange.set(e.suppressedByChangeId, (purgedByChange.get(e.suppressedByChangeId) ?? 0) + 1)
      return false
    })
    return { events: events.sort((a, b) => a.firstSeenAtMs - b.firstSeenAtMs), purgedByIncident, purgedByChange }
  }
}

/** The resource as the connector reads it, and how the product finds the CI (the aliases of toolNames.ts). */
function resourceOf(source: SourceKey, ci: PlannedCI, tool: ToolIdentity): Pick<PlannedEvent, 'resource' | 'resourceKind' | 'resourceExternalId' | 'matchReason'> {
  if (source === 'dynatrace') {
    return { resource: tool.entityName ?? ci.name, resourceKind: 'name', resourceExternalId: tool.entityId ?? null, matchReason: 'alias_external_id' }
  }
  if (source === 'grafana') return { resource: tool.service ?? ci.name, resourceKind: 'hostname', resourceExternalId: null, matchReason: 'alias' }
  return { resource: tool.host ?? ci.name, resourceKind: 'hostname', resourceExternalId: null, matchReason: 'alias' }
}

/** The labels each tool sends with an alert. */
function labelsOf(source: SourceKey, name: string, severity: string, ci: PlannedCI, r: Pick<PlannedEvent, 'resource'>, tool: ToolIdentity): Record<string, string> {
  if (source === 'dynatrace') {
    return { ProblemImpact: ci.label === 'Application' ? 'SERVICES' : 'INFRASTRUCTURE', dynatrace_entity: tool.entityId ?? '', environment: ci.environment }
  }
  return { alertname: name, severity, instance: source === 'prometheus' ? `${r.resource}:${ci.label === 'Certificate' ? '443' : '9100'}` : r.resource, environment: ci.environment }
}

/*
 * ── Health ──────────────────────────────────────────────────────────────────
 * The engine writes `ci.health` on every alarm cycle (ciHealth.ts): the
 * worst of what is firing, and back to `operational` when the last alarm
 * clears — it does not erase it. So every CI that had an alarm in the window
 * has a health today: `down` or `degraded` if something is still firing (and
 * not silenced), `operational` otherwise. Only the CIs no monitoring ever
 * looked at have none, which is what «unknown» means.
 */
/**
 * Since when a firing alarm gives its CI the health of its severity — the
 * engine moves `health_since` only when the health changes (ciHealth.ts): its
 * first sighting, the moment it reached that severity (a certificate turns
 * critical in its last week), or the moment the engine lifted it from a
 * release (silenced, it gives none).
 */
function firingSinceMs(e: PlannedEvent): number {
  return e.history.reduce((t, h) => (h.kind === 'severity_changed' || h.kind === 'unsuppressed' ? Math.max(t, h.atMs) : t), e.firstSeenAtMs)
}

function healthOf(events: readonly PlannedEvent[]): MonitoringPlan['health'] {
  const RANK: Record<string, number> = { operational: 0, degraded: 1, down: 2 }
  const worst = new Map<string, { health: string; atMs: number; sinceMs: number }>()
  for (const e of events) {
    const firing = e.status === 'firing'
    const health = firing ? (HEALTH_BY_SEVERITY[e.severity] ?? 'degraded') : 'operational'
    // Since when the CI is in this state: since what fires gave it this health, or the last clearing.
    const since = firing ? firingSinceMs(e) : (e.resolvedAtMs ?? e.lastSeenAtMs)
    const cur = worst.get(e.ciId)
    if (!cur) { worst.set(e.ciId, { health, atMs: e.lastSeenAtMs, sinceMs: since }); continue }
    const rank = RANK[health] ?? 0
    const curRank = RANK[cur.health] ?? 0
    if (rank > curRank) { cur.health = health; cur.sinceMs = since }
    else if (rank === curRank) cur.sinceMs = rank > 0 ? Math.min(cur.sinceMs, since) : Math.max(cur.sinceMs, since)
    cur.atMs = Math.max(cur.atMs, e.lastSeenAtMs)
  }
  return [...worst.entries()].map(([ciId, v]) => ({ ciId, health: v.health, atMs: v.atMs, sinceMs: v.sinceMs }))
}

export function planMonitoring(rng: Rng, w: World, input: MonitoringInput): MonitoringPlan {
  const p = new MonitoringPlanner(rng, w, input)
  p.certificates()
  p.bornAlarms()
  p.attachedAlarms()
  p.deployAlarms()
  p.warnings()
  p.assertBornCount()
  const kept = p.retention()
  return { ...kept, born: p.born, health: healthOf(kept.events) }
}
