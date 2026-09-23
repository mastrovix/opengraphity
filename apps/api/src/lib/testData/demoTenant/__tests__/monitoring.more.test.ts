/**
 * THE MONITORING PLANNER, DECISION BY DECISION (tour of 23 Sep 2026).
 *
 * monitoring.test.ts runs the planner once over the small demo world and
 * checks what must hold for every alarm. Here the worlds are built by hand —
 * a few CIs, certificates with a chosen expiry, chosen incidents and releases
 * — so that each decision of the module can be looked at on its own,
 * including the ones a large random run rarely or never reaches:
 *
 *  - the certificates: the date in the CMDB decides; renewed in time they
 *    never turn critical, in their last week they do and the engine opens an
 *    incident that day, and they are renewed at the latest days after the
 *    expiry (D38);
 *  - the incident a critical alarm opens: taken, fixed or closed by the
 *    engine (D63, `auto_resolve`);
 *  - the people's incidents an alarm joins, and when it cannot;
 *  - the releases that plant no alarm;
 *  - the tenant's retention (`0` = never) and the counters the purge leaves;
 *  - the fail-loud guards: the incidents born from alarms are exactly the
 *    planned ones, or the run stops — never a silent drop;
 *  - what the connector sends when a tool has no name for the CI (D37).
 *
 * The defects this file found (23 Sep 2026) were places where the planner
 * wrote a past the real engine (services/events) would not have written, or
 * one the owner's own checks refuse (verify.ts). They are fixed, and the test
 * that found each says what was wrong.
 *
 * Pure: no database. `@opengraphity/neo4j` is mocked only because the world's
 * modules reach it (`World` through `@opengraphity/sla`, the fixtures through
 * systemText), and its import alone would open a driver.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn() }))

import { Rng } from '../random.js'
import { DAY, HOUR, MINUTE } from '../clock.js'
import { World } from '../world.js'
import { CI_NAME_PREFIX, type CILabel, type CMDBPlan, type PlannedCI } from '../cmdb.js'
import { planToolNames, type ToolNames } from '../toolNames.js'
import {
  planMonitoring, occurrences, alarmMeetsThreshold, CERT_WARNING_DAYS, CERT_CRITICAL_DAYS,
  type DeployWindow, type IncidentWindow, type MonitoringInput, type MonitoringPlan, type MonitoringPolicy, type PlannedEvent,
} from '../monitoring.js'
import { EVENT_SEVERITIES, OPEN_INCIDENT_FROM } from '../../../eventVocabularies.js'
// The engine's own threshold, to hold the planner to it (its imports reach Neo4j and Redis only when called).
import { meetsOpenThreshold } from '../../../../services/events/grouping.js'
import { NOW, smallWorld, WORKFLOWS, PRIORITY, trailContext } from './fixtures.js'

// ── Hand-made worlds ─────────────────────────────────────────────────────────

/** The small demo world: its people, calendars and clock serve every hand-made CMDB below. */
const base = smallWorld('monitoring-more')
const START = base.clock.startMs
/** The factory `event_policy`: ninety days, incidents from `critical`, auto-resolve on. */
const FACTORY: MonitoringPolicy = { retentionDays: 90, openFrom: 'critical', autoResolve: true }

function ci(label: CILabel, name: string, spec: Partial<PlannedCI> = {}): PlannedCI {
  return {
    id: `${label}:${name}`, label, name: `${CI_NAME_PREFIX[label]}${name}`, status: 'active', environment: 'production',
    description: `${name}.`, fields: {}, createdAtMs: START, updatedAtMs: START, ownerTeamId: null, supportTeamId: null, ...spec,
  }
}

/** A TLS certificate whose CMDB record expires at `expiresAtMs` (null: the field was never filled). */
function certificate(host: string, expiresAtMs: number | null, spec: Partial<PlannedCI> = {}): PlannedCI {
  return ci('Certificate', host, { fields: expiresAtMs === null ? {} : { expires_at: new Date(expiresAtMs).toISOString() }, ...spec })
}

/** One CI of each kind a critical alarm can land on: what the planner needs to place the incidents it must open. */
function estate(tag: string, spec: Partial<PlannedCI> = {}): PlannedCI[] {
  return [
    ci('Server', `${tag}-srv-01`, spec), ci('DatabaseInstance', `${tag}-pg-01`, spec),
    ci('Application', `${tag} Ledger`, spec), ci('Database', `${tag}_ledger`, spec),
  ]
}

function worldOf(cis: readonly PlannedCI[]): World {
  const byLabel: Record<CILabel, PlannedCI[]> = {
    BusinessApplication: [], Application: [], BusinessCapability: [], Server: [], DatabaseInstance: [], Database: [], Certificate: [],
  }
  for (const c of cis) byLabel[c.label].push(c)
  const cmdb: CMDBPlan = {
    cis: [...cis], relations: [], byId: new Map(cis.map((c) => [c.id, c])), byLabel,
    appServers: new Map(), appDatabases: new Map(), databaseInstance: new Map(), instanceServers: new Map(),
  }
  return new World(new Rng('monitoring-more/world'), base.clock, base.people, cmdb, base.config, WORKFLOWS, PRIORITY, trailContext(), 'Europe/Rome')
}

function plan(w: World, input: Partial<MonitoringInput>, seed = 'monitoring-more'): MonitoringPlan {
  return planMonitoring(new Rng(seed), w, {
    alarmCycles: 0, openedTarget: 0, attachShare: 0, humanWindows: [], deployWindows: [], policy: FACTORY,
    names: planToolNames(new Rng('monitoring-more/names'), w.cmdb), ...input,
  })
}

function release(changeId: string, ciId: string, startMs: number, hours = 3): DeployWindow {
  return { changeId, ciIds: [ciId], startMs, endMs: startMs + hours * HOUR }
}

const expiryOf = (c: PlannedCI): number => Date.parse(c.fields['expires_at']!)
const criticalFrom = (c: PlannedCI): number => expiryOf(c) - CERT_CRITICAL_DAYS * DAY

// ── The certificates ─────────────────────────────────────────────────────────

