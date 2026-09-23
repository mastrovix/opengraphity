/**
 * THE HISTORY OF THE MONITORED SERVICES (tour of 23 Sep 2026, D43).
 *
 * The maps are created with the product's own mutation, which evaluates them
 * «now»: every service was «Operational for 40 min», born at the minute of the
 * generation. A service watched for two months has two months of health
 * behind it. What is pinned here:
 *
 *  - the history is one entry per CHANGE of health, the worst of what fires on
 *    the components (a critical alarm on a critical component takes the
 *    service down, anything else degrades it), and the return;
 *  - it starts from the health the service had when it was set up — an alarm
 *    that began before and was still firing then included — and the
 *    creation's own entry says that health, so the next entry leaves from it;
 *  - what the engine ignores is not in it: alarms silenced until they cleared,
 *    informational ones, alarms over before the map was set up, components
 *    that never propagate; an alarm lifted from a release counts from the
 *    lift, a certificate that escalated is degraded, then down;
 *  - each entry is written as the engine writes it (trigger `ci_health`, an
 *    INTEGER impact score capped at 100, the causes with their CI references);
 *  - «since when» is the start of what caused the health the engine computed
 *    now, or the setting up of the map when nothing did;
 *  - the map is dated when it was set up, and what the creation wrote «now» is
 *    cleaned BEFORE the history is added (the clean-up deletes every entry
 *    that is not the creation's: the other way round it would delete the
 *    history just written).
 *
 * Neo4j and the writer are fakes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import neo4j from 'neo4j-driver'
import type { Session } from 'neo4j-driver'
import { SERVICE_HEALTHS, SERVICE_HEALTH_TRIGGERS } from '../../../serviceVocabularies.js'
import type { StoredCause } from '../../../../services/serviceImpact/history.js'
import type { PlannedEvent, PlannedEventHistory } from '../monitoring.js'
import type { DemoWriter } from '../writer.js'
import { Rng } from '../random.js'
import { DAY, HOUR, MINUTE } from '../clock.js'

interface MapRow {
  id: string
  health: string
  nodes: Array<{ ciId: string | null; name: string | null; label: string | null; weight: unknown; critical: boolean | null; propagate: string | null }>
}

const fake = vi.hoisted(() => ({
  maps: [] as unknown[],
  reads: [] as Array<{ text: string; params: Record<string, unknown> }>,
  writes: [] as Array<{ text: string; params: Record<string, unknown> }>,
  children: [] as Array<{ parent: string; type: string; labels: readonly string[]; rows: ReadonlyArray<{ parent: string; props: Record<string, unknown> }> }>,
  order: [] as string[],
}))

vi.mock('@opengraphity/neo4j', () => ({
  runQuery: async (_session: unknown, text: string, params: Record<string, unknown>) => { fake.reads.push({ text, params }); return fake.maps },
}))

const { alarmSpans, backfillServiceHistory, healthAt, healthTimeline } = await import('../serviceHistory.js')

const session = {
  executeWrite: async (work: (tx: { run: (text: string, params: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
    work({ run: async (text, params) => { fake.writes.push({ text, params }); fake.order.push('clean'); return { records: [] } } }),
} as unknown as Session

const writer = {
  tenantId: 'demo', runId: 'run-1',
  children: async (parent: string, type: string, labels: readonly string[], rows: ReadonlyArray<{ parent: string; props: Record<string, unknown> }>) => {
    fake.children.push({ parent, type, labels, rows }); fake.order.push('history')
  },
} as unknown as DemoWriter

const NOW = Date.parse('2026-09-23T10:00:00.000Z')
/** The maps were set up two months ago, as the generator does. */
const SET_UP = NOW - 60 * DAY
const at = (days: number, hours = 0) => SET_UP + days * DAY + hours * HOUR
const iso = (ms: number) => new Date(ms).toISOString()

/** An alarm as the monitoring plan leaves it: first seen at its severity, cleared at `to` (null: firing). */
function alarm(ciId: string, severity: string, from: number, to: number | null, correlation: PlannedEvent['correlation'] = 'opened', more: PlannedEventHistory[] = []): PlannedEvent {
  return {
    ciId, severity, correlation, firstSeenAtMs: from, resolvedAtMs: to,
    history: [{ kind: 'first_seen', atMs: from, severity: more.some((h) => h.kind === 'severity_changed') ? 'warning' : severity }, ...more],
  } as PlannedEvent
}

