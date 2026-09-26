/**
 * THE CASES OF THE OPERATIONAL REMEDIES, PUT IN A TENANT BY HAND (26 Sep 2026).
 *
 * The owner wants to try every case of the self-analysis «uno alla volta»:
 * each scenario here PLANTS the condition a detector looks for, and CLEANS it
 * afterwards, putting back what it changed. Nothing runs by itself: the CLI
 * (`scripts/operations-scenarios.ts`) is launched by hand, one case at a time,
 * with the owner's go.
 *
 * Every node a scenario touches carries `scenario` (its name) and
 * `scenario_backup` (the properties it overwrote, as JSON): the clean reads
 * them back, so it restores exactly what was there — including «not there».
 */
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { getTenantQueue } from '../bullmq.js'
import { resolveCILifecycleSemantics } from '../ciLifecycle.js'

export const SCENARIOS = ['ci-health', 'failed-job', 'map-late', 'alarm-stuck', 'lost-timer'] as const
export type Scenario = (typeof SCENARIOS)[number]

export function isScenario(v: string): v is Scenario {
  return (SCENARIOS as readonly string[]).includes(v)
}

type Log = (m: string) => void

/** The name of the job the queue does not know: it fails every time, and touches nothing. */
export const ALWAYS_FAILING_JOB = 'scenario_always_fails'
/** The queue a failing job goes to by default; another can be chosen (a cause has one proposal a day). */
const FAILING_QUEUE = 'workflow-jobs'
/** The queues whose worker refuses a job name it does not know: the failing job fails there and nowhere else. */
const FAILING_QUEUES: readonly string[] = ['workflow-jobs', 'notification-jobs']

export interface ScenarioOptions { queue?: string }

/** Who acted, in the histories a clean writes: the trial, not a person. */
const SCENARIO_ACTOR = 'system:operations-scenario'

const minutesAgo = (now: Date, m: number) => new Date(now.getTime() - m * 60_000).toISOString()

// ── ci-health: a CI shown «down» with no alarm at all ───────────────────────

/** The health properties the scenario overwrites, restored by the clean. */
const CI_HEALTH_FIELDS = ['health', 'health_source', 'last_event_at', 'health_since'] as const

async function plantCIHealth(tenantId: string, now: Date, log: Log): Promise<void> {
  const lifecycle = await resolveCILifecycleSemantics(tenantId)
  const session = getSession(undefined, 'WRITE')
  try {
    const ci = await runQueryOne<{ id: string; name: string; backup: string }>(session, `
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
      WHERE ci.scenario IS NULL AND coalesce(ci.health_source, 'monitoring') = 'monitoring'
        AND NOT coalesce(ci.status, '') IN $maintenance AND coalesce(ci.health, 'operational') = 'operational'
        AND NOT EXISTS { MATCH (e:Event {tenant_id: $tenantId})-[:RAISED_ON]->(ci) WHERE e.status IN ['firing', 'flapping'] }
      WITH ci ORDER BY ci.name LIMIT 1
      SET ci.scenario = 'ci-health',
          ci.scenario_backup = apoc.convert.toJson({health: ci.health, health_source: ci.health_source, last_event_at: ci.last_event_at, health_since: ci.health_since}),
          ci.health = 'down', ci.health_source = 'monitoring', ci.last_event_at = $hourAgo, ci.health_since = $hourAgo
      RETURN ci.id AS id, ci.name AS name, ci.scenario_backup AS backup
    `, { tenantId, maintenance: [...lifecycle.maintenance], hourAgo: minutesAgo(now, 60) })
    if (!ci) throw new Error(`${tenantId}: no CI without alarms to plant the case on`)
    log(`CI «${ci.name}» (${ci.id}) is now «down» with no alarm at all, last alarm news an hour ago`)
  } finally {
    await session.close()
  }
}

async function cleanCIHealth(tenantId: string, log: Log): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    const rows = await runQuery<{ id: string; name: string; backup: string | null }>(session, `
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId, scenario: 'ci-health'})
      RETURN ci.id AS id, ci.name AS name, ci.scenario_backup AS backup
    `, { tenantId })
    for (const r of rows) {
      const backup = JSON.parse(r.backup ?? '{}') as Record<string, unknown>
      const restore = Object.fromEntries(CI_HEALTH_FIELDS.map((f) => [f, backup[f] ?? null]))
      // SET to null removes the property: «not there» is restored as «not there».
      await runQuery(session, `
        MATCH (ci:ConfigurationItem {tenant_id: $tenantId, id: $id})
        SET ci.health = $r.health, ci.health_source = $r.health_source, ci.last_event_at = $r.last_event_at, ci.health_since = $r.health_since
        REMOVE ci.scenario, ci.scenario_backup
      `, { tenantId, id: r.id, r: restore })
      log(`CI «${r.name}» put back as it was (health ${String(restore['health'] ?? 'none')})`)
    }
    if (rows.length === 0) log('no CI of this case to put back')
  } finally {
    await session.close()
  }
}