describe('the certificates: the date in the CMDB decides (D38)', () => {
  /** Expired twenty days ago: by now renewed, one way or the other. */
  const expired = NOW - 20 * DAY
  /** Expires in three days: in its last week since four days, maybe not renewed yet. */
  const dueSoon = NOW + 3 * DAY
  const production = Array.from({ length: 40 }, (_, i) => certificate(`pay-${String(i)}.bank.example`, expired))
  const staging = Array.from({ length: 40 }, (_, i) => certificate(`pay-${String(i)}.stg.bank.example`, expired, { environment: 'staging' }))
  const soon = Array.from({ length: 12 }, (_, i) => certificate(`api-${String(i)}.bank.example`, dueSoon))
  const undated = certificate('legacy.bank.example', null)
  const notYet = certificate('portal.bank.example', NOW + 60 * DAY)
  const recordedLate = certificate('late.bank.example', NOW + 10 * DAY, { createdAtMs: NOW - 5 * DAY })
  const certs = [...production, ...staging, ...soon]
  const w = worldOf([...certs, undated, notYet, recordedLate, ...estate('cert')])
  // Enough incidents that the certificates can never exceed them: the rest land on the estate.
  const p = plan(w, { openedTarget: certs.length })
  const alarm = new Map(p.events.filter((e) => e.alertName === 'SSLCertExpiringSoon').map((e) => [e.ciId, e]))
  const of = (c: PlannedCI): PlannedEvent => alarm.get(c.id)!

  it('the probe starts warning thirty days before the expiry written on the CI, within hours of that day, as a warning (D41)', () => {
    for (const c of certs) {
      const e = of(c)
      const warnAt = expiryOf(c) - CERT_WARNING_DAYS * DAY
      expect(e.firstSeenAtMs - warnAt).toBeGreaterThanOrEqual(0)
      expect(e.firstSeenAtMs - warnAt).toBeLessThan(6 * HOUR)
      expect(e.history[0]).toEqual({ kind: 'first_seen', atMs: e.firstSeenAtMs, severity: 'warning' })
    }
  })

  it('D38: a production certificate is renewed at the latest three days after it expired, any other within ten', () => {
    const lateness = (c: PlannedCI): number => (of(c).resolvedAtMs ?? NOW) - expiryOf(c)
    for (const c of [...production, ...soon]) expect(lateness(c)).toBeLessThanOrEqual(3 * DAY)
    for (const c of staging) expect(lateness(c)).toBeLessThanOrEqual(10 * DAY)
    // Both limits are reached, not only respected: some were renewed only after they expired.
    expect(production.some((c) => lateness(c) > 0)).toBe(true)
    expect(staging.some((c) => lateness(c) > 3 * DAY)).toBe(true)
  })

  it('renewed while it was only warning, a certificate never reaches critical: skipped, no incident', () => {
    const inTime = certs.filter((c) => of(c).resolvedAtMs !== null && of(c).resolvedAtMs! < criticalFrom(c))
    expect(inTime.length).toBeGreaterThan(0)
    for (const c of inTime) {
      const e = of(c)
      expect(e).toMatchObject({ severity: 'warning', maxSeverity: 'warning', status: 'resolved', correlation: 'skipped_severity', incidentId: null })
      expect(e.history.map((h) => h.kind)).toEqual(['first_seen', 'cycle_resolved'])
    }
  })

  it('in its last week it turns critical, and that day — not the day of the first warning — the engine opens its incident', () => {
    const critical = certs.filter((c) => of(c).severity === 'critical')
    expect(critical.length).toBeGreaterThan(0)
    for (const c of critical) {
      const e = of(c)
      expect(e.history.find((h) => h.kind === 'severity_changed')).toEqual({ kind: 'severity_changed', atMs: criticalFrom(c), severity: 'critical' })
      expect(e.correlation).toBe('opened')
      expect(p.born.find((b) => b.eventId === e.id)).toMatchObject({ incidentId: e.incidentId, ciId: c.id, firstSeenMs: criticalFrom(c) })
    }
    // They are incidents born from alarms like the others: counted in the planned number, not added to it.
    expect(p.born.filter((b) => w.cmdb.byId.get(b.ciId)!.label === 'Certificate')).toHaveLength(critical.length)
    expect(p.born).toHaveLength(certs.length)
  })

  it('the alarm says what the probe sees: that it has expired, or how many days are left', () => {
    for (const c of certs) {
      const e = of(c)
      const summary = e.description.split('\n')[0]
      if ((e.resolvedAtMs ?? NOW) > expiryOf(c)) expect(summary).toBe(`The certificate of ${e.resource} has expired`)
      else expect(summary).toBe(`The certificate of ${e.resource} expires in less than ${String(e.severity === 'critical' ? CERT_CRITICAL_DAYS : CERT_WARNING_DAYS)} days`)
    }
    expect(certs.some((c) => of(c).description.includes('has expired'))).toBe(true)
  })

  it('one not renewed yet keeps firing: its incident is still open — nobody fixed it, the engine has not closed it — and the CI is down', () => {
    const firing = soon.map(of).filter((e) => e.status === 'firing')
    expect(firing.length).toBeGreaterThan(0)
    for (const e of firing) {
      expect(e).toMatchObject({ severity: 'critical', resolvedAtMs: null, correlation: 'opened' })
      expect(e.history.some((h) => h.kind === 'auto_resolved' || h.kind === 'cycle_resolved')).toBe(false)
      expect(p.born.find((b) => b.eventId === e.id)).toMatchObject({ clearedAtMs: null, fixedAtMs: null })
      expect(p.health.find((h) => h.ciId === e.ciId)!.health).toBe('down')
    }
  })

  it('the certificates are not invented: no expiry in the CMDB, a warning month not begun, or a record made after it began — no alarm', () => {
    for (const c of [undated, notYet, recordedLate]) expect(p.events.filter((e) => e.ciId === c.id)).toEqual([])
    expect(alarm.size).toBe(certs.length)
  })

  /*
   * Found by this test (23 Sep 2026), fixed: `healthOf` dated a firing
   * alarm's health from its first sighting. A certificate is first seen as a
   * WARNING (degraded) thirty days before its expiry and turns critical
   * (down) in its last week; the engine writes `health_since` only when the
   * health changes (services/events/ciHealth.ts:102), so the CI is down since
   * that day — the plan said «down since» the first warning, three weeks too
   * early (monitoring.ts, `firingSinceMs`).
   */
  it('a certificate that turned critical is down since that day, not since the probe first warned', () => {
    const firing = soon.filter((c) => of(c).status === 'firing')
    expect(firing.length).toBeGreaterThan(0)
    for (const c of firing) expect(p.health.find((h) => h.ciId === c.id)).toMatchObject({ health: 'down', sinceMs: criticalFrom(c) })
  })
})