const node = (ciId: string, name: string, label: string | null, weight: unknown, critical: boolean | null, propagate: string | null = 'always') =>
  ({ ciId, name, label, weight, critical, propagate })

/** The payment service: a critical database, an application, a load balancer without a type label, a certificate that never propagates. */
const PAY: MapRow = {
  id: 'map-pay', health: 'down', nodes: [
    node('ci-db', 'DB_PAY', 'Database', 10, true),
    node('ci-app', 'APP_PAY', 'Application', null, false, 'weighted'),
    node('ci-lb', 'LB_PAY', null, 3, false),
    node('ci-cert', 'CERT_PAY', 'Certificate', 2, true, 'never'),
  ],
}
/** Two critical components that fail together. */
const CORE: MapRow = { id: 'map-core', health: 'operational', nodes: [node('ci-inst', 'INST_CORE', 'DatabaseInstance', 10, true), node('ci-srv', 'SRV_CORE', 'Server', 10, true)] }
/** A map with no component at all: the OPTIONAL MATCH gives one row of nulls. */
const EMPTY: MapRow = { id: 'map-empty', health: 'operational', nodes: [{ ciId: null, name: null, label: null, weight: null, critical: null, propagate: null }] }
/** The engine says degraded now, and no alarm of the last two months explains it. */
const UNEXPLAINED: MapRow = { id: 'map-unexplained', health: 'degraded', nodes: [node('ci-quiet', 'SRV_QUIET', 'Server', 5, true)] }

const EVENTS: PlannedEvent[] = [
  // Began five days before the setting up, and was still firing then: the service was down when it was set up.
  alarm('ci-db', 'critical', SET_UP - 5 * DAY, at(1)),
  alarm('ci-db', 'critical', at(10), at(10, 2)),
  alarm('ci-app', 'major', at(20), at(21)),
  // A critical alarm on a component that is not critical only degrades the service.
  alarm('ci-app', 'critical', at(30), at(30, 1)),
  alarm('ci-lb', 'warning', at(35), at(35, 3)),
  // Never in the history: a component that never propagates, an alarm silenced until it cleared, an informational one, one over before the map.
  alarm('ci-cert', 'critical', at(40), at(41)),
  alarm('ci-db', 'critical', at(45), at(45, 1), 'suppressed'),
  alarm('ci-db', 'info', at(46), at(46, 1)),
  alarm('ci-db', 'critical', SET_UP - 9 * DAY, SET_UP - 8 * DAY),
  // Still firing now.
  alarm('ci-db', 'critical', NOW - 2 * HOUR, null),
  alarm('ci-inst', 'critical', at(50), at(50, 4)),
  alarm('ci-srv', 'critical', at(50), at(50, 4)),
]

beforeEach(() => {
  fake.maps = [PAY, CORE, EMPTY, UNEXPLAINED]
  fake.reads = []
  fake.writes = []
  fake.children = []
  fake.order = []
})

async function backfill(events: readonly PlannedEvent[] = EVENTS): Promise<number> {
  return backfillServiceHistory(session, writer, new Rng('service-history'), events, SET_UP, NOW)
}
const entriesOf = (mapId: string) => fake.children.flatMap((c) => c.rows).filter((r) => r.parent === mapId).map((r) => r.props)
const causesOf = (props: Record<string, unknown>) => JSON.parse(props['cause'] as string) as StoredCause[]
const setUpOf = (mapId: string) => (fake.writes[fake.writes.length - 1]!.params['rows'] as Array<{ id: string; since: string; health: string; score: number; cause: string }>).find((r) => r.id === mapId)!