// ── failed-job: a job that fails every time ─────────────────────────────────

function failingQueue(opts: ScenarioOptions): string {
  const q = opts.queue ?? FAILING_QUEUE
  if (!FAILING_QUEUES.includes(q)) throw new Error(`the failing job goes to ${FAILING_QUEUES.join(' or ')}, not "${q}"`)
  return q
}

async function plantFailedJob(tenantId: string, now: Date, log: Log, opts: ScenarioOptions = {}): Promise<void> {
  const name = failingQueue(opts)
  const queue = getTenantQueue(name, tenantId)
  const jobId = `scenario-always-fails-${String(now.getTime())}`
  await queue.add(ALWAYS_FAILING_JOB, { tenantId, entityId: 'scenario' }, { jobId, attempts: 1, removeOnFail: false })
  log(`job ${jobId} added to ${name}: the queue does not know «${ALWAYS_FAILING_JOB}», so it fails — and fails again if retried`)
}

async function cleanFailedJob(tenantId: string, log: Log, opts: ScenarioOptions = {}): Promise<void> {
  const name = failingQueue(opts)
  const queue = getTenantQueue(name, tenantId)
  const jobs = await queue.getJobs(['failed', 'waiting', 'delayed', 'completed'], 0, 999, true)
  let removed = 0
  for (const j of jobs) {
    if (j.name !== ALWAYS_FAILING_JOB) continue
    await j.remove()
    removed += 1
  }
  log(`${String(removed)} job(s) of this case removed from ${name}`)
}

// ── map-late: a live service map the synchronization left behind ────────────

async function plantMapLate(tenantId: string, now: Date, log: Log): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    const m = await runQueryOne<{ id: string; name: string }>(session, `
      MATCH (m:ServiceMap {tenant_id: $tenantId})
      WHERE m.scenario IS NULL AND m.auto_sync = true AND m.status = 'active' AND coalesce(m.stale, false) = false
        // A map with a remedy proposed today would not get another one (one per cause per day): take the next.
        AND NOT EXISTS { MATCH (p:Proposal {tenant_id: $tenantId, area: 'operations'}) WHERE p.cause = 'service_map:' + m.id AND p.created_at >= $today }
      WITH m ORDER BY m.name LIMIT 1
      SET m.scenario = 'map-late',
          m.scenario_backup = apoc.convert.toJson({auto_sync: m.auto_sync}),
          m.synced_at = $twoHoursAgo
      RETURN m.id AS id, m.name AS name
    `, { tenantId, twoHoursAgo: minutesAgo(now, 120), today: now.toISOString().slice(0, 10) })
    if (!m) throw new Error(`${tenantId}: no live service map to plant the case on`)
    log(`service map «${m.name}» (${m.id}) now looks unsynchronized for two hours — analyse at once: the safety pass syncs it within 30 minutes`)
  } finally {
    await session.close()
  }
}

async function cleanMapLate(tenantId: string, log: Log): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    const rows = await runQuery<{ id: string; name: string; autoSync: boolean | null }>(session, `
      MATCH (m:ServiceMap {tenant_id: $tenantId, scenario: 'map-late'})
      WITH m, apoc.convert.fromJsonMap(coalesce(m.scenario_backup, '{}')) AS b
      SET m.auto_sync = coalesce(b.auto_sync, m.auto_sync)
      REMOVE m.scenario, m.scenario_backup
      RETURN m.id AS id, m.name AS name, m.auto_sync AS autoSync
    `, { tenantId })
    for (const r of rows) log(`service map «${r.name}» put back (auto sync ${String(r.autoSync)})`)
    if (rows.length === 0) log('no service map of this case to put back')
    /*
     * And synchronized, as the plant made it look late (26 Sep 2026): the
     * first clean only took the marks away, and the map stayed «behind the
     * CMDB» — its proposal came back at the next analysis. A paused map is
     * left as it is: the synchronization refuses it, and resuming it is the
     * admin's gesture.
     */
    const { syncServiceMap } = await import('../../services/serviceImpact/sync.js')
    for (const r of rows) {
      const out = await syncServiceMap(tenantId, r.id, 'manual', SCENARIO_ACTOR)
      log(`service map «${r.name}» ${out.skipped ? `not synchronized (${out.skipped})` : 'synchronized'}`)
    }
  } finally {
    await session.close()
  }
}