describe('a certificate that turns critical during a release on it', () => {
  const dueSoon = NOW + 3 * DAY
  const certs = Array.from({ length: 20 }, (_, i) => certificate(`gw-${String(i)}.bank.example`, dueSoon))
  // The release ran around the day each one entered its last week, four days ago.
  const releases = certs.map((c, i) => release(`chg-gw-${String(i)}`, c.id, criticalFrom(c) - 2 * HOUR, 4))
  const w = worldOf([...certs, ...estate('gw')])
  // Enough incidents that the certificates can never exceed them: the rest land on the estate.
  const p = plan(w, { deployWindows: releases, openedTarget: certs.length }, 'monitoring-more/gw')
  /** The certificates' alarms that turned critical inside their release. */
  const silenced = (q: MonitoringPlan): PlannedEvent[] => q.events.filter((e) => e.alertName === 'SSLCertExpiringSoon' && e.history.some((h) => h.kind === 'suppressed'))

  /*
   * Found by this test (23 Sep 2026), fixed: an alarm silenced by a release
   * and still firing was written `suppressed` even when the release had
   * ended days before. The engine lifts the silence when the window closes
   * (`reevaluateSuppressedEvents`, passes.ts) and correlates the alarm — for
   * these critical ones an incident dated «now», the very defect the
   * module's header tells; verify.ts:279-280 refuses any `suppressed` alarm
   * for that reason. The plan now lifts it when its release ends and decides
   * it then (monitoring.ts, `silences` and `decide`).
   */
  it('no alarm is left silenced after its release ended: still firing then, the engine lifted it and decided it at that moment', () => {
    expect(p.events.filter((e) => e.status === 'suppressed')).toEqual([])
    // Every certificate that turned critical did so inside its release.
    expect(silenced(p).map((e) => e.id).sort()).toEqual(p.events.filter((e) => e.alertName === 'SSLCertExpiringSoon' && e.severity === 'critical').map((e) => e.id).sort())
    const byCI = new Map(releases.map((d) => [d.ciIds[0]!, d]))
    let lifted = 0
    for (const e of silenced(p)) {
      const d = byCI.get(e.ciId)!
      expect(e.suppressedByChangeId).toBe(d.changeId)
      expect(e.history.find((h) => h.kind === 'suppressed')).toMatchObject({ changeId: d.changeId })
      if (e.resolvedAtMs !== null && e.resolvedAtMs <= d.endMs) {
        // Cleared inside the release: silenced to the end, and resolved.
        expect(e).toMatchObject({ status: 'resolved', correlation: 'suppressed', incidentId: null })
        continue
      }
      lifted++
      expect(e.history.find((h) => h.kind === 'unsuppressed')).toEqual({ kind: 'unsuppressed', atMs: d.endMs + MINUTE, changeId: d.changeId })
      // Critical when the release ended: the engine opened its incident then, not when the probe turned critical inside the release.
      expect(e.correlation).toBe('opened')
      expect(p.born.find((b) => b.eventId === e.id)!.firstSeenMs).toBe(d.endMs + MINUTE)
    }
    expect(lifted).toBeGreaterThan(0)
  })

  it('a certificate lifted from its release is down since the lift: while silenced it gave its CI no health', () => {
    const firing = silenced(p).filter((x) => x.status === 'firing')
    expect(firing.length).toBeGreaterThan(0)
    for (const e of firing) {
      const lift = e.history.find((h) => h.kind === 'unsuppressed')!.atMs
      expect(p.health.find((h) => h.ciId === e.ciId)).toMatchObject({ health: 'down', sinceMs: lift })
    }
  })

  it('a certificate a release is still running on is renewed by it: its alarm clears during the release, it is not left silenced', () => {
    // Turned critical an hour ago, while a release running since two hours is deployed on each.
    const turning = Array.from({ length: 20 }, (_, i) => certificate(`api-${String(i)}.now.bank.example`, NOW + 7 * DAY - HOUR))
    const running = turning.map((c, i) => release(`chg-now-${String(i)}`, c.id, NOW - 2 * HOUR, 4))
    const q = plan(worldOf([...turning, ...estate('now')]), { deployWindows: running, openedTarget: turning.length }, 'monitoring-more/gw-now')
    const renewed = silenced(q)
    expect(renewed.length).toBeGreaterThan(0)
    // The others were renewed days ago, while they were only warning: no release was running then.
    for (const e of q.events.filter((x) => x.alertName === 'SSLCertExpiringSoon' && !renewed.includes(x))) {
      expect(e).toMatchObject({ severity: 'warning', status: 'resolved', correlation: 'skipped_severity' })
      expect(e.resolvedAtMs!).toBeLessThan(NOW - 2 * HOUR)
    }
    for (const e of renewed) {
      expect(e).toMatchObject({ status: 'resolved', correlation: 'suppressed', incidentId: null })
      expect(e.resolvedAtMs!).toBeGreaterThan(NOW - 2 * HOUR)
      expect(e.resolvedAtMs!).toBeLessThan(NOW)
      expect(e.history.some((h) => h.kind === 'unsuppressed')).toBe(false)
    }
    expect(q.events.filter((e) => e.status === 'suppressed')).toEqual([])
  })
})

// ── The incident a critical alarm opens ──────────────────────────────────────