describe('D43: healthTimeline, the changes of health of one service', () => {
  it('two alarms of the same weight that overlap make one change, not two', () => {
    const t = healthTimeline([
      { ciId: 'a', health: 'degraded', from: 10, to: 40 },
      { ciId: 'b', health: 'degraded', from: 20, to: 30 },
    ], 0, 100)
    expect(t.map((x) => [x.at, x.previous, x.health])).toEqual([[10, 'operational', 'degraded'], [40, 'degraded', 'operational']])
  })

  it('a component down hides one degraded with it, whatever the order they come in', () => {
    const t = healthTimeline([
      { ciId: 'a', health: 'down', from: 10, to: 30 },
      { ciId: 'b', health: 'degraded', from: 10, to: 20 },
    ], 0, 100)
    expect(t.map((x) => [x.at, x.health])).toEqual([[10, 'down'], [30, 'operational']])
    expect(t[0]!.causes.map((c) => c.ciId)).toEqual(['a', 'b'])
    expect(t[1]!.causes).toEqual([])
  })

  it('it starts from the health at the setting up: what fired then is where it leaves from, and nothing is after now', () => {
    const intervals = [
      { ciId: 'a', health: 'degraded' as const, from: -5, to: 5 },
      { ciId: 'b', health: 'down' as const, from: 35, to: 50 },
    ]
    expect(healthAt(intervals, 0)).toEqual({ health: 'degraded', causes: [intervals[0]] })
    const t = healthTimeline(intervals, 0, 40)
    expect(t.map((x) => [x.at, x.previous, x.health])).toEqual([[5, 'degraded', 'operational'], [35, 'operational', 'down']])
  })

  it('no alarm, no history', () => {
    expect(healthTimeline([], 0, 100)).toEqual([])
    expect(healthAt([], 0)).toEqual({ health: 'operational', causes: [] })
  })
})

describe('D43: alarmSpans, when an alarm gave its CI a health', () => {
  it('from its first sighting to its clearing, at its severity', () => {
    expect(alarmSpans(alarm('c', 'warning', 10, 20))).toEqual([{ severity: 'warning', from: 10, to: 20 }])
    expect(alarmSpans(alarm('c', 'critical', 10, null))).toEqual([{ severity: 'critical', from: 10, to: null }])
  })

  it('a certificate warns first and turns critical in its last week: two spans', () => {
    const cert = alarm('c', 'critical', 10, 90, 'opened', [{ kind: 'severity_changed', atMs: 60, severity: 'critical' }])
    expect(alarmSpans(cert)).toEqual([{ severity: 'warning', from: 10, to: 60 }, { severity: 'critical', from: 60, to: 90 }])
  })

  it('silenced by a release it gave none: one silenced until it cleared gives nothing, one lifted counts from the lift', () => {
    expect(alarmSpans(alarm('c', 'warning', 10, 20, 'suppressed', [{ kind: 'suppressed', atMs: 10, changeId: 'chg' }]))).toEqual([])
    const lifted = alarm('c', 'warning', 10, 90, 'skipped_severity', [
      { kind: 'suppressed', atMs: 10, changeId: 'chg' }, { kind: 'unsuppressed', atMs: 40, changeId: 'chg' },
    ])
    expect(alarmSpans(lifted)).toEqual([{ severity: 'warning', from: 40, to: 90 }])
  })

  it('lifted after it escalated, it counts from the lift at the severity it had then; an entry without a severity is at the alarm\'s own', () => {
    const escalatedThenLifted = alarm('c', 'critical', 10, 90, 'opened', [
      { kind: 'severity_changed', atMs: 20, severity: 'critical' },
      { kind: 'suppressed', atMs: 25, changeId: 'chg' }, { kind: 'unsuppressed', atMs: 40, changeId: 'chg' },
    ])
    expect(alarmSpans(escalatedThenLifted)).toEqual([{ severity: 'critical', from: 40, to: 90 }])
    const bare = { ...alarm('c', 'warning', 10, 20), history: [{ kind: 'first_seen', atMs: 10 }] } as PlannedEvent
    expect(alarmSpans(bare)).toEqual([{ severity: 'warning', from: 10, to: 20 }])
  })
})