// ── alarm-stuck: a firing alarm left with no decision ──────────────────────

/**
 * A firing alarm the pipeline had decided NOT to open an incident for (its
 * severity is below the threshold), taken back to «no decision» seventy
 * minutes ago. Re-evaluated, the pipeline takes the same decision again: no
 * incident is born from the trial. The periodic pass repairs such an alarm
 * within five minutes, so it has to be off (the events-worker stopped) for
 * the proposal to be born — that is the owner's side of the case.
 */
async function plantAlarmStuck(tenantId: string, now: Date, log: Log): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    const e = await runQueryOne<{ id: string; title: string | null }>(session, `
      MATCH (e:Event {tenant_id: $tenantId, status: 'firing', correlation: 'skipped_severity'})
      WHERE e.scenario IS NULL AND EXISTS { MATCH (e)-[:RAISED_ON]->(:ConfigurationItem {tenant_id: $tenantId}) }
      WITH e ORDER BY e.id LIMIT 1
      SET e.scenario = 'alarm-stuck',
          e.scenario_backup = apoc.convert.toJson({correlation: e.correlation, correlation_at: e.correlation_at, correlation_due_at: e.correlation_due_at}),
          e.correlation = 'none', e.correlation_at = $seventyAgo, e.correlation_due_at = null
      RETURN e.id AS id, e.title AS title
    `, { tenantId, seventyAgo: minutesAgo(now, 70) })
    if (!e) throw new Error(`${tenantId}: no firing alarm below the severity threshold to plant the case on`)
    log(`alarm «${e.title ?? e.id}» (${e.id}) is now firing with no decision for 70 minutes`)
  } finally {
    await session.close()
  }
}

/**
 * Put back only if the alarm is still undecided: once re-evaluated, the
 * pipeline's decision is the truth, and writing the old one over it would lie.
 */
async function cleanAlarmStuck(tenantId: string, log: Log): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    const rows = await runQuery<{ id: string; title: string | null; restored: boolean }>(session, `
      MATCH (e:Event {tenant_id: $tenantId, scenario: 'alarm-stuck'})
      WITH e, apoc.convert.fromJsonMap(coalesce(e.scenario_backup, '{}')) AS b, e.correlation = 'none' AS undecided
      FOREACH (_ IN CASE WHEN undecided THEN [1] ELSE [] END |
        SET e.correlation = b.correlation, e.correlation_at = b.correlation_at, e.correlation_due_at = b.correlation_due_at)
      REMOVE e.scenario, e.scenario_backup
      RETURN e.id AS id, e.title AS title, undecided AS restored
    `, { tenantId })
    for (const r of rows) log(`alarm «${r.title ?? r.id}» ${r.restored ? 'put back as it was' : 'left with the decision the pipeline took again'}`)
    if (rows.length === 0) log('no alarm of this case to put back')
  } finally {
    await session.close()
  }
}

// ── lost-timer: a ticket in a wait whose timer job was lost ────────────────

/** The wait step the trial adds, and where it leads back to. */
const WAIT_STEP = 'scenario_wait'
const WAIT_BACK_TO = 'in_progress'
const WAIT_DEFINITION = 'Incident Management'

/**
 * No workflow of the demo has a wait: the trial adds one to the incident
 * workflow — sixty minutes, its automatic exit back to «in progress» — and
 * moves an incident that is in progress into it, entered ninety minutes ago
 * and with no timer job: exactly what a lost timer leaves behind.
 */