describe('the incident a critical alarm opens (D63, auto_resolve)', () => {
  const keepAll = { ...FACTORY, retentionDays: 0 }
  // A seed where one of the alarms fired a few hours ago and has not cleared yet.
  const seed = 'monitoring-more/d63-0'
  const p = plan(base, { openedTarget: 300, policy: keepAll }, seed)
  // The certificates follow their renewal, not the on-call engineer: they are looked at above.
  const fromAlarms = p.born.filter((b) => base.cmdb.byId.get(b.ciId)!.label !== 'Certificate')

  it('is mostly cleared within the working day — the P2 target is eight hours — and a few drag on for days', () => {
    const cleared = fromAlarms.filter((b) => b.clearedAtMs !== null)
    expect(cleared.length).toBeGreaterThan(200)
    expect(cleared.filter((b) => b.clearedAtMs! - b.firstSeenMs <= 8 * HOUR).length / cleared.length).toBeGreaterThan(0.85)
    expect(cleared.some((b) => b.clearedAtMs! - b.firstSeenMs > DAY)).toBe(true)
  })

  it('a person who took it fixes it about one time in two, minutes before the alarm clears: the fix is what clears it', () => {
    const takenAndCleared = fromAlarms.filter((b) => b.takenAtMs !== null && b.clearedAtMs !== null)
    const fixed = takenAndCleared.filter((b) => b.fixedAtMs !== null)
    expect(fixed.length / takenAndCleared.length).toBeGreaterThan(0.35)
    expect(fixed.length / takenAndCleared.length).toBeLessThan(0.65)
    for (const b of fixed) {
      expect(b.fixedAtMs!).toBeGreaterThan(b.takenAtMs!)
      expect(b.clearedAtMs! - b.fixedAtMs!).toBeGreaterThanOrEqual(MINUTE)
      expect(b.clearedAtMs! - b.fixedAtMs!).toBeLessThanOrEqual(8 * MINUTE)
    }
    // Nobody fixes what nobody took, nor an alarm that has not cleared.
    for (const b of p.born.filter((x) => x.takenAtMs === null || x.clearedAtMs === null)) expect(b.fixedAtMs).toBeNull()
  })

  it('auto_resolve: the alarm cleared and nobody fixed it — the engine resolves the incident within the minute', () => {
    const born = new Map(p.born.map((b) => [b.eventId, b]))
    let engine = 0
    for (const e of p.events.filter((x) => x.correlation === 'opened')) {
      const b = born.get(e.id)!
      const auto = e.history.find((h) => h.kind === 'auto_resolved')
      if (b.clearedAtMs !== null && b.fixedAtMs === null) {
        engine += 1
        expect(auto!.incidentId).toBe(b.incidentId)
        expect(auto!.atMs - b.clearedAtMs).toBeGreaterThanOrEqual(0)
        expect(auto!.atMs - b.clearedAtMs).toBeLessThanOrEqual(MINUTE)
      } else {
        expect(auto).toBeUndefined()
      }
    }
    expect(engine).toBeGreaterThan(0)
  })

  it('an alarm that has not cleared keeps its incident open today: nobody fixed it, the engine has not closed it, the CI is down', () => {
    const still = fromAlarms.filter((b) => b.clearedAtMs === null)
    expect(still.length).toBeGreaterThan(0)
    for (const b of still) {
      expect(b.fixedAtMs).toBeNull()
      const e = p.events.find((x) => x.id === b.eventId)!
      expect(e).toMatchObject({ status: 'firing', severity: 'critical', correlation: 'opened', resolvedAtMs: null, incidentId: b.incidentId })
      expect(e.history.some((h) => h.kind === 'auto_resolved' || h.kind === 'cycle_resolved')).toBe(false)
      const firing = p.events.filter((x) => x.ciId === b.ciId && x.status === 'firing' && x.severity === 'critical')
      expect(p.health.find((h) => h.ciId === b.ciId)).toMatchObject({ health: 'down', sinceMs: Math.min(...firing.map((x) => x.firstSeenAtMs)) })
    }
  })

  it('a tenant without auto_resolve leaves the incident to the people: the engine resolves none', () => {
    const manual = plan(base, { openedTarget: 300, policy: { ...keepAll, autoResolve: false } }, seed)
    expect(manual.born).toHaveLength(300)
    expect(manual.born.some((b) => b.clearedAtMs !== null && b.fixedAtMs === null)).toBe(true)
    expect(manual.events.filter((e) => e.history.some((h) => h.kind === 'auto_resolved'))).toEqual([])
  })
})

// ── The people's incidents ───────────────────────────────────────────────────