describe('D43: backfillServiceHistory', () => {
  it('reads the maps of this run, with their components', async () => {
    await backfill()
    expect(fake.reads).toHaveLength(1)
    expect(fake.reads[0]!.text).toContain('m.demo_run_id = $runId')
    expect(fake.reads[0]!.params).toEqual({ tenantId: 'demo', runId: 'run-1' })
  })

  it('one entry per change of health: a critical alarm on a critical component takes the service down, anything else degrades it', async () => {
    const n = await backfill()
    const pay = entriesOf('map-pay')
    expect(pay.map((e) => [e['at'], e['previous_health'], e['health']])).toEqual([
      // Down at the setting up: the alarm that began before it clears on the first day.
      [iso(at(1)), 'down', 'operational'],
      [iso(at(10)), 'operational', 'down'],
      [iso(at(10, 2)), 'down', 'operational'],
      [iso(at(20)), 'operational', 'degraded'],
      [iso(at(21)), 'degraded', 'operational'],
      [iso(at(30)), 'operational', 'degraded'],
      [iso(at(30, 1)), 'degraded', 'operational'],
      [iso(at(35)), 'operational', 'degraded'],
      [iso(at(35, 3)), 'degraded', 'operational'],
      [iso(NOW - 2 * HOUR), 'operational', 'down'],
    ])
    expect(n).toBe(fake.children.flatMap((c) => c.rows).length)
    expect(n).toBe(pay.length + entriesOf('map-core').length)
  })

  it('what the engine ignores is not in the history: silenced and informational alarms, alarms over before the map, components that never propagate', async () => {
    await backfill()
    const causes = entriesOf('map-pay').flatMap((e) => causesOf(e).map((c) => c.ciId))
    expect(causes).not.toContain('ci-cert')
    const moments = entriesOf('map-pay').map((e) => e['at'])
    for (const ignored of [at(40), at(41), at(45), at(46), SET_UP - 8 * DAY]) expect(moments).not.toContain(iso(ignored))
    // Only ignored alarms: nothing to tell, and the service was operational when it was set up.
    fake.maps = [PAY]
    expect(await backfill(EVENTS.filter((e) => e.correlation === 'suppressed' || e.severity === 'info' || e.ciId === 'ci-cert' || e.resolvedAtMs === SET_UP - 8 * DAY))).toBe(0)
    expect(setUpOf('map-pay')).toMatchObject({ health: 'operational', score: 0, cause: '[]' })
  })

  it('each entry is written as the engine writes it: trigger ci_health, the product\'s healths, an integer impact score, the causes with their CI', async () => {
    await backfill()
    const all = fake.children.flatMap((c) => c.rows)
    expect(fake.children.every((c) => c.parent === 'ServiceMap' && c.type === 'HAS_HEALTH_HISTORY' && c.labels.join() === 'ServiceHealthEntry')).toBe(true)
    for (const { parent, props } of all) {
      expect(props['map_id']).toBe(parent)
      expect(SERVICE_HEALTH_TRIGGERS).toContain(props['trigger'])
      expect(props['trigger']).toBe('ci_health')
      expect(SERVICE_HEALTHS).toContain(props['health'])
      expect(SERVICE_HEALTHS).toContain(props['previous_health'])
      expect(props['note']).toBeNull()
      expect(props['id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      // `toInteger` in the engine: an integer here too, never a float.
      expect(neo4j.isInt(props['impact_score'])).toBe(true)
    }
    expect(new Set(all.map((r) => r.props['id'])).size).toBe(all.length)
    const down = entriesOf('map-pay')[1]!
    expect(causesOf(down)).toEqual([{
      ciId: 'ci-db', health: 'down', weight: 10, critical: true,
      ci: { id: 'ci-db', name: 'DB_PAY', type: 'Database', health: 'down' }, path: [{ id: 'ci-db', name: 'DB_PAY', type: 'Database', health: 'down' }],
    }])
  })

  it('a component without a weight counts as 1, one without a type label is a ConfigurationItem', async () => {
    await backfill()
    const pay = entriesOf('map-pay')
    const app = causesOf(pay[3]!)[0]!
    expect(app).toMatchObject({ ciId: 'ci-app', health: 'degraded', weight: 1, critical: false })
    const lb = causesOf(pay[7]!)[0]!
    expect(lb.ci).toEqual({ id: 'ci-lb', name: 'LB_PAY', type: 'ConfigurationItem', health: 'degraded' })
  })

  it('the impact score: heavier for a component down than degraded, zero on the return, never above 100', async () => {
    await backfill()
    const score = (props: Record<string, unknown>) => (props['impact_score'] as ReturnType<typeof neo4j.int>).toNumber()
    const pay = entriesOf('map-pay')
    expect(score(pay[1]!)).toBeGreaterThan(score(pay[3]!))
    expect(score(pay[2]!)).toBe(0)
    expect(causesOf(pay[2]!)).toEqual([])
    // Two critical components down together.
    const [both, back] = entriesOf('map-core')
    expect(causesOf(both!).map((c) => c.ciId).sort()).toEqual(['ci-inst', 'ci-srv'])
    expect(score(both!)).toBe(100)
    expect(score(back!)).toBe(0)
  })

  it('an alarm lifted from a release counts from the lift, and a certificate that escalated degrades the service before taking it down', async () => {
    fake.maps = [{ id: 'map-tls', health: 'operational', nodes: [node('ci-web', 'SRV_WEB', 'Server', 5, true), node('ci-crt', 'CERT_WEB', 'Certificate', 5, true)] }]
    const n = await backfill([
      alarm('ci-web', 'warning', at(5), at(6), 'skipped_severity', [{ kind: 'suppressed', atMs: at(5), changeId: 'chg' }, { kind: 'unsuppressed', atMs: at(5, 4), changeId: 'chg' }]),
      alarm('ci-crt', 'critical', at(20), at(28), 'opened', [{ kind: 'severity_changed', atMs: at(26), severity: 'critical' }]),
    ])
    expect(n).toBe(5)
    expect(entriesOf('map-tls').map((e) => [e['at'], e['previous_health'], e['health']])).toEqual([
      [iso(at(5, 4)), 'operational', 'degraded'], [iso(at(6)), 'degraded', 'operational'],
      [iso(at(20)), 'operational', 'degraded'], [iso(at(26)), 'degraded', 'down'], [iso(at(28)), 'down', 'operational'],
    ])
  })

  it('«since when»: the start of what caused the health computed now, or the setting up when nothing did', async () => {
    await backfill()
    // Down now since the alarm still firing started.
    expect(setUpOf('map-pay').since).toBe(iso(NOW - 2 * HOUR))
    // Operational since the last return.
    expect(setUpOf('map-core').since).toBe(iso(at(50, 4)))
    // Nothing happened, or nothing explains the health: since the map was set up.
    expect(setUpOf('map-empty').since).toBe(iso(SET_UP + MINUTE))
    expect(setUpOf('map-unexplained').since).toBe(iso(SET_UP + MINUTE))
    expect(entriesOf('map-empty')).toEqual([])
    expect(entriesOf('map-unexplained')).toEqual([])
  })

  it('the map is dated when it was set up, and what the creation wrote «now» is cleaned before the history is added', async () => {
    await backfill()
    expect(fake.order).toEqual(['clean', 'history'])
    const [clean] = fake.writes
    expect(clean!.params).toMatchObject({ tenantId: 'demo', created: iso(SET_UP) })
    expect(clean!.text).toContain('SET m.created_at = $created, m.health_since = row.since')
    // The evaluation the creation made «now» goes; the creation's own entry stays, moved to the setting up.
    expect(clean!.text).toContain('CASE WHEN h IS NOT NULL AND h.trigger <> \'created\' THEN [1] ELSE [] END | DETACH DELETE h')
    expect((clean!.params['rows'] as unknown[]).length).toBe(4)
  })

  /*
   * Found by this test (23 Sep 2026), fixed: the creation's own entry was
   * moved to the setting up (`SET h.at = $created`) but kept what the
   * creation had evaluated at the GENERATION — its health and its causes.
   * For a service down at the generation, the oldest entry of its history
   * said it was already down two months before, because of an alarm that
   * started two hours ago, and the next entry said «operational → down».
   * The entry now says the health the service had when it was set up, and
   * the history leaves from it (serviceHistory.ts, `healthAt` and the
   * clean-up statement).
   */
  it('the entry of the setting up says the health the history starts from, not the one computed at the generation', async () => {
    await backfill()
    const [clean] = fake.writes
    expect(clean!.text).toContain('CASE WHEN h.trigger = \'created\' THEN [1] ELSE [] END |')
    expect(clean!.text).toContain('SET h.at = $created, h.health = row.health, h.impact_score = toInteger(row.score), h.cause = row.cause')
    // The payment service was down when it was set up — the alarm that began before — and its first entry leaves from there.
    const pay = setUpOf('map-pay')
    expect(pay).toMatchObject({ health: 'down', score: 80 })
    expect(JSON.parse(pay.cause)).toEqual([expect.objectContaining({ ciId: 'ci-db', health: 'down' })])
    expect(entriesOf('map-pay')[0]!['previous_health']).toBe(pay.health)
    // The others were operational, with nothing to blame.
    for (const id of ['map-core', 'map-empty', 'map-unexplained']) {
      expect(setUpOf(id)).toMatchObject({ health: 'operational', score: 0, cause: '[]' })
      const first = entriesOf(id)[0]
      if (first) expect(first['previous_health']).toBe('operational')
    }
  })

  it('the same seed writes the same history', async () => {
    await backfill()
    const first = fake.children.flatMap((c) => c.rows.map((r) => r.props['id']))
    fake.children = []
    await backfill()
    expect(fake.children.flatMap((c) => c.rows.map((r) => r.props['id']))).toEqual(first)
  })
})