async function plantLostTimer(tenantId: string, now: Date, log: Log): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    const step = await runQueryOne<{ id: string }>(session, `
      MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, entity_type: 'incident', active: true, name: $definition})-[:HAS_STEP]->(back:WorkflowStep {name: $backTo})
      WHERE NOT EXISTS { MATCH (wd)-[:HAS_STEP]->(:WorkflowStep {name: $wait}) }
      CREATE (w:WorkflowStep {
        id: randomUUID(), tenant_id: $tenantId, definition_id: wd.id, name: $wait, label: 'Waiting (trial)',
        type: 'timer_wait', timer_delay_minutes: 60, step_order: back.step_order + 0.5,
        is_initial: false, is_terminal: false, is_open: true, category: back.category, labels: back.labels,
        enter_actions: '[]', exit_actions: '[]', scenario: 'lost-timer', created_at: $now, updated_at: $now
      })
      CREATE (wd)-[:HAS_STEP]->(w)
      CREATE (w)-[:TRANSITIONS_TO {id: randomUUID(), trigger: 'automatic', label: 'Wait over', labels: '{}', requires_input: false, scenario: 'lost-timer'}]->(back)
      RETURN w.id AS id
    `, { tenantId, definition: WAIT_DEFINITION, backTo: WAIT_BACK_TO, wait: WAIT_STEP, now: now.toISOString() })
    if (!step) throw new Error(`${tenantId}: no "${WAIT_DEFINITION}" workflow with a "${WAIT_BACK_TO}" step, or the trial's wait is already there`)
    const moved = await runQueryOne<{ number: string; id: string }>(session, `
      MATCH (w:WorkflowStep {tenant_id: $tenantId, id: $stepId})
      MATCH (i:Incident {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId, status: 'active', definition_id: w.definition_id})-[cur:CURRENT_STEP]->(:WorkflowStep {name: $backTo})
      WITH w, i, wi, cur ORDER BY i.number LIMIT 1
      SET wi.scenario = 'lost-timer', wi.scenario_backup = apoc.convert.toJson({updated_at: wi.updated_at, current_step: wi.current_step}),
          wi.current_step = $wait, wi.updated_at = $ninetyAgo
      DELETE cur
      CREATE (wi)-[:CURRENT_STEP]->(w)
      RETURN i.number AS number, i.id AS id
    `, { tenantId, stepId: step.id, backTo: WAIT_BACK_TO, wait: WAIT_STEP, ninetyAgo: minutesAgo(now, 90) })
    if (!moved) throw new Error(`${tenantId}: no incident in progress to put in the wait`)
    log(`step «${WAIT_STEP}» (60-minute wait) added to «${WAIT_DEFINITION}»; incident ${moved.number} (${moved.id}) put in it 90 minutes ago, with no timer`)
  } finally {
    await session.close()
  }
}

/** The incident back where it was if it is still waiting; then the step and its arc go. */
async function cleanLostTimer(tenantId: string, log: Log): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    const back = await runQuery<{ id: string; waiting: boolean }>(session, `
      MATCH (wi:WorkflowInstance {tenant_id: $tenantId, scenario: 'lost-timer'})-[cur:CURRENT_STEP]->(s:WorkflowStep)
      WITH wi, cur, s, s.name = $wait AS waiting, apoc.convert.fromJsonMap(coalesce(wi.scenario_backup, '{}')) AS b
      CALL (wi, cur, waiting, b) {
        WITH wi, cur, waiting, b WHERE waiting
        MATCH (wd:WorkflowDefinition {tenant_id: $tenantId, id: wi.definition_id})-[:HAS_STEP]->(to:WorkflowStep {name: $backTo})
        DELETE cur
        CREATE (wi)-[:CURRENT_STEP]->(to)
        SET wi.current_step = $backTo, wi.updated_at = b.updated_at
      }
      REMOVE wi.scenario, wi.scenario_backup
      RETURN wi.entity_id AS id, waiting
    `, { tenantId, wait: WAIT_STEP, backTo: WAIT_BACK_TO })
    for (const r of back) log(`incident ${r.id} ${r.waiting ? 'put back in progress' : 'left where the remedy took it'}`)
    const gone = await runQuery<{ n: number }>(session, `
      MATCH (w:WorkflowStep {tenant_id: $tenantId, scenario: 'lost-timer'})
      DETACH DELETE w
      RETURN count(*) AS n
    `, { tenantId })
    log(`${String(Number(gone[0]?.n ?? 0))} trial wait step(s) removed`)
  } finally {
    await session.close()
  }
}

// ── The table ───────────────────────────────────────────────────────────────

const TABLE: Readonly<Record<Scenario, { plant: (t: string, now: Date, log: Log, opts?: ScenarioOptions) => Promise<void>; clean: (t: string, log: Log, opts?: ScenarioOptions) => Promise<void> }>> = {
  'ci-health':  { plant: plantCIHealth, clean: cleanCIHealth },
  'failed-job': { plant: plantFailedJob, clean: cleanFailedJob },
  'map-late':   { plant: plantMapLate, clean: cleanMapLate },
  'alarm-stuck': { plant: plantAlarmStuck, clean: cleanAlarmStuck },
  'lost-timer':  { plant: plantLostTimer, clean: cleanLostTimer },
}

export async function plantScenario(scenario: Scenario, tenantId: string, log: Log, now: Date = new Date(), opts: ScenarioOptions = {}): Promise<void> {
  await TABLE[scenario].plant(tenantId, now, log, opts)
}

export async function cleanScenario(scenario: Scenario, tenantId: string, log: Log, opts: ScenarioOptions = {}): Promise<void> {
  await TABLE[scenario].clean(tenantId, log, opts)
}