describe("the alarms that found a person's incident open", () => {
  const servers = Array.from({ length: 40 }, (_, i) => ci('Server', `ops-${String(i).padStart(2, '0')}`))
  const s = (i: number): PlannedCI => servers[i]!
  const cert = certificate('intranet.bank.example', null)
  const onCertificate: IncidentWindow[] = Array.from({ length: 5 }, (_, i) => ({
    id: `inc-cert-${String(i)}`, ciId: cert.id, fromMs: NOW - (20 + i) * DAY, toMs: NOW - (20 + i) * DAY + 5 * HOUR,
  }))
  /** Resolved within ten minutes. */
  const brief: IncidentWindow[] = Array.from({ length: 20 }, (_, i) => ({
    id: `inc-brief-${String(i)}`, ciId: s(i).id, fromMs: NOW - (10 + i) * DAY, toMs: NOW - (10 + i) * DAY + 10 * MINUTE,
  }))
  const duringRelease: IncidentWindow[] = Array.from({ length: 5 }, (_, i) => ({
    id: `inc-rel-${String(i)}`, ciId: s(20 + i).id, fromMs: NOW - (5 + i) * DAY, toMs: NOW - (5 + i) * DAY + HOUR,
  }))
  /** A release from three hours before each of those incidents to three hours after it. */
  const releases = duringRelease.map((x, i) => release(`chg-rel-${String(i)}`, x.ciId, x.fromMs - 3 * HOUR, 7))
  /** Opened half an hour ago, open still. */
  const openNow: IncidentWindow[] = Array.from({ length: 5 }, (_, i) => ({
    id: `inc-open-${String(i)}`, ciId: s(25 + i).id, fromMs: NOW - 30 * MINUTE, toMs: NOW,
  }))
  /** Two people's incidents open on the same server. */
  const twice: IncidentWindow[] = Array.from({ length: 4 }, (_, i) => [
    { id: `inc-twice-a-${String(i)}`, ciId: s(30 + i).id, fromMs: NOW - 50 * MINUTE, toMs: NOW },
    { id: `inc-twice-b-${String(i)}`, ciId: s(30 + i).id, fromMs: NOW - 20 * MINUTE, toMs: NOW },
  ]).flat()
  /** Seven months ago, resolved in two days. */
  const oldResolved: IncidentWindow[] = Array.from({ length: 5 }, (_, i) => ({
    id: `inc-old-${String(i)}`, ciId: s(34 + i).id, fromMs: NOW - (200 + 10 * i) * DAY, toMs: NOW - (198 + 10 * i) * DAY,
  }))
  /** Seven months ago, and still open today. */
  const oldStillOpen: IncidentWindow = { id: 'inc-old-open', ciId: s(39).id, fromMs: NOW - 200 * DAY, toMs: NOW }
  const humanWindows = [...onCertificate, ...brief, ...duringRelease, ...openNow, ...twice, ...oldResolved, oldStillOpen]
  const w = worldOf([...servers, cert])
  const p = plan(w, { humanWindows, deployWindows: releases, attachShare: 1 })
  const attachedTo = (win: IncidentWindow): PlannedEvent[] => p.events.filter((e) => e.incidentId === win.id)

  it("a person's incident on a CI no tool alarms on — a certificate is watched only for its expiry — gets no alarm", () => {
    for (const win of onCertificate) expect(attachedTo(win)).toEqual([])
    expect(p.events.filter((e) => e.ciId === cert.id)).toEqual([])
  })

  it("an alarm joins a person's incident only while it is open, and clears at the latest when the person resolves it", () => {
    const byId = new Map(humanWindows.map((x) => [x.id, x]))
    const attached = p.events.filter((e) => e.correlation === 'attached')
    expect(attached.length).toBeGreaterThan(0)
    for (const e of attached) {
      const win = byId.get(e.incidentId!)!
      expect(e).toMatchObject({ ciId: win.ciId, severity: 'critical' })
      expect(e.firstSeenAtMs).toBeGreaterThanOrEqual(win.fromMs - 2 * HOUR)
      expect(e.firstSeenAtMs).toBeLessThanOrEqual(win.toMs)
      if (e.resolvedAtMs !== null) expect(e.resolvedAtMs).toBeLessThanOrEqual(Math.max(win.toMs, e.firstSeenAtMs + MINUTE))
    }
    // Resolved in ten minutes: an alarm that would have fired after that has nothing to join.
    expect(brief.filter((win) => attachedTo(win).length === 0).length).toBeGreaterThan(0)
    expect(brief.filter((win) => attachedTo(win).length === 1).length).toBeGreaterThan(0)
  })

  it("no alarm joins a person's incident while a release runs on its CI: the release silences it", () => {
    for (const win of duringRelease) expect(attachedTo(win)).toEqual([])
    for (const e of p.events.filter((x) => releases.some((d) => d.ciIds.includes(x.ciId)))) {
      expect(e).toMatchObject({ correlation: 'suppressed', incidentId: null })
    }
  })

  it('an alarm joined to an incident still open today may still be firing, and then its CI is down since that alarm fired', () => {
    const firing = openNow.flatMap(attachedTo).filter((e) => e.status === 'firing')
    expect(firing.length).toBeGreaterThan(0)
    for (const e of firing) {
      expect(e.resolvedAtMs).toBeNull()
      expect(p.health.find((h) => h.ciId === e.ciId)).toMatchObject({ health: 'down', sinceMs: e.firstSeenAtMs })
    }
  })

  it('two criticals firing on one CI: it is down since the first of them', () => {
    let seen = 0
    for (let i = 0; i < 4; i++) {
      const id = s(30 + i).id
      const firing = p.events.filter((e) => e.ciId === id && e.status === 'firing')
      if (firing.length < 2) continue
      seen += 1
      expect(p.health.find((h) => h.ciId === id)).toMatchObject({ health: 'down', sinceMs: Math.min(...firing.map((e) => e.firstSeenAtMs)) })
    }
    expect(seen).toBeGreaterThan(0)
  })

  it("an alarm older than the retention, joined to an incident resolved long ago, is deleted and leaves one on that incident's counter", () => {
    for (const win of oldResolved) {
      expect(attachedTo(win)).toEqual([])
      expect(p.purgedByIncident.get(win.id)).toBe(1)
    }
  })

  it('…while the alarm of an incident still open today stays, whatever its age', () => {
    const [e] = attachedTo(oldStillOpen)
    expect(e!.status).toBe('resolved')
    expect(e!.lastSeenAtMs).toBeLessThan(NOW - FACTORY.retentionDays * DAY)
    expect(p.purgedByIncident.has(oldStillOpen.id)).toBe(false)
  })
})

// ── The releases ─────────────────────────────────────────────────────────────

describe('the alarms of a release', () => {
  const servers = Array.from({ length: 30 }, (_, i) => ci('Server', `rel-${String(i).padStart(2, '0')}`))
  const cert = certificate('shop.bank.example', null)
  const w = worldOf([...servers, cert])
  const silencedBy = (p: MonitoringPlan, prefix: string): PlannedEvent[] => p.events.filter((e) => e.suppressedByChangeId?.startsWith(prefix))

  it('a release on a CI the CMDB does not have, or on a certificate, plants no alarm: nothing a tool watches is being released', () => {
    const ghosts = servers.map((_, i) => release(`chg-ghost-${String(i)}`, `Server:retired-${String(i)}`, NOW - (40 + i) * DAY))
    const onCertificate = servers.map((_, i) => release(`chg-cert-${String(i)}`, cert.id, NOW - (40 + i) * DAY + 6 * HOUR))
    const onServers = servers.map((srv, i) => release(`chg-srv-${String(i)}`, srv.id, NOW - (40 + i) * DAY))
    const p = plan(w, { deployWindows: [...ghosts, ...onCertificate, ...onServers] })
    expect(silencedBy(p, 'chg-ghost')).toEqual([])
    expect(silencedBy(p, 'chg-cert')).toEqual([])
    // The same releases on servers do plant their restart blips.
    expect(silencedBy(p, 'chg-srv').length).toBeGreaterThan(0)
    expect(p.events).toHaveLength(silencedBy(p, 'chg-srv').length)
  })

  it('D46: a release that began seconds ago has planted nothing yet — its blip would have to clear before it fired', () => {
    const justBegun = servers.map((srv, i) => release(`chg-now-${String(i)}`, srv.id, NOW - 30_000, 2))
    expect(plan(w, { deployWindows: justBegun }).events).toEqual([])
    // An hour in, the blips are there — cleared, and silenced by the release still running.
    const anHourIn = servers.map((srv, i) => release(`chg-hour-in-${String(i)}`, srv.id, NOW - HOUR, 2))
    const p = plan(w, { deployWindows: anHourIn })
    expect(p.events.length).toBeGreaterThan(0)
    for (const e of p.events) expect(e).toMatchObject({ status: 'resolved', correlation: 'suppressed' })
  })

  it('a release across the retention cutoff: what it silenced before the cutoff is deleted, and counted on the change', () => {
    const cutoff = NOW - FACTORY.retentionDays * DAY
    const across = servers.map((srv, i) => release(`chg-across-${String(i)}`, srv.id, cutoff - 90 * MINUTE))
    const p = plan(w, { deployWindows: across })
    expect(p.purgedByChange.size).toBeGreaterThan(0)
    for (const [changeId, n] of p.purgedByChange) {
      expect(changeId).toMatch(/^chg-across-/)
      expect(n).toBeGreaterThanOrEqual(1)
      expect(n).toBeLessThanOrEqual(3)
    }
    for (const e of p.events) expect(e.lastSeenAtMs).toBeGreaterThanOrEqual(cutoff)
  })

  /*
   * Found by this test (23 Sep 2026), fixed: `deployAlarms` skipped every
   * release that ended before the retention cutoff. The header says the older
   * alarms «exist only as what they left behind: the incidents they opened,
   * and those counters» (`Change.suppressed_events_purged`,
   * services/eventRetention.ts): a release older than ninety days had no
   * counter either, and across three years only the last three months of
   * changes showed what their releases silenced.
   */
  it('a release older than the retention still shows what it silenced: the alarms are gone, their number stays on the change', () => {
    const old = servers.map((srv, i) => release(`chg-old-${String(i)}`, srv.id, NOW - (120 + 10 * i) * DAY))
    const p = plan(w, { deployWindows: old })
    expect(p.purgedByChange.size).toBeGreaterThan(0)
    for (const [changeId, n] of p.purgedByChange) {
      expect(changeId).toMatch(/^chg-old-/)
      expect(n).toBeGreaterThanOrEqual(1)
      expect(n).toBeLessThanOrEqual(3)
    }
    expect(p.events).toEqual([])
  })

  /*
   * Found by this test (23 Sep 2026), fixed: the blip was drawn 5-70% into
   * the window and cleared 2-25 minutes later without looking at the
   * window's end: in a one-hour release — a slot `changes.ts` gives one
   * release in five — it could clear after the release closed, where the
   * engine lifts it and correlates it on its own. It now clears inside it.
   */
  it('an alarm silenced by a release clears before the release ends: one still firing then is lifted by the engine', () => {
    const hourLong = Array.from({ length: 200 }, (_, i) => release(`chg-1h-${String(i)}`, servers[i % servers.length]!.id, NOW - 80 * DAY + i * 9 * HOUR, 1))
    const p = plan(w, { deployWindows: hourLong })
    const byChange = new Map(hourLong.map((d) => [d.changeId, d]))
    expect(p.events.length).toBeGreaterThan(0)
    for (const e of p.events) {
      expect(e.resolvedAtMs!).toBeLessThan(byChange.get(e.suppressedByChangeId!)!.endMs)
      expect(e).toMatchObject({ status: 'resolved', correlation: 'suppressed', incidentId: null })
      expect(e.history.some((h) => h.kind === 'unsuppressed')).toBe(false)
    }
  })

  it('a warning still firing when a release on its CI ended was lifted then and decided by the threshold: skipped, the SUPPRESSED_BY history kept', () => {
    // A server whose alarms all fall inside a release that ended a week ago, and last beyond it.
    const srv = ci('Server', 'lift-01')
    const retired = [
      ci('DatabaseInstance', 'lift-pg', { status: 'decommissioned' }), ci('Application', 'Lift Ledger', { status: 'decommissioned' }),
      ci('Database', 'lift_ledger', { status: 'decommissioned' }),
    ]
    const long = release('chg-long', srv.id, NOW - 30 * DAY, 23 * 24)
    const p = plan(worldOf([srv, ...retired]), { alarmCycles: 6000, deployWindows: [long], policy: { ...FACTORY, retentionDays: 0 } }, 'monitoring-more/lift')
    const lifted = p.events.filter((e) => e.history.some((h) => h.kind === 'unsuppressed'))
    expect(lifted.length).toBeGreaterThan(0)
    for (const e of lifted) {
      expect(e.history.find((h) => h.kind === 'unsuppressed')).toEqual({ kind: 'unsuppressed', atMs: long.endMs + MINUTE, changeId: 'chg-long' })
      expect(e).toMatchObject({ severity: 'warning', correlation: 'skipped_severity', suppressedByChangeId: 'chg-long', incidentId: null })
      expect(e.correlatedAtMs).toBeGreaterThan(long.endMs)
    }
    expect(p.events.filter((e) => e.status === 'suppressed')).toEqual([])
  })

  it('a warning a release still running now would keep silenced is not planted: the engine would decide it after the run', () => {
    const srv = ci('Server', 'still-01')
    const retired = [
      ci('DatabaseInstance', 'still-pg', { status: 'decommissioned' }), ci('Application', 'Still Ledger', { status: 'decommissioned' }),
      ci('Database', 'still_ledger', { status: 'decommissioned' }),
    ]
    // Running for the last two weeks, and for two more hours.
    const running = { changeId: 'chg-running', ciIds: [srv.id], startMs: NOW - 14 * DAY, endMs: NOW + 2 * HOUR }
    const input = { alarmCycles: 20000, policy: { ...FACTORY, retentionDays: 0 } }
    const firingThrough = (q: MonitoringPlan) => q.events.filter((e) => e.firstSeenAtMs >= running.startMs && e.resolvedAtMs === null)
    // Without the release, some warnings of those two weeks are still firing now...
    expect(firingThrough(plan(worldOf([srv, ...retired]), input, 'monitoring-more/still')).length).toBeGreaterThan(0)
    // ...with it, none is planted: only those that cleared during it, silenced.
    const p = plan(worldOf([srv, ...retired]), { ...input, deployWindows: [running] }, 'monitoring-more/still')
    expect(firingThrough(p)).toEqual([])
    expect(p.events.filter((e) => e.status === 'suppressed')).toEqual([])
    const silenced = p.events.filter((e) => e.suppressedByChangeId === 'chg-running')
    expect(silenced.length).toBeGreaterThan(0)
    for (const e of silenced) expect(e).toMatchObject({ status: 'resolved', correlation: 'suppressed' })
  })
})

// ── The retention of the tenant ──────────────────────────────────────────────

describe('retention_days 0: a tenant that never deletes an alarm', () => {
  const young = ci('Application', 'Onboarding', { createdAtMs: NOW - 100 * DAY })
  const w = worldOf([...estate('keep'), ci('Server', 'keep-srv-02'), young])
  const forever = plan(w, { alarmCycles: 600, openedTarget: 20, policy: { ...FACTORY, retentionDays: 0 } }, 'monitoring-more/forever')

  it('every alarm cycle of the three years is still there, and no counter was left because nothing was deleted', () => {
    expect(forever.events).toHaveLength(600)
    expect(forever.born).toHaveLength(20)
    expect(forever.purgedByIncident.size).toBe(0)
    expect(forever.purgedByChange.size).toBe(0)
  })

  it('the warnings spread over the whole period, where ninety days keep only the last months', () => {
    const warnings = forever.events.filter((e) => e.correlation === 'skipped_severity')
    expect(Math.min(...warnings.map((e) => e.firstSeenAtMs))).toBeLessThan(START + 60 * DAY)
    expect(warnings.filter((e) => e.firstSeenAtMs < NOW - 365 * DAY).length / warnings.length).toBeGreaterThan(0.5)
    const ninety = plan(w, { alarmCycles: 600, openedTarget: 20 }, 'monitoring-more/forever')
    const cutoff = NOW - FACTORY.retentionDays * DAY
    const kept = ninety.events.filter((e) => e.correlation === 'skipped_severity')
    expect(kept.length).toBeGreaterThan(0)
    // A week before the cutoff too: an alarm that started before it and was still firing after it survives.
    for (const e of kept) expect(e.firstSeenAtMs).toBeGreaterThanOrEqual(cutoff - 7 * DAY)
  })

  it('a CI alarms only once it is in the CMDB', () => {
    const onYoung = forever.events.filter((e) => e.ciId === young.id)
    expect(onYoung.length).toBeGreaterThan(0)
    for (const e of onYoung) expect(e.firstSeenAtMs).toBeGreaterThanOrEqual(young.createdAtMs)
  })

  it('a warning on a kind of CI where nothing is running is not invented: that cycle is dropped', () => {
    const retired = ci('Database', 'retired_ledger', { status: 'decommissioned' })
    const p = plan(worldOf([ci('Server', 'drop-srv'), ci('DatabaseInstance', 'drop-pg'), ci('Application', 'Drop Ledger'), retired]),
      { alarmCycles: 400, policy: { ...FACTORY, retentionDays: 0 } })
    expect(p.events.filter((e) => e.ciId === retired.id)).toEqual([])
    // The database kinds are about a seventh of the warnings: those, and only those, are gone.
    expect(p.events.length).toBeLessThan(400)
    expect(p.events.length).toBeGreaterThan(300)
  })
})

// ── The threshold of the policy ──────────────────────────────────────────────

describe("the policy's open_incident_from", () => {
  it('is the product\'s own rule, meetsOpenThreshold (grouping.ts), for every severity and every threshold of the Event Policy', () => {
    for (const openFrom of OPEN_INCIDENT_FROM) {
      for (const severity of EVENT_SEVERITIES) expect(alarmMeetsThreshold(severity, openFrom), `${severity} / ${openFrom}`).toBe(meetsOpenThreshold(severity, openFrom))
    }
    expect(() => plan(worldOf(estate('bad')), { policy: { ...FACTORY, openFrom: 'major' } }))
      .toThrow('planMonitoring: open_incident_from "major" is not a threshold of the Event Policy (info, warning, critical, never)')
    expect(() => alarmMeetsThreshold('major', 'critical')).toThrow('planMonitoring: "major" is not an alarm severity')
  })

  /*
   * Found by this test (23 Sep 2026), fixed: `opens()` knew info, warning and
   * critical and fell back to rank 2, so `never` — a choice of the Event
   * Policy page (eventVocabularies.ts:131) — was read as `critical`. The
   * engine's `meetsOpenThreshold` (grouping.ts:74) lets nothing through with
   * `never`: every alarm is `skipped_severity`, none joins a person's
   * incident, and incidents born from alarms cannot be planned.
   */
  it("with 'never' no alarm opens or joins an incident: the engine lets none through", () => {
    const servers = Array.from({ length: 6 }, (_, i) => ci('Server', `never-${String(i)}`))
    const humanWindows = servers.map((srv, i) => ({ id: `inc-never-${String(i)}`, ciId: srv.id, fromMs: NOW - (10 + i) * DAY, toMs: NOW - (10 + i) * DAY + 6 * HOUR }))
    const p = plan(worldOf(servers), { humanWindows, attachShare: 1, policy: { ...FACTORY, openFrom: 'never' } })
    expect(p.born).toEqual([])
    expect(p.events.length).toBeGreaterThan(0)
    for (const e of p.events) expect(e).toMatchObject({ correlation: 'skipped_severity', incidentId: null })
    // Incidents from alarms the policy never opens: the plan stops instead of writing them.
    expect(() => plan(worldOf(estate('never')), { openedTarget: 3, policy: { ...FACTORY, openFrom: 'never' } }))
      .toThrow('planMonitoring: 3 incidents born from alarms are planned, and the event policy opens none (open_incident_from: never)')
  })

  /*
   * Found by this test (23 Sep 2026), fixed: «the incidents born from an
   * alarm: EXACTLY as many as planned» was checked when `bornAlarms` ended,
   * but `warnings()` ran after it and opened an incident for every warning
   * the threshold let through: with `open_incident_from: warning` the
   * warnings opened incidents on top of the planned ones, and verify.ts:286
   * («incidents opened by monitoring: N (planned M)») failed. The count is
   * now checked once every alarm is decided (`assertBornCount`): exact when
   * the warnings open none, the run stops — saying why — when they do.
   */
  it("with 'warning' the incidents born from alarms are still exactly the planned ones, or the run stops saying why", () => {
    const warn = { ...FACTORY, openFrom: 'warning' }
    expect(() => plan(worldOf(estate('warn')), { alarmCycles: 3000, openedTarget: 5, policy: warn }))
      .toThrow(/^planMonitoring: \d+ incidents born from alarms, 5 planned — \d+ opened by alarms below critical: open_incident_from is «warning», and the demo plans its incidents from critical alarms$/)
    // No warning to plan: the criticals give exactly the planned ones, under the same threshold.
    expect(plan(worldOf(estate('warn')), { alarmCycles: 0, openedTarget: 5, policy: warn }).born).toHaveLength(5)
  })

  /*
   * Whatever the threshold, an alarm on a CI with an incident open joins it
   * (group_by: ci), and the nightly job keeps the alarms of an incident still
   * open. With `critical` the warnings join nothing; with `warning` — a
   * choice of the Event Policy page — they do.
   */
  it("with 'warning', a warning joins the incident open on its CI, and while that incident is open its alarms stay whatever their age", () => {
    const srv = ci('Server', 'grp-srv')
    const retired = [
      ci('DatabaseInstance', 'grp-pg', { status: 'decommissioned' }), ci('Application', 'Grp Ledger', { status: 'decommissioned' }),
      ci('Database', 'grp_ledger', { status: 'decommissioned' }),
    ]
    // A person's incident open on the server the whole time.
    const allAlong: IncidentWindow = { id: 'inc-all-along', ciId: srv.id, fromMs: START, toMs: NOW }
    const days = 3
    const p = plan(worldOf([srv, ...retired]), { alarmCycles: 30000, humanWindows: [allAlong], policy: { ...FACTORY, openFrom: 'warning', retentionDays: days } }, 'monitoring-more/group-0')
    expect(p.born).toEqual([])
    expect(p.events.length).toBeGreaterThan(0)
    for (const e of p.events) expect(e).toMatchObject({ severity: 'warning', correlation: 'attached', incidentId: allAlong.id })
    const old = p.events.filter((e) => e.lastSeenAtMs < NOW - days * DAY && e.status !== 'firing')
    expect(old.length).toBeGreaterThan(0)
    expect(p.purgedByIncident.size).toBe(0)
  })
})

// ── The fail-loud guards ─────────────────────────────────────────────────────

describe('the incidents born from alarms are exactly the planned ones, or the run stops', () => {
  it('the certificates alone cannot open more than planned: the run stops instead of dropping some', () => {
    const certs = Array.from({ length: 30 }, (_, i) => certificate(`old-${String(i)}.bank.example`, NOW - 40 * DAY))
    expect(() => plan(worldOf(certs), { openedTarget: 0 }))
      .toThrow(/^planMonitoring: the certificates alone open [1-9]\d* incidents, more than the 0 planned$/)
  })

  it('an alarm that finds no CI free, even moved by hours, stops the run: an incident is never silently dropped', () => {
    const cis = estate('busy')
    const alwaysOpen = cis.map((c, i) => ({ id: `inc-forever-${String(i)}`, ciId: c.id, fromMs: START, toMs: NOW }))
    expect(() => plan(worldOf(cis), { openedTarget: 1, humanWindows: alwaysOpen }))
      .toThrow(/^planMonitoring: no CI free for an alarm around \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('a target that is not a whole number of incidents stops the run: it cannot be met exactly', () => {
    expect(() => plan(worldOf(estate('frac')), { openedTarget: 2.5 }))
      .toThrow(/^planMonitoring: 3 incidents born from alarms, 2\.5 planned$/)
  })

  it('an instant where the only running CI is being released moves by some hours instead of being dropped', () => {
    const srv = ci('Server', 'core-01')
    const retired = [
      ci('DatabaseInstance', 'core-pg', { status: 'decommissioned' }), ci('Application', 'Core Ledger', { status: 'decommissioned' }),
      ci('Database', 'core_ledger', { status: 'decommissioned' }),
    ]
    const w = worldOf([srv, ...retired])
    const morning = (b: { firstSeenMs: number }): boolean => new Date(b.firstSeenMs).getUTCHours() < 12
    // Left alone, the same instants put some of these incidents in the morning (UTC)...
    const free = plan(w, { openedTarget: 12 })
    expect(free.born.filter(morning).length).toBeGreaterThan(0)
    // ...but a release runs on the only CI every day from midnight to noon: those instants move.
    const firstDay = Math.floor(START / DAY) * DAY + DAY
    const releases = Array.from({ length: Math.floor((NOW - firstDay) / DAY) }, (_, i) => release(`chg-am-${String(i)}`, srv.id, firstDay + i * DAY, 12))
    const p = plan(w, { openedTarget: 12, deployWindows: releases })
    expect(p.born).toHaveLength(12)
    for (const b of p.born) expect(b.ciId).toBe(srv.id)
    expect(p.born.filter(morning)).toEqual([])
  })
})

// ── What the tools send ──────────────────────────────────────────────────────

describe('what the tools send (D35, D37)', () => {
  it('D35: Alertmanager and Grafana repeat a firing alert every four hours; Dynatrace notifies a problem, and again only on a change', () => {
    const rng = new Rng('monitoring-more/occurrences')
    expect(occurrences(rng, 'prometheus', 0, 4 * HOUR - 1)).toBe(1)
    expect(occurrences(rng, 'prometheus', 0, 4 * HOUR)).toBe(2)
    expect(occurrences(rng, 'grafana', 0, 9 * HOUR)).toBe(3)
    // A last sighting before the first counts as the one notification there was.
    expect(occurrences(rng, 'prometheus', 5 * HOUR, 0)).toBe(1)
    for (let i = 0; i < 50; i++) expect(occurrences(rng, 'dynatrace', 0, HOUR)).toBe(1)
    // Past the hour: one to three, however long it lasts — not a timer.
    expect(new Set(Array.from({ length: 200 }, () => occurrences(rng, 'dynatrace', 0, 30 * DAY)))).toEqual(new Set([1, 2, 3]))
  })

  /*
   * `planToolNames` names every kind of CI a tool alarms on, so in a run
   * every alarm carries the tool's own name (D37, monitoring.test.ts). The
   * names are an input, though: for a CI they do not cover — names planned
   * over another CMDB — the connector falls back, without a word, to the
   * CMDB's name, the very «SRV_…» D37 removed. Pinned as it is today.
   */
  it('a CI the tool names do not cover is sent under its CMDB name, and Dynatrace with no entity id', () => {
    const cis = [...estate('anon'), certificate('anon.bank.example', NOW - 20 * DAY)]
    const w = worldOf(cis)
    const nameless: ToolNames = { byCI: new Map(), aliases: [] }
    const p = plan(w, { alarmCycles: 400, openedTarget: 8, names: nameless, policy: { ...FACTORY, retentionDays: 0 } })
    expect(new Set(p.events.map((e) => e.sourceKey))).toEqual(new Set(['prometheus', 'grafana', 'dynatrace']))
    expect(new Set(p.events.map((e) => w.cmdb.byId.get(e.ciId)!.label)).size).toBe(cis.length)
    for (const e of p.events) {
      const c = w.cmdb.byId.get(e.ciId)!
      expect(e.resource).toBe(c.name)
      expect(e.resourceExternalId).toBeNull()
      if (e.sourceKey === 'dynatrace') expect(e.labels['dynatrace_entity']).toBe('')
      else expect(e.labels['instance']).toBe(e.sourceKey === 'prometheus' ? `${c.name}:${c.label === 'Certificate' ? '443' : '9100'}` : c.name)
    }
  })
})
