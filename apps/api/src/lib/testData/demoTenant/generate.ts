/**
 * THE DEMO TENANT GENERATOR (23 Sep 2026).
 *
 * Reusable, as the owner of the product asked: any tenant, any size, the same
 * seed gives the same tenant. It fills a tenant that has only its factory
 * data with three years of operation — people and teams, the CMDB, the
 * configuration an administrator would do (calendar, SLA, OLA, assessment
 * questions, the service catalog), incidents, problems, changes and service
 * requests walked through the tenant's own workflows, reports and a
 * dashboard. See the notes of each module for the rules it follows.
 *
 * Everything it writes carries `demo_run_id` (writer.ts); `cleanDemoTenant`
 * removes it. A tenant that already has demo data, or data of its own, is
 * refused: mixing a generated past with a real one would make both useless.
 */
import neo4j from 'neo4j-driver'
import type { Session } from 'neo4j-driver'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { PERMISSIONS } from '@opengraphity/types'
import type { GraphQLContext } from '../../../auth/resolveAuth.js'
import { Rng } from './random.js'
import { DAY, DemoClock, HOUR, MINUTE } from './clock.js'
import { assertDemoCounts, DEFAULT_DEMO_COUNTS, DEMO_RATIOS, type DemoOptions } from './options.js'
import { planPeople, type PlannedUser } from './people.js'
import { monitoredServiceCandidates, planCMDB, type CMDBPlan, type PlannedCI } from './cmdb.js'
import { planConfig, type ConfigPlan, type PlannedOla } from './config.js'
import { DemoWriter, ensureIdIndexes, int } from './writer.js'
import { planClientLogs } from './clientLogs.js'
import { planMonitoring, MONITORING_SOURCES, type IncidentWindow, type DeployWindow, type MonitoringPlan } from './monitoring.js'
import { auditRow, enrolTenantAdmins, writeCMDB, writeConfig, writeOlaContracts, writePeople } from './writeReference.js'
import { loadTicketWorkflows, type WorkflowEntity } from './workflowModel.js'
import { World, type PriorityRules } from './world.js'
import type { TrailContext } from './trail.js'
import { planIncidentSkeletons, simulateIncident, bornIncidentSkeleton, type ResolvingChange, type IncidentSkeleton, type SimulatedIncident } from './incidents.js'
import { getEventPolicy } from '../../../services/events/policy.js'
import { planProblemSkeletons, simulateProblem, type ProblemSkeleton } from './problems.js'
import { changeStoryByKey } from './ticketTexts.js'
import { planChangeSkeletons, simulateChange, type ChangeMilestones, type ChangeSkeleton } from './changes.js'
import { simulateRequests, type SimulatedRequest } from './serviceRequests.js'
import { buildCatalog, type BuiltCatalog } from './catalogSetup.js'
import { AI_PROPOSED_SECTIONS, buildReports, DASHBOARD_WIDGETS, demoReports } from './reports.js'
import { writeChanges, writeIncidents, writeProblems, writeRequests } from './writeTickets.js'
import { auditableArgs, auditEntityId, auditEntityType } from '../../../graphql/auditMutationsPlugin.js'
import { calculateAllChains } from '../../chainCalculator.js'
import { nextSequenceBlock } from '../../sequence.js'
import { formatTicketNumber, ticketNumbering, type TicketNumberKind } from '../../ticketNumbering.js'
import { derivePriority, invertPriority } from '../../priority.js'
import { riskBandOf } from '../../riskBands.js'
import { deriveChangePriority } from '../../../services/change/scoring.js'
import { environmentRiskScore } from '../../environmentRisk.js'
import { changeEnvironmentWeight } from '../../changeEnvironmentWeight.js'
import { systemTextIn, formatInstantIn } from '../../systemText.js'
import { languageFor } from '../../tenantLanguage.js'
import { loadStepFacts } from '../../stepEvent.js'
import { enableRunOlaContracts, markOlaAlerts, scheduleOpenSlaJobs } from './afterRun.js'
import { CERTIFICATE_DATABASE_RELATIONS } from '../../../scripts/migrations/20261007_1020_certificates_on_databases.js'
import { integrationsResolvers } from '../../../graphql/resolvers/integrations.js'
import { serviceResolvers } from '../../../graphql/resolvers/services.js'
import { eventResolvers } from '../../../graphql/resolvers/events.js'
/*
 * The tenant schema, registered in this process (wave 7 · C1): the resolvers
 * the generator drives reach lib/tenantSchema.ts (custom field names, the form
 * designer), which only answers where graphql/schemaCache.ts was loaded — the
 * server does it, a command that generates a tenant must do it too.
 */
import '../../../graphql/schemaCache.js'
import { OlaFacts, planOlaContracts } from './olaPlan.js'
import { planToolNames, type ToolNames } from './toolNames.js'
import { backfillServiceHistory } from './serviceHistory.js'
import { planKnowledgeBase, writeKnowledgeBase, type KnownErrorFact } from './knowledgeBase.js'
import { embedDemoTenant } from './embeddings.js'
import { scanTenant } from '../../../anomaly/anomalyEngine.js'
import { automationFirings, createAutomation, demoAutomations, writtenAt } from './automations.js'
import { createDemoChannels, DEMO_CHANNEL_EVENTS, DEMO_INAPP_RETENTION_DAYS, firstStates, setDemoRetention, tuneNotificationRules } from './organization.js'
import { analizzaCliente, conIlLucchetto, recordAnalysisRun } from '../../../jobs/proposalScanner.js'

export interface DemoRunResult {
  runId: string
  nodes: number
  relationships: number
  durationMs: number
}

type Log = (message: string) => void

/** The labels a tenant has from its factory data: anything else is data of its own. */
const TENANT_DATA_LABELS = ['Incident', 'Problem', 'Change', 'ServiceRequest', 'ConfigurationItem', 'Team', 'ServiceCatalogItem', 'SLAPolicyNode', 'OLAContract', 'ReportTemplate']

async function preflight(session: Session, tenantId: string): Promise<{ timeZone: string }> {
  const tenant = await runQuery<{ timezone: string | null }>(session, 'MATCH (t:Tenant {id: $tenantId}) RETURN t.timezone AS timezone', { tenantId })
  if (!tenant[0]) throw new Error(`Tenant "${tenantId}" does not exist`)
  if (!tenant[0].timezone) throw new Error(`Tenant "${tenantId}" has no timezone: set it in Settings → Organization first`)
  const labels = (await runQuery<{ label: string }>(session, 'CALL db.labels() YIELD label RETURN label', {})).map((r) => r.label)
  const markedBranches = labels.filter((l) => /^[A-Za-z][A-Za-z0-9_]*$/.test(l))
    .map((l) => `MATCH (n:${l} {tenant_id: $tenantId}) WHERE n.demo_run_id IS NOT NULL RETURN count(n) AS c`)
  const demo = await runQuery<{ n: number }>(session, `CALL () { ${markedBranches.join(' UNION ALL ')} } RETURN sum(c) AS n`, { tenantId })
  if (Number(demo[0]?.n ?? 0) > 0) throw new Error(`Tenant "${tenantId}" already has demo data: remove it first (seed:demo-tenant -- --clean)`)
  for (const label of TENANT_DATA_LABELS) {
    const n = await runQuery<{ n: number }>(session, `MATCH (n:${label} {tenant_id: $tenantId}) RETURN count(n) AS n`, { tenantId })
    if (Number(n[0]?.n ?? 0) > 0) throw new Error(`Tenant "${tenantId}" has ${String(n[0]!.n)} ${label} of its own: the demo generator only fills a tenant with its factory data`)
  }
  const cm = await runQuery<{ n: number }>(session, 'MATCH (t:Team {tenant_id: $tenantId, is_change_manager: true}) RETURN count(t) AS n', { tenantId })
  if (Number(cm[0]?.n ?? 0) > 0) throw new Error(`Tenant "${tenantId}" already has a change-manager team`)
  const rel = await runQuery<{ n: number }>(session, `
    UNWIND $pairs AS pair
    MATCH (:CITypeDefinition {tenant_id: 'system', name: pair.type})-[:HAS_RELATION]->(r:CIRelationDefinition {tenant_id: 'system', name: pair.name})
    RETURN count(r) AS n`,
  { pairs: CERTIFICATE_DATABASE_RELATIONS.map((r) => ({ type: r.typeName, name: r.name })) })
  if (Number(rel[0]?.n ?? 0) < CERTIFICATE_DATABASE_RELATIONS.length) {
    throw new Error('The metamodel does not declare certificates on databases yet: run the migrations (20261007_1020) first')
  }
  return { timeZone: tenant[0].timezone }
}

/** The tenant's rules, read once through the app's own functions. */
async function priorityRules(tenantId: string): Promise<PriorityRules> {
  const levels = ['low', 'medium', 'high']
  const derived = new Map<string, string>()
  for (const i of levels) for (const u of levels) derived.set(`${i}|${u}`, await derivePriority(tenantId, i, u))
  const inverted = new Map<string, { impact: string; urgency: string }>()
  for (const p of ['low', 'medium', 'high', 'critical']) inverted.set(p, await invertPriority(tenantId, p))
  const bands: string[] = []
  for (let s = 0; s <= 100; s++) bands.push(await riskBandOf(tenantId, s))
  const changePriority = new Map<string, string>()
  const initial = new Map<string, string>()
  for (const type of ['standard', 'normal', 'emergency']) {
    initial.set(type, await deriveChangePriority(tenantId, type, null))
    for (let s = 0; s <= 100; s++) changePriority.set(`${type}|${bands[s]!}`, await deriveChangePriority(tenantId, type, s))
  }
  const envRisk = new Map<string, number>()
  for (const env of ['production', 'staging', 'development', 'testing', 'dr']) envRisk.set(env, await environmentRiskScore(tenantId, env))
  const weight = (await changeEnvironmentWeight(tenantId)).weight
  const get = <T>(m: Map<string, T>, k: string, what: string): T => {
    const v = m.get(k)
    if (v === undefined) throw new Error(`priorityRules: no ${what} for "${k}"`)
    return v
  }
  return {
    derive: (i, u) => get(derived, `${i}|${u}`, 'priority'),
    invert: (p) => get(inverted, p, 'impact/urgency'),
    changePriority: (type, band) => get(changePriority, `${type}|${band}`, 'change priority'),
    changeInitialPriority: (type) => get(initial, type, 'initial change priority'),
    riskBand: (score) => bands[Math.max(0, Math.min(100, Math.round(score)))]!,
    environmentRisk: (env) => get(envRisk, env, 'environment risk'),
    environmentWeight: weight,
  }
}

/** Numbers in creation order, reserved with the app's own counter (`nextSequenceBlock`). */
async function allocateNumbers(session: Session, tenantId: string, kind: TicketNumberKind, idsInOrder: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (!idsInOrder.length) return out
  const format = (await ticketNumbering(tenantId))[kind]
  const last = await nextSequenceBlock(session, tenantId, kind, idsInOrder.length)
  idsInOrder.forEach((id, i) => out.set(id, formatTicketNumber(format, last - idsInOrder.length + 1 + i)))
  return out
}

/** Nodes created through the app's mutations: dated in the simulated past and marked. */
async function backdate(session: Session, tenantId: string, runId: string, label: string, ids: readonly string[], atIso: string, props: readonly string[]): Promise<void> {
  if (!ids.length) return
  const sets = props.map((p) => `n.${p} = $at`).join(', ')
  await session.executeWrite((tx) => tx.run(`
    UNWIND $ids AS id
    MATCH (n:${label} {id: id})
    WHERE n.tenant_id = $tenantId
    SET ${sets}, n.demo_run_id = $runId
  `, { ids, tenantId, at: atIso, runId }))
}

/**
 * The windows of real time in which each phase called the app's mutations,
 * and the simulated moment each one stands for (see `settleLateAudits`).
 */
const auditWindows = new Map<string, Array<{ since: string; at: string }>>()

/** The Audit Log rows the mutations wrote with "now": moved to the simulated time and marked. */
async function backdateAudits(session: Session, tenantId: string, runId: string, sinceIso: string, atIso: string): Promise<void> {
  auditWindows.set(runId, [...(auditWindows.get(runId) ?? []), { since: sinceIso, at: atIso }])
  await session.executeWrite((tx) => tx.run(`
    MATCH (a:AuditEntry {tenant_id: $tenantId}) WHERE a.created_at >= $since AND a.demo_run_id IS NULL
    SET a.created_at = $at, a.demo_run_id = $runId
  `, { tenantId, since: sinceIso, at: atIso, runId }))
}

/**
 * THE ENTRIES WRITTEN AFTER THEIR PHASE WAS MOVED (tour of 23 Sep 2026).
 *
 * Many mutations write their entry with `void audit(...)`: the resolver
 * returns before the entry is in the graph, and `backdateAudits`, which runs
 * right after, can miss it — an entry at the real time of the generation,
 * without the mark, that the clean-up would never remove. The entry's time
 * is taken when `audit()` is called, so it falls inside the window of the
 * phase that caused it: at the end of the run every window is applied again,
 * to the generator's own actor only.
 */
async function settleLateAudits(session: Session, tenantId: string, runId: string, actorId: string): Promise<number> {
  const windows = [...(auditWindows.get(runId) ?? [])].sort((a, b) => a.since.localeCompare(b.since))
  auditWindows.delete(runId)
  let moved = 0
  for (const [i, win] of windows.entries()) {
    const rows = await runQuery<{ n: unknown }>(session, `
      MATCH (a:AuditEntry {tenant_id: $tenantId})
      WHERE a.demo_run_id IS NULL AND a.user_id = $actorId AND a.created_at >= $since AND ($until IS NULL OR a.created_at < $until)
      SET a.created_at = $at, a.demo_run_id = $runId
      RETURN count(a) AS n`, { tenantId, actorId, since: win.since, until: windows[i + 1]?.since ?? null, at: win.at, runId })
    moved += Number(rows[0]?.n ?? 0)
  }
  return moved
}

/** What every phase of a run shares. */
interface Run {
  session: Session
  opts: DemoOptions
  clock: DemoClock
  rng: Rng
  runId: string
  w: DemoWriter
  log: Log
  timeZone: string
  started: number
  /** OLA and UC contracts made (planOlaContractsOrStop), kept on the run for verify. */
  olaContractsPlanned?: number
}

export async function generateDemoTenant(opts: DemoOptions, log: Log): Promise<DemoRunResult> {
  assertDemoCounts(opts.counts)
  const started = Date.now()
  const session = getSession(undefined, neo4j.session.WRITE)
  const runId = `${opts.seed}@${new Date(opts.nowMs).toISOString()}`
  let recorded = false
  try {
    const { timeZone } = await preflight(session, opts.tenantId)
    const clock = new DemoClock(opts.nowMs, opts.years, timeZone)
    const rng = new Rng(opts.seed)
    log(`run ${runId}: ${new Date(clock.startMs).toISOString().slice(0, 10)} → ${new Date(opts.nowMs).toISOString().slice(0, 10)} (${timeZone})`)
    const w = new DemoWriter(session, opts.tenantId, runId, 2000)
    const run: Run = { session, opts, clock, rng, runId, w, log, timeZone, started }
    const indexes = await ensureIdIndexes(session)
    if (indexes > 0) log(`${String(indexes)} missing (:Label {id}) indexes created: without them attaching the edges is a label scan per batch`)
    await recordRun(run)
    recorded = true

    const ref = await writeReference(run)
    const world = await buildWorld(run, ref)
    const ctx: GraphQLContext = { tenantId: opts.tenantId, userId: ref.admin.id, userEmail: ref.admin.email, role: 'admin', permissions: new Set(PERMISSIONS) }
    const catalog = await setupCatalog(run, ctx, world, ref)
    const sourceIds = await setupSources(run, ctx)
    const policy = await setupEventPolicy(run, ctx)
    const olaFacts = new OlaFacts()
    const tickets = await simulateTickets(run, world, ref, policy, olaFacts)
    const embedded = await embedDemoTenant(session, opts.tenantId, runId, log)
    if (embedded) log(`embeddings: ${String(embedded.incidents)} incidents, ${String(embedded.articles)} articles`)
    await simulateRequestsPhase(run, world, catalog, olaFacts)
    await organizationPhase(run, ctx, catalog, ref.admin)
    const olas = planOlaContractsOrStop(run, ref, olaFacts)
    await writeOlaContracts(w, rng.fork('ola-audit'), clock, olas, ref.admin)
    log(`OLA and UC contracts: ${String(olas.length)}, each on the team that does the work`)
    await writeMonitoring(run, tickets.monitoring, sourceIds)
    await createMonitoredServices(run, ctx, ref.cmdb, tickets.monitoring)
    const logs = planClientLogs(rng.fork('logs'), world, opts.counts.clientLogs)
    await w.nodes(['LogEntry'], logs)
    log(`browser logs: ${String(logs.length)}`)
    await writeReportsPhase(run, ctx, world, ref.admin)
    await afterRunPhase(run)
    await finalScansPhase(run)
    const late = await settleLateAudits(session, opts.tenantId, runId, ref.admin.id)
    if (late > 0) log(`audit: ${String(late)} entries written after their phase was moved, moved too`)

    await session.executeWrite((tx) => tx.run(`
      MATCH (r:DemoDataRun {id: $runId, tenant_id: $tenantId})
      SET r.status = 'completed', r.completed_at = $at, r.nodes = $nodes, r.relationships = $rels, r.ola_contracts = $olaContracts`,
    { runId, tenantId: opts.tenantId, at: new Date().toISOString(), nodes: w.stats.nodes, rels: w.stats.relationships, olaContracts: run.olaContractsPlanned ?? null }))
    return { runId, nodes: w.stats.nodes, relationships: w.stats.relationships, durationMs: Date.now() - started }
  } catch (err) {
    if (recorded) await markLeftovers(session, opts.tenantId, runId, new Date(started).toISOString(), log)
    throw err
  } finally {
    await session.close()
  }
}

/**
 * A RUN THAT STOPS LEAVES NOTHING THE CLEAN-UP CANNOT SEE (review of 23 Sep 2026).
 *
 * What the generator makes through the product's own mutations — vocabularies,
 * form fields, catalog items, sources, service maps, reports, notification
 * channels — gets the run's mark only when its phase has finished. A phase
 * designed to stop on a form the product refuses left what it had made so far
 * unmarked: `--clean` removes only marked nodes, and the next run's preflight
 * refused the tenant for «its own» catalog items. On a failure, every node of
 * the tenant written since the run started and still unmarked is marked as the
 * run's, and the run as failed; the error then goes on. The tenant is the
 * demo's own (preflight): what was written since the start is the run's.
 */
export async function markLeftovers(session: Session, tenantId: string, runId: string, sinceIso: string, log: Log): Promise<void> {
  try {
    const labels = (await runQuery<{ label: string }>(session, 'CALL db.labels() YIELD label RETURN label', {}))
      .map((r) => r.label).filter((l) => /^[A-Za-z][A-Za-z0-9_]*$/.test(l))
    let marked = 0
    for (const label of labels) {
      const rows = await runQuery<{ n: unknown }>(session, `
        MATCH (n:${label} {tenant_id: $tenantId})
        WHERE n.demo_run_id IS NULL AND n.created_at >= $since
        SET n.demo_run_id = $runId
        RETURN count(n) AS n`, { tenantId, since: sinceIso, runId })
      marked += Number(rows[0]?.n ?? 0)
    }
    await runQuery(session, `MATCH (r:DemoDataRun {id: $runId, tenant_id: $tenantId}) SET r.status = 'failed', r.failed_at = $at`,
      { runId, tenantId, at: new Date().toISOString() })
    log(`run stopped: ${String(marked)} nodes it had made through the product marked as the run's, so --clean removes them`)
  } catch (err) {
    // The original error matters more: this one is said, not thrown.
    log(`run stopped, and marking what it had made FAILED too (${(err as Error).message}): clean the tenant by hand before the next run`)
  }
}

/**
 * The run's own record, with what it changes outside its own nodes so that
 * the clean-up can put it back: the counters, the catalog limits, the event
 * policy (D4) and the notification retention (D55).
 */
/**
 * The OLA and UC contracts, or a stop (review of 23 Sep 2026). A contract the
 * simulated tickets cannot support used to disappear without a word — the two
 * problem OLAs of the owner's twelve. On the full demo that stops the run,
 * naming each one; at a reduced scale (fewer tickets per team) each is written
 * in the log as a warning. The number made is kept on the run for verify.
 */
function planOlaContractsOrStop(run: Run, ref: Reference, facts: OlaFacts): PlannedOla[] {
  const { contracts, shortfalls } = planOlaContracts(run.rng.fork('ola'), ref.people, ref.config, facts, run.timeZone, run.clock.startMs, run.clock.nowMs)
  if (shortfalls.length) {
    const full = run.opts.counts.problems >= DEFAULT_DEMO_COUNTS.problems && run.opts.counts.incidents >= DEFAULT_DEMO_COUNTS.incidents
    const list = shortfalls.map((x) => `\n  - ${x}`).join('')
    if (full) throw new Error(`demo generator: OLA/UC contracts the demo asks for cannot be made from the simulated tickets:${list}`)
    run.log(`WARNING — reduced scale, OLA/UC contracts not made:${list}`)
  }
  run.olaContractsPlanned = contracts.length
  return contracts
}

async function recordRun(run: Run): Promise<void> {
  const { session, opts, w } = run
  const counters = await runQuery<{ kind: string; value: number }>(session,
    'MATCH (c:Counter {tenant_id: $tenantId}) RETURN c.kind AS kind, c.value AS value', { tenantId: opts.tenantId })
  const tenant = await runQuery<Record<string, unknown>>(session, `
    MATCH (t:Tenant {id: $tenantId})
    RETURN t.max_form_fields AS max_form_fields, t.max_form_fields_per_form AS max_form_fields_per_form, t.max_form_table_rows AS max_form_table_rows,
           t.event_policy AS event_policy, t.inapp_notification_retention_days AS inapp_notification_retention_days`,
  { tenantId: opts.tenantId })
  const t = tenant[0] ?? {}
  await w.nodes(['DemoDataRun'], [{ id: run.runId, seed: opts.seed, now: new Date(opts.nowMs).toISOString(), years: opts.years,
    counts: JSON.stringify(opts.counts), started_at: new Date(run.started).toISOString(), status: 'running',
    previous_counters: JSON.stringify(Object.fromEntries(counters.map((c) => [c.kind, Number(c.value)]))),
    previous_limits: JSON.stringify({ max_form_fields: t['max_form_fields'] ?? null, max_form_fields_per_form: t['max_form_fields_per_form'] ?? null, max_form_table_rows: t['max_form_table_rows'] ?? null }),
    previous_event_policy: typeof t['event_policy'] === 'string' ? t['event_policy'] : null,
    previous_notification_retention: t['inapp_notification_retention_days'] == null ? null : Number(t['inapp_notification_retention_days']) }])
}

interface Reference {
  people: ReturnType<typeof planPeople>
  admin: PlannedUser
  config: ConfigPlan
  cmdb: CMDBPlan
  names: ToolNames
}

/** People, configuration, CMDB and the aliases discovery registered on the CIs. */
async function writeReference(run: Run): Promise<Reference> {
  const { rng, clock, opts, w, log, session } = run
  const people = planPeople(rng.fork('people'), clock, opts.counts)
  const admin = people.users.find((u) => u.role === 'admin')!
  await writePeople(w, rng.fork('people-audit'), clock, people, admin)
  log(`people: ${String(people.users.length)} users, ${String(people.teams.length)} teams`)

  const cmdb = planCMDB(rng.fork('cmdb'), clock, opts.counts, people)
  const config = planConfig(rng.fork('config'), clock, people)
  const ciTypes = await runQuery<{ id: string }>(session, `
    MATCH (ct:CITypeDefinition) WHERE (ct.scope = 'base' OR (ct.scope = 'tenant' AND ct.tenant_id = $tenantId))
      AND ct.active = true AND ct.name <> '__base__'
    RETURN ct.id AS id`, { tenantId: opts.tenantId })
  await writeConfig(w, rng.fork('config-audit'), clock, config, admin, ciTypes.map((c) => c.id))
  // The configuration pages' calls with no audit of their own: the registry rows.
  const cfgRng = rng.fork('config-registry')
  await w.nodes(['AuditEntry'], [
    ...config.slaPolicies.map((p) => registryRow(cfgRng, admin, p.createdAtMs, 'createSLAPolicy', 'SLAPolicyNode!', { input: slaInput(p) }, { id: p.id })),
    ...config.questions.map((q) => registryRow(cfgRng, admin, clock.startMs + 2 * HOUR, 'createAssessmentQuestion', 'AssessmentQuestion!',
      { input: { text: q.text, category: q.category, isCore: true, options: q.options.map((o) => ({ label: o.label, score: o.score, sortOrder: o.sortOrder })) } }, { id: q.id })),
  ])
  log(`configuration: ${String(config.calendars.length)} calendars, ${String(config.slaPolicies.length)} SLA policies, ${String(config.questions.length)} questions`)

  await writeCMDB(w, rng.fork('cmdb-audit'), clock, cmdb, people)
  const chains = await calculateAllChains(opts.tenantId)
  log(`CMDB: ${String(cmdb.cis.length)} CIs, ${String(cmdb.relations.length)} relations (chains: ${String(chains.total)})`)
  const names = planToolNames(rng.fork('tool-names'), cmdb)
  await writeAliases(w, clock, cmdb, names)
  log(`aliases: ${String(names.aliases.length)} tool names registered by discovery on the CIs`)
  const enrolled = await enrolTenantAdmins(w, session, rng.fork('admins'), people, cmdb, admin)
  log(`the tenant's own administrators joined ${enrolled ? 'three teams' : 'no team (the tenant has none)'}`)
  return { people, admin, config, cmdb, names }
}

/** The aliases the tools' names hang on (D37): `source: 'discovery'`, dated with the CI. */
async function writeAliases(w: DemoWriter, clock: DemoClock, cmdb: CMDBPlan, names: ToolNames): Promise<void> {
  const aliases = names.aliases.map((a, i) => ({ ...a, id: `${w.runId}-alias-${String(i)}` }))
  await w.nodes(['CIAlias'], aliases.map((a) => ({
    id: a.id, kind: a.kind, value: a.value, source: 'discovery', created_by: 'discovery',
    created_at: clock.iso(Math.min(cmdb.byId.get(a.ciId)!.createdAtMs + HOUR, clock.nowMs - DAY)),
  })))
  await w.relationships('CIAlias', 'ALIAS_OF', 'ConfigurationItem', aliases.map((a) => ({ from: a.id, to: a.ciId })))
}

async function buildWorld(run: Run, ref: Reference): Promise<World> {
  const { session, opts, rng, clock, timeZone } = run
  const workflows = await loadTicketWorkflows(session, opts.tenantId)
  const lingua = await languageFor(opts.tenantId)
  const facts = new Map<string, Record<string, unknown>>()
  for (const d of workflows.all) {
    for (const s of d.steps.values()) {
      const key = `${d.entityType}|${s.name}`
      if (!facts.has(key)) facts.set(key, await loadStepFacts(session, opts.tenantId, d.entityType, s.name) as unknown as Record<string, unknown>)
    }
  }
  const trailCtx: TrailContext = {
    rng: rng.fork('trail'),
    text: (key, params = {}) => systemTextIn(lingua, key as Parameters<typeof systemTextIn>[1], params),
    instant: (ms: number) => formatInstantIn(lingua, new Date(ms).toISOString(), timeZone),
    stepFacts: (entity: WorkflowEntity, step: string) => {
      const f = facts.get(`${entity}|${step}`)
      if (!f) throw new Error(`No step facts for ${entity}.${step}`)
      return f
    },
  }
  const rules = await priorityRules(opts.tenantId)
  return new World(rng.fork('world'), clock, ref.people, ref.cmdb, ref.config, workflows, rules, trailCtx, timeZone)
}

/** The catalog, built with the app's own designer (catalogSetup.ts), dated in the first week. */
async function setupCatalog(run: Run, ctx: GraphQLContext, world: World, ref: Reference): Promise<BuiltCatalog> {
  const { session, opts, runId, clock, w, rng, log } = run
  const catalogAt = new Date(clock.startMs + 5 * DAY).toISOString()
  const mutationsSince = new Date().toISOString()
  const catalog = await buildCatalog(ctx, world.workflows.forTicket('service_request', null).id, ref.people.teams)
  await backdate(session, opts.tenantId, runId, 'EnumTypeDefinition', catalog.vocabularyIds, catalogAt, ['created_at', 'updated_at'])
  await backdate(session, opts.tenantId, runId, 'FormField', catalog.fieldIds, catalogAt, ['created_at', 'updated_at'])
  await backdate(session, opts.tenantId, runId, 'ServiceCatalogItem', catalog.items.map((i) => i.id), catalogAt, ['created_at', 'updated_at', 'form_updated_at'])
  await session.executeWrite((tx) => tx.run(`
    MATCH (i:ServiceCatalogItem {tenant_id: $tenantId})-[:HAS_FORM_REVISION]->(r:CatalogFormRevision)
    WHERE i.id IN $ids SET r.published_at = $at, r.demo_run_id = $runId`,
  { tenantId: opts.tenantId, ids: catalog.items.map((i) => i.id), at: catalogAt, runId }))
  await backdateAudits(session, opts.tenantId, runId, mutationsSince, catalogAt)
  const regRng = rng.fork('catalog-registry')
  await w.nodes(['AuditEntry'], catalog.registry.map((r) => registryRow(regRng, ref.admin, Date.parse(catalogAt), r.mutation, r.returnType, r.args, r.result)))
  log(`catalog: ${String(catalog.items.length)} request models, ${String(catalog.fieldIds.length)} fields, ${String(catalog.vocabularyIds.length)} vocabularies`)
  return catalog
}

/**
 * LE SORGENTI DI MONITORAGGIO, create con la mutation vera del prodotto
 * (`createInboundWebhook`): così hanno il token con la sua impronta, i
 * limiti di frequenza e la voce di audit che avrebbero se le avesse create
 * una persona da Amministrazione → Integrazioni.
 */
async function setupSources(run: Run, ctx: GraphQLContext): Promise<Map<string, string>> {
  const { session, opts, runId, clock, log } = run
  const sourcesSince = new Date().toISOString()
  const sourcesAt = new Date(clock.startMs + 2 * DAY).toISOString()
  const sourceIds = new Map<string, string>()
  for (const src of MONITORING_SOURCES) {
    const created = await integrationsResolvers.Mutation.createInboundWebhook(null, {
      /*
       * `fieldMapping` è obbligatorio anche per i connettori che non ne
       * hanno bisogno: alertmanager, grafana e dynatrace sanno già dove
       * stanno i campi nel loro payload, e la mappa serve solo al
       * connettore «generic». Si manda `{}`, che è quello che manda la
       * procedura guidata del prodotto quando si sceglie uno strumento.
       */
      input: { name: src.name, entityType: 'event', connectorKind: src.connectorKind, fieldMapping: '{}', rateLimitPerMinute: 600 },
    } as never, ctx) as { id: string }
    sourceIds.set(src.key, created.id)
  }
  await backdate(session, opts.tenantId, runId, 'InboundWebhook', [...sourceIds.values()], sourcesAt, ['created_at', 'updated_at'])
  await backdateAudits(session, opts.tenantId, runId, sourcesSince, sourcesAt)
  log(`monitoring sources: ${MONITORING_SOURCES.map((s) => s.name).join(', ')}`)
  return sourceIds
}

/** The event policy as the monitoring needs it: retention, threshold, and what a critical alarm becomes by environment. */
interface DemoEventPolicy {
  retentionDays: number
  openFrom: string
  autoResolve: boolean
  /** Impact, urgency and the priority they give for a critical alarm on this CI (`severityFor`, grouping.ts). */
  critical(ci: PlannedCI): { impact: string; urgency: string; severity: string }
}

/**
 * D4 (tour of 23 Sep 2026, the owner's choice): a critical alarm opened a
 * CRITICAL incident everywhere — 13,775 of them, above the High ones. The
 * administrator of the demo tenant maps a critical alarm to High (P2) in
 * production and Medium elsewhere, through the policy page's own mutation
 * (`updateEventPolicy`: `severityMap`, `nonProductionSeverityMap`).
 */
async function setupEventPolicy(run: Run, ctx: GraphQLContext): Promise<DemoEventPolicy> {
  const { session, opts, runId, clock } = run
  const since = new Date().toISOString()
  const map = (critical: [string, string], warning: [string, string]): string => JSON.stringify({
    critical: { impact: critical[0], urgency: critical[1] }, warning: { impact: warning[0], urgency: warning[1] }, info: { impact: 'low', urgency: 'low' },
  })
  await eventResolvers.Mutation.updateEventPolicy(null, { input: {
    severityMap: map(['high', 'medium'], ['medium', 'low']),
    nonProductionSeverityMap: map(['medium', 'medium'], ['low', 'low']),
    productionEnvironments: ['production'],
  } }, ctx)
  await backdateAudits(session, opts.tenantId, runId, since, new Date(clock.startMs + 2 * DAY + HOUR).toISOString())
  const p = await getEventPolicy(opts.tenantId)
  const world = await priorityRules(opts.tenantId)
  return {
    retentionDays: p.retention_days, openFrom: p.open_incident_from, autoResolve: p.auto_resolve,
    critical: (ci) => {
      const production = p.production_environments.length === 0 || !ci.environment || p.production_environments.includes(ci.environment)
      const iu = (production ? p.severity_map : p.non_production_severity_map ?? p.severity_map).critical
      return { impact: iu.impact, urgency: iu.urgency, severity: world.derive(iu.impact, iu.urgency) }
    },
  }
}

interface TicketsResult { monitoring: MonitoringPlan }

/** Incidents, problems and changes: planned together (they point at each other), then written. */
async function simulateTickets(run: Run, world: World, ref: Reference, policy: DemoEventPolicy, olaFacts: OlaFacts): Promise<TicketsResult> {
  const { session, opts, rng, clock, log } = run
  const counts = opts.counts
  const cmdb = ref.cmdb
  // Un quarto degli incident lo apre il monitoraggio da un allarme critico
  // (vedi monitoring.ts): fanno parte dei 50.000, non si aggiungono.
  const bornTarget = Math.round(counts.incidents * DEMO_RATIOS.incidentsFromMonitoring)
  const incidentSkeletons = planIncidentSkeletons(rng.fork('incidents'), world, counts.incidents - bornTarget)
  /*
   * Il 10% delle change risolve un ticket. Chi le chiede: i problem per
   * primi — è il loro mestiere, un problem finisce in una change — ma sono
   * 800, e non tutti arrivano a una RFC: se ne prende metà. Il resto delle
   * change risolutive nasce da un incident.
   */
  const resolvingTotal = Math.round(counts.changes * DEMO_RATIOS.resolvingChanges)
  const resolvingProblemCount = Math.min(Math.round(counts.problems * 0.5), resolvingTotal)
  const openProblemChanges = Math.round(resolvingProblemCount * 0.2)
  const problemSkeletons = planProblemSkeletons(rng.fork('problems'), world, counts.problems, incidentSkeletons,
    { closed: resolvingProblemCount - openProblemChanges, open: openProblemChanges })
  // Quante ne portano DAVVERO i problem (gli aperti sono pochi, vedi
  // `planProblemSkeletons`): il resto delle change risolutive nasce da un
  // incident, così il 10% chiesto dal proprietario resta esatto.
  const fromProblems = problemSkeletons.filter((p) => p.path === 'change').length
  const resolvingIncidentCount = Math.min(resolvingTotal - fromProblems, counts.incidents)
  const linkRng = rng.fork('links')
  const incidentLinks = linkRng.sample(incidentSkeletons.filter((s) => s.openState === null && s.channel === 'agent' && s.ciIds.length > 0
    && s.createdAtMs < clock.nowMs - 60 * DAY), resolvingIncidentCount)
  const linked = [
    ...incidentLinks.map((s) => ({ link: { kind: 'incident' as const, ticketId: s.id }, createdAtMs: s.createdAtMs + linkRng.int(6, 48) * HOUR,
      ci: cmdb.byId.get(s.ciIds[0]!)!, target: 'closed' as const, requesterId: world.memberOf(linkRng, s.teamId, s.createdAtMs).id,
      ...(s.story.fix ? { story: changeStoryByKey(s.story.fix) } : {}) })),
    ...problemSkeletons.filter((p) => p.path === 'change').map((p) => ({ link: { kind: 'problem' as const, ticketId: p.id }, createdAtMs: p.changeAtMs!,
      ci: cmdb.byId.get(p.ciId)!, target: p.changeTarget!, requesterId: world.memberOf(linkRng, p.teamId, p.changeAtMs!).id,
      story: changeStoryByKey(p.story.fix) })),
  ]
  const changePlans = planChangeSkeletons(rng.fork('changes'), world, { count: counts.changes, linked })
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
  const changeNumbers = await allocateNumbers(session, opts.tenantId, 'change', changePlans.map((c) => c.id))
  const changeSkeletons: ChangeSkeleton[] = changePlans.map((c) => ({ ...c, code: changeNumbers.get(c.id)! }))
  log(`planned: ${String(incidentSkeletons.length)} incidents, ${String(problemSkeletons.length)} problems, ${String(changeSkeletons.length)} changes (${String(linked.length)} resolving)`)

  const milestones = await writeChangesPhase(run, world, ref, changeSkeletons)
  const byIncident = new Map<string, ResolvingChange>()
  for (const c of changeSkeletons.filter((x) => x.link?.kind === 'incident')) {
    const m = milestones.get(c.id)!
    if (m.closedAtMs === null) throw new Error(`change ${c.code} resolving an incident did not close`)
    byIncident.set(c.link!.ticketId, { changeId: c.id, code: c.code, createdAtMs: c.createdAtMs, closedAtMs: m.closedAtMs, closerId: m.closerId!, creatorId: c.requesterId })
  }
  const monitoring = await writeIncidentsPhase(run, world, ref, policy, incidentSkeletons, changeSkeletons, byIncident, bornTarget, olaFacts)
  const knownErrors = await writeProblemsPhase(run, world, problemSkeletons, changeSkeletons, milestones, olaFacts)
  // D16: the knowledge base the service desk wrote over the years.
  const articles = planKnowledgeBase(rng.fork('kb'), withTrailRng(world, 'kb'), knownErrors,
    incidentSkeletons.filter((s) => s.channel === 'portal').map((s) => ({ id: s.id, storyKey: s.story.id, createdAtMs: s.createdAtMs })))
  await writeKnowledgeBase(run.w, articles)
  log(`knowledge base: ${String(articles.length)} articles (${String(articles.filter((a) => a.props['published_at'] !== null).length)} published)`)
  return { monitoring }
}

/** Changes: the milestones first (task codes follow creation order), then the same simulation written in batches. */
async function writeChangesPhase(run: Run, world: World, ref: Reference, changeSkeletons: readonly ChangeSkeleton[]): Promise<Map<string, ChangeMilestones & { id: string; requesterId: string }>> {
  const { session, opts, rng, w, log } = run
  const taskEvents: Array<{ at: number; change: number; seq: number }> = []
  const milestones = new Map<string, ChangeMilestones & { id: string; requesterId: string }>()
  changeSkeletons.forEach((s, ci) => {
    let seq = 0
    const sim = simulateChange(rng.fork(`change/${s.id}`), withTrailRng(world, `change/${s.id}`), s, ref.config.questions, () => '')
    for (const t of sim.tasks) taskEvents.push({ at: t.createdAtMs, change: ci, seq: seq++ })
    milestones.set(s.id, { ...sim.milestones, id: s.id, requesterId: s.requesterId })
  })
  taskEvents.sort((a, b) => a.at - b.at || a.change - b.change || a.seq - b.seq)
  const taskBlock = await nextSequenceBlock(session, opts.tenantId, 'task', taskEvents.length)
  const taskCode = new Map<string, string>()
  taskEvents.forEach((e, i) => taskCode.set(`${String(e.change)}:${String(e.seq)}`, `TASK${String(taskBlock - taskEvents.length + 1 + i).padStart(8, '0')}`))
  for (let from = 0; from < changeSkeletons.length; from += 1000) {
    const batch = changeSkeletons.slice(from, from + 1000).map((s, k) => {
      let seq = 0
      const index = from + k
      return simulateChange(rng.fork(`change/${s.id}`), withTrailRng(world, `change/${s.id}`), s, ref.config.questions, () => taskCode.get(`${String(index)}:${String(seq++)}`)!)
    })
    await writeChanges(w, batch)
    log(`changes: ${String(Math.min(from + 1000, changeSkeletons.length))}/${String(changeSkeletons.length)}`)
  }
  return milestones
}

/**
 * Incidents. PRIMA PASSATA: quando ogni incident delle persone è rimasto
 * aperto (fino alla risoluzione) — il monitoraggio deve sapere cosa trovava
 * aperto su un CI nell'istante in cui scattava un allarme: lì lo aggancia,
 * altrove ne apre uno nuovo. La simulazione è deterministica per incident,
 * quindi la seconda passata, quella che scrive, rifà la stessa storia.
 */
async function writeIncidentsPhase(
  run: Run, world: World, ref: Reference, policy: DemoEventPolicy, incidentSkeletons: readonly IncidentSkeleton[],
  changeSkeletons: readonly ChangeSkeleton[], byIncident: Map<string, ResolvingChange>, bornTarget: number, olaFacts: OlaFacts,
): Promise<MonitoringPlan> {
  const { session, opts, rng, clock, w, log } = run
  const simulateOne = (s: IncidentSkeleton): SimulatedIncident =>
    simulateIncident(rng.fork(`incident/${s.id}`), withTrailRng(world, `incident/${s.id}`), s, byIncident.get(s.id) ?? null)
  const humanWindows: IncidentWindow[] = []
  for (const s of incidentSkeletons) {
    const ciId = s.ciIds[0]
    if (!ciId) continue
    const sim = simulateOne(s)
    humanWindows.push({ id: s.id, ciId, fromMs: s.createdAtMs, toMs: sim.trail.resolvedAtMs ?? clock.nowMs })
  }
  const deployWindows: DeployWindow[] = changeSkeletons
    .filter((c) => c.target === 'closed' || c.target === 'review' || c.target === 'deployment')
    .map((c) => ({ changeId: c.id, ciIds: c.ciIds, startMs: c.releaseStartMs, endMs: c.releaseEndMs }))
  const monitoring = planMonitoring(rng.fork('monitoring'), world, {
    alarmCycles: opts.counts.monitoringEvents, openedTarget: bornTarget,
    attachShare: DEMO_RATIOS.alarmsOnPeoplesIncidents, humanWindows, deployWindows,
    policy: { retentionDays: policy.retentionDays, openFrom: policy.openFrom, autoResolve: policy.autoResolve },
    names: ref.names,
  })
  const bornSkeletons = monitoring.born.map((b) => bornIncidentSkeleton(world, b, policy.critical(ref.cmdb.byId.get(b.ciId)!)))
  log(`monitoring: ${String(bornSkeletons.length)} incidents born from alarms, ${String(incidentSkeletons.length)} from people`)
  // I numeri seguono l'ordine di creazione, di tutti: persone e monitoraggio insieme.
  const allIncidents = [...incidentSkeletons, ...bornSkeletons].sort((a, b) => a.createdAtMs - b.createdAtMs)
  const incidentNumbers = await allocateNumbers(session, opts.tenantId, 'incident', allIncidents.map((s) => s.id))
  for (let from = 0; from < allIncidents.length; from += 2000) {
    const batch = allIncidents.slice(from, from + 2000).map(simulateOne)
    for (const sim of batch) olaFacts.add('incident', sim.trail)
    await writeIncidents(w, batch, incidentNumbers)
    log(`incidents: ${String(Math.min(from + 2000, allIncidents.length))}/${String(allIncidents.length)}`)
  }
  return monitoring
}

async function writeProblemsPhase(
  run: Run, world: World, problemSkeletons: readonly ProblemSkeleton[], changeSkeletons: readonly ChangeSkeleton[],
  milestones: Map<string, ChangeMilestones & { id: string; requesterId: string }>, olaFacts: OlaFacts,
): Promise<KnownErrorFact[]> {
  const knownErrors: KnownErrorFact[] = []
  const { session, opts, rng, w, log } = run
  const problemNumbers = await allocateNumbers(session, opts.tenantId, 'problem', problemSkeletons.map((s) => s.id))
  const changeOfProblem = new Map<string, string>()
  for (const c of changeSkeletons.filter((x) => x.link?.kind === 'problem')) changeOfProblem.set(c.link!.ticketId, c.id)
  for (let from = 0; from < problemSkeletons.length; from += 2000) {
    const batch = problemSkeletons.slice(from, from + 2000).map((s) => {
      const changeId = changeOfProblem.get(s.id)
      return simulateProblem(rng.fork(`problem/${s.id}`), withTrailRng(world, `problem/${s.id}`), s, changeId ? milestones.get(changeId)! : null)
    })
    for (const sim of batch) {
      olaFacts.add('problem', sim.trail)
      const known = sim.trail.audits.find((x) => x.action === 'problem.updated')
      if (!sim.workaround || !known || !sim.trail.assigneeId) continue
      const ci = world.cmdb.byId.get(sim.skeleton.ciId)!
      knownErrors.push({
        problemId: sim.skeleton.id, number: problemNumbers.get(sim.skeleton.id)!, title: sim.title, description: sim.description,
        workaround: sim.workaround, rootCause: sim.skeleton.story.rootCause, ciName: ci.name, ciLabel: ci.label,
        category: sim.skeleton.story.category, authorId: sim.trail.assigneeId, knownAtMs: Date.parse(known.created_at), incidentIds: sim.skeleton.incidentIds,
      })
    }
    await writeProblems(w, batch, problemNumbers)
    log(`problems: ${String(Math.min(from + 2000, problemSkeletons.length))}/${String(problemSkeletons.length)}`)
  }
  return knownErrors
}

async function simulateRequestsPhase(run: Run, world: World, catalog: BuiltCatalog, olaFacts: OlaFacts): Promise<void> {
  const { session, opts, rng, w, log } = run
  const systemValues = new Map<string, readonly string[]>()
  for (const e of await runQuery<{ name: string; values: string[] }>(session,
    `MATCH (e:EnumTypeDefinition) WHERE e.tenant_id IN ['system', $tenantId] RETURN e.name AS name, e.values AS values`, { tenantId: opts.tenantId })) {
    systemValues.set(e.name, e.values)
  }
  let pending: SimulatedRequest[] = []
  let written = 0
  const flush = async (): Promise<void> => {
    if (!pending.length) return
    const numbers = await allocateNumbers(session, opts.tenantId, 'service_request', pending.map((r) => r.id))
    await writeRequests(w, pending, numbers)
    written += pending.length
    log(`service requests: ${String(written)}/${String(opts.counts.serviceRequests)}`)
    pending = []
  }
  await simulateRequests(rng.fork('requests'), withTrailRng(world, 'requests'), { session, tenantId: opts.tenantId, catalog, systemValues },
    opts.counts.serviceRequests, async (r) => {
      olaFacts.add('service_request', r.trail)
      pending.push(r)
      if (pending.length >= 1000) await flush()
    })
  await flush()
}

/*
 * ── IL MONITORAGGIO: gli allarmi che la policy ha lasciato in vita ──────
 *
 * Solo quelli degli ultimi `retention_days` (più quelli legati a un
 * incident ancora aperto), scritti come li scrive l'ingest e con l'esito
 * che la pipeline ha dato loro. Quelli più vecchi li ha già cancellati il
 * job notturno: restano i contatori su incident e change, come li lascia
 * il prodotto.
 */
async function writeMonitoring(run: Run, monitoring: MonitoringPlan, sourceIds: Map<string, string>): Promise<void> {
  const { session, opts, rng, w, log } = run
  const iso = (ms: number): string => new Date(ms).toISOString()
  await w.nodes(['Event'], monitoring.events.map((e) => ({
    id: e.id, fingerprint: e.fingerprint, external_id: e.externalId, resource_external_id: e.resourceExternalId,
    status: e.status, severity: e.severity, max_severity: e.maxSeverity, title: e.title, description: e.description,
    resource: e.resource, resource_kind: e.resourceKind, labels: JSON.stringify(e.labels),
    count: int(e.count), first_seen_at: iso(e.firstSeenAtMs), last_seen_at: iso(e.lastSeenAtMs),
    last_received_at: iso(e.lastSeenAtMs), resolved_at: e.resolvedAtMs === null ? null : iso(e.resolvedAtMs),
    starts_at: iso(e.firstSeenAtMs), ends_at: e.resolvedAtMs === null ? null : iso(e.resolvedAtMs),
    // D40: the instant the pipeline decided, not the first sighting.
    correlation: e.correlation, correlation_at: iso(e.correlatedAtMs), correlation_due_at: null,
    // The pointer to the change lives only while the alarm is silenced; the
    // SUPPRESSED_BY edge below keeps the history either way.
    suppressed_by_change_id: e.status === 'suppressed' ? e.suppressedByChangeId : null, transitions: [],
    last_payload_status: e.status === 'suppressed' ? 'firing' : e.status,
    flapping_since: null, match_reason: e.matchReason, source_id: sourceIds.get(e.sourceKey)!,
    created_at: iso(e.firstSeenAtMs), updated_at: iso(e.lastSeenAtMs),
  })))
  await w.relationships('Event', 'FROM_SOURCE', 'InboundWebhook', monitoring.events.map((e) => ({ from: e.id, to: sourceIds.get(e.sourceKey)! })))
  await w.relationships('Event', 'RAISED_ON', 'ConfigurationItem', monitoring.events.map((e) => ({ from: e.id, to: e.ciId })))
  await w.children('Event', 'HAS_HISTORY', ['EventHistoryEntry'], monitoring.events.flatMap((e) => e.history.map((h) => ({
    parent: e.id,
    props: {
      // I campi di `historyWriteCypher` (services/events/history.ts), nessuno di più.
      id: rng.fork(`evh/${e.id}/${h.kind}/${String(h.atMs)}`).uuid(), event_id: e.id, at: iso(h.atMs), kind: h.kind,
      outcome: h.outcome ?? null, actor_id: 'monitoring', incident_id: h.incidentId ?? null,
      change_id: h.changeId ?? null, ci_id: null, note: h.note ?? null, severity: h.severity ?? null,
    },
  }))))
  await w.relationships('Event', 'CORRELATED_INTO', 'Incident',
    monitoring.events.filter((e) => e.incidentId !== null).map((e) => ({ from: e.id, to: e.incidentId!, props: { created_at: iso(e.correlatedAtMs), manual: false } })))
  await w.relationships('Event', 'SUPPRESSED_BY', 'Change',
    monitoring.events.filter((e) => e.suppressedByChangeId !== null).map((e) => ({ from: e.id, to: e.suppressedByChangeId!, props: { created_at: iso(e.suppressedAtMs ?? e.correlatedAtMs), last_seen_at: iso(e.lastSeenAtMs) } })))
  // Quello che la conservazione ha lasciato dietro di sé: i contatori.
  await session.executeWrite((tx) => tx.run(`
    UNWIND $rows AS row
    MATCH (i:Incident {id: row.id, tenant_id: $tenantId})
    SET i.correlated_events_purged = toInteger(row.n)`,
  { rows: [...monitoring.purgedByIncident.entries()].map(([id, n]) => ({ id, n })), tenantId: opts.tenantId }))
  await session.executeWrite((tx) => tx.run(`
    UNWIND $rows AS row
    MATCH (c:Change {id: row.id, tenant_id: $tenantId})
    SET c.suppressed_events_purged = toInteger(row.n)`,
  { rows: [...monitoring.purgedByChange.entries()].map(([id, n]) => ({ id, n })), tenantId: opts.tenantId }))
  // La salute dei CI su cui un allarme sta ancora suonando: la scrive solo
  // il monitoraggio (`health_source`), e non tocca mai `ci.status`, che è
  // il ciclo di vita.
  await session.executeWrite((tx) => tx.run(`
    UNWIND $rows AS row
    MATCH (c:ConfigurationItem {id: row.ciId, tenant_id: $tenantId})
    SET c.health = row.health, c.health_source = 'monitoring', c.last_event_at = row.at, c.health_since = row.since`,
  { rows: monitoring.health.map((h) => ({ ciId: h.ciId, health: h.health, at: iso(h.atMs), since: iso(h.sinceMs) })), tenantId: opts.tenantId }))
  await writeSourceCounters(run, monitoring, sourceIds)
  const firing = monitoring.events.filter((e) => e.status === 'firing').length
  log(`monitoring: ${String(monitoring.events.length)} alarms (${String(firing)} firing now), ${String(monitoring.health.length)} CIs with a health`)
}

/**
 * I CONTATORI DELLE SORGENTI: quante ne hanno ricevute e quando è arrivata
 * l'ultima. Senza, la pagina Sorgenti direbbe «0 ricevuti» accanto a
 * centoventimila allarmi. Le ricorrenze contano: ogni ripetizione è una consegna.
 */
async function writeSourceCounters(run: Run, monitoring: MonitoringPlan, sourceIds: Map<string, string>): Promise<void> {
  const perSource = new Map<string, { received: number; lastMs: number }>()
  for (const e of monitoring.events) {
    const id = sourceIds.get(e.sourceKey)!
    const cur = perSource.get(id) ?? { received: 0, lastMs: 0 }
    cur.received += e.count + (e.resolvedAtMs === null ? 0 : 1)   // le ripetizioni più il rientro
    cur.lastMs = Math.max(cur.lastMs, e.lastSeenAtMs)
    perSource.set(id, cur)
  }
  await run.session.executeWrite((tx) => tx.run(`
    UNWIND $rows AS row
    MATCH (w:InboundWebhook {id: row.id, tenant_id: $tenantId})
    SET w.receive_count = toInteger(row.received), w.last_received_at = row.at, w.updated_at = row.at`,
  { rows: [...perSource.entries()].map(([id, v]) => ({ id, received: v.received, at: new Date(v.lastMs).toISOString() })), tenantId: run.opts.tenantId }))
}

/*
 * I SERVIZI MONITORATI, creati con la mutation del prodotto, DOPO la salute
 * dei CI: le business application con più applicazioni di produzione sotto,
 * cioè quelle che un'azienda mette davvero sotto osservazione e che hanno
 * una mappa (`monitoredServiceCandidates`).
 */
async function createMonitoredServices(run: Run, ctx: GraphQLContext, cmdb: CMDBPlan, monitoring: MonitoringPlan): Promise<void> {
  const { session, opts, runId, clock, log, w, rng } = run
  const servicesSince = new Date().toISOString()
  const byWeight = monitoredServiceCandidates(cmdb, opts.counts.monitoredServices)
  for (const ba of byWeight) await serviceResolvers.Mutation.createServiceMap(null, { serviceId: ba.id }, ctx)
  await backdateAudits(session, opts.tenantId, runId, servicesSince, new Date(clock.nowMs - 60 * DAY).toISOString())
  /*
   * Marcare la mappa NON basta: creandola il motore scrive anche la sua
   * storia di salute (`ServiceHealthEntry`), e un nodo non marcato
   * sopravvive a `--clean`. Si marca tutto quello che la creazione ha lasciato.
   */
  for (const label of ['ServiceMap', 'ServiceHealthEntry']) {
    await session.executeWrite((tx) => tx.run(
      `MATCH (n:${label} {tenant_id: $tenantId}) WHERE n.demo_run_id IS NULL SET n.demo_run_id = $runId`,
      { tenantId: opts.tenantId, runId }))
  }
  // D43: set up two months ago, with the health its components' alarms gave it since.
  const changes = await backfillServiceHistory(session, w, rng.fork('service-history'), monitoring.events, clock.nowMs - 60 * DAY, clock.nowMs)
  log(`monitored services: ${String(byWeight.length)}, ${String(changes)} changes of health in their history`)
}

/** Reports and the dashboard (recent: made after the operation started). */
async function writeReportsPhase(run: Run, ctx: GraphQLContext, world: World, admin: PlannedUser): Promise<void> {
  const { session, opts, runId, clock, w, rng, log } = run
  const reportsSince = new Date().toISOString()
  const wanted = demoReports(world.workflows).slice(0, opts.counts.reports)
  const reports = await buildReports(ctx, wanted, DASHBOARD_WIDGETS.filter((d) => wanted.some((r) => r.name === d.report)))
  const reportsAt = new Date(clock.nowMs - 20 * DAY).toISOString()
  const dashboardAt = new Date(clock.nowMs - DAY).toISOString()
  await backdate(session, opts.tenantId, runId, 'ReportTemplate', reports.templates.map((t) => t.id), reportsAt, ['created_at', 'updated_at'])
  await session.executeWrite((tx) => tx.run(`
    MATCH (r:ReportTemplate {tenant_id: $tenantId})-[:HAS_SECTION]->(s:ReportSection) WHERE r.id IN $ids
    OPTIONAL MATCH (s)-[:HAS_NODE]->(n:ReportNode)
    SET s.demo_run_id = $runId, n.demo_run_id = $runId`,
  { tenantId: opts.tenantId, ids: reports.templates.map((t) => t.id), runId }))
  await backdate(session, opts.tenantId, runId, 'DashboardConfig', [reports.dashboardId], dashboardAt, ['created_at', 'updated_at'])
  await session.executeWrite((tx) => tx.run(`
    MATCH (d:DashboardConfig {id: $id, tenant_id: $tenantId})-[:HAS_WIDGET]->(x:DashboardWidget)
    SET x.created_at = $at, x.demo_run_id = $runId`, { id: reports.dashboardId, tenantId: opts.tenantId, at: dashboardAt, runId }))
  await backdateAudits(session, opts.tenantId, runId, reportsSince, reportsAt)
  const repRng = rng.fork('reports-registry')
  await w.nodes(['AuditEntry'], reports.registry.map((r) => registryRow(repRng, admin, Date.parse(reportsAt), r.mutation, r.returnType, r.args, r.result)))
  // D52: the questions to the AI report designer, minutes before the reports they became.
  const asked = wanted.filter((r) => AI_PROPOSED_SECTIONS[r.name])
  await w.nodes(['AuditEntry'], asked.map((r) => registryRow(repRng, admin, Date.parse(reportsAt) - repRng.int(2, 15) * MINUTE,
    'proposeReportSection', 'ReportDesignProposal!', { prompt: AI_PROPOSED_SECTIONS[r.name] }, null)))
  log(`reports: ${String(reports.templates.length)}, dashboard "Operations Overview"`)
}

/**
 * The app's timers, for the tickets still open (only when "now" is now), and
 * then the OLA contracts switched on: they were written off, so that the
 * running workers' OLA sweep does not alert the past before it is marked.
 */
async function afterRunPhase(run: Run): Promise<void> {
  const { session, opts, log, runId } = run
  if (Math.abs(opts.nowMs - Date.now()) >= DAY) {
    log('timers: "now" is not the present, no SLA job queued and no OLA alert marked')
  } else {
    const alerted = await markOlaAlerts(session, opts.tenantId, new Date(opts.nowMs), runId)
    const jobs = await scheduleOpenSlaJobs(session, opts.tenantId, new Date(opts.nowMs))
    log(`timers: ${String(jobs)} SLA jobs queued, ${String(alerted)} OLA breaches marked as already alerted`)
  }
  const enabled = await enableRunOlaContracts(session, opts.tenantId, runId)
  log(`OLA and UC contracts switched on: ${String(enabled)}`)
}

/**
 * THE ORGANIZATION'S OWN SETTINGS AND AUTOMATIONS (tour of 23 Sep 2026: D55,
 * D58, D68), made by its administrator: the notification retention and the
 * narrowed notification rules in the first days of the tenant (what the rules
 * were goes on the run, for the clean-up), the automations on the day each
 * was written, with the firings they have had since.
 */
async function organizationPhase(run: Run, ctx: GraphQLContext, catalog: BuiltCatalog, admin: PlannedUser): Promise<void> {
  const { session, opts, runId, clock, rng, w, log } = run
  const settingsSince = new Date().toISOString()
  const settingsAt = new Date(clock.startMs + 3 * DAY + 2 * HOUR).toISOString()
  await setDemoRetention(ctx)
  const tuned = await tuneNotificationRules(session, ctx)
  const channels = await createDemoChannels(session, ctx)
  const previous = firstStates([...tuned, ...channels.previous])
  await session.executeWrite((tx) => tx.run('MATCH (r:DemoDataRun {id: $runId, tenant_id: $tenantId}) SET r.previous_notification_rules = $rules',
    { runId, tenantId: opts.tenantId, rules: JSON.stringify(previous) }))
  await backdate(session, opts.tenantId, runId, 'NotificationChannel', channels.created.map((c) => c.id), settingsAt, ['created_at'])
  await backdateAudits(session, opts.tenantId, runId, settingsSince, settingsAt)
  // The channel mutation writes no entry of its own: the registry's, the address never passed on (the registry redacts it too).
  await w.nodes(['AuditEntry'], channels.created.map((c) => registryRow(rng.fork(`channel/${c.id}`), admin, Date.parse(settingsAt), 'createNotificationChannel', 'NotificationChannel!',
    { input: { platform: c.spec.platform, name: c.spec.name, webhookUrl: '[redacted]', eventTypes: [...DEMO_CHANNEL_EVENTS] } }, { id: c.id })))
  log(channels.platforms.length
    ? `notification channels: ${channels.platforms.join(', ')} (incidents assigned, changes approved)`
    : 'notification channels: none — DEMO_TEAMS_WEBHOOK_URL and DEMO_SLACK_WEBHOOK_URL are not set')

  const autoRng = rng.fork('automations')
  const automations = demoAutomations(catalog.items.find((i) => i.spec.key === 'privileged')?.id ?? null)
  let fired = 0
  for (const a of automations) {
    const atMs = writtenAt(autoRng, clock, a)
    const id = await createAutomation(ctx, a)
    const label = a.kind === 'trigger' ? 'AutoTrigger' : 'BusinessRule'
    await backdate(session, opts.tenantId, runId, label, [id], new Date(atMs).toISOString(), ['created_at', 'updated_at'])
    const firings = await automationFirings(session, autoRng, opts.tenantId, runId, a, id, atMs)
    if (a.kind === 'trigger') {
      await session.executeWrite((tx) => tx.run('MATCH (t:AutoTrigger {id: $id, tenant_id: $tenantId}) SET t.execution_count = $n, t.last_executed_at = $last',
        { id, tenantId: opts.tenantId, n: int(firings.audits.length), last: firings.last }))
    }
    await w.nodes(['AuditEntry'], [
      registryRow(autoRng, admin, atMs, a.kind === 'trigger' ? 'createAutoTrigger' : 'createBusinessRule', `${label}!`, { input: a.input }, { id }),
      ...firings.audits,
    ])
    fired += firings.audits.length
  }
  log(`organization: notifications kept ${String(DEMO_INAPP_RETENTION_DAYS)} days, ${String(previous.length)} notification rules narrowed, ${String(automations.length)} automations (${String(fired)} firings)`)
}

/**
 * THE PRODUCT'S OWN SCANS, ON THE FINISHED TENANT (tour of 23 Sep 2026, D47 and D50).
 *
 * The hourly anomaly scan ran while the generator was writing, and left 601
 * anomalies about a half-written CMDB; the nightly analysis of the
 * improvement proposals had never run on the tenant («The analysis has never
 * run»). Once everything is written: the anomalies written during the run go,
 * the scan runs once on the final data, and the proposals are analysed as the
 * nightly job does — its entry and its proposals carry the run's mark. Only
 * when "now" is the present: both read the real clock.
 */
async function finalScansPhase(run: Run): Promise<void> {
  const { session, opts, runId, log, started } = run
  if (Math.abs(opts.nowMs - Date.now()) >= DAY) {
    log('scans: "now" is not the present, no anomaly scan and no proposal analysis')
    return
  }
  const swept = await runQuery<{ n: unknown }>(session, `
    MATCH (a:Anomaly {tenant_id: $tenantId}) WHERE a.detected_at >= $since
    DETACH DELETE a
    RETURN count(*) AS n`, { tenantId: opts.tenantId, since: new Date(started).toISOString() })
  const scan = await scanTenant(opts.tenantId)
  const failed = scan.rules.filter((r) => r.error !== null)
  if (failed.length) throw new Error(`anomaly scan: ${failed.map((r) => `${r.ruleKey}: ${String(r.error)}`).join('; ')}`)
  log(`anomalies: ${String(Number(swept[0]?.n ?? 0))} written during the run removed; the scan found ${String(scan.rules.reduce((a, r) => a + r.hits, 0))}`)

  const since = new Date().toISOString()
  const esito = await conIlLucchetto(opts.tenantId, () => analizzaCliente(opts.tenantId))
  if (esito === null) {
    log('proposals: the nightly analysis is running on this tenant right now, and its result is the one the page shows')
    return
  }
  await recordAnalysisRun(opts.tenantId, esito, 'nightly')
  await session.executeWrite((tx) => tx.run(`
    CALL () {
      MATCH (p:Proposal {tenant_id: $tenantId}) WHERE p.created_at >= $since AND p.demo_run_id IS NULL RETURN p AS n
      UNION
      MATCH (a:AuditEntry {tenant_id: $tenantId, action: 'proposal.analysis_run'}) WHERE a.created_at >= $since AND a.demo_run_id IS NULL RETURN a AS n
    }
    SET n.demo_run_id = $runId`, { tenantId: opts.tenantId, since, runId }))
  log(`proposals: ${String(esito.create)} written${Object.keys(esito.saltate).length ? `, skipped ${JSON.stringify(esito.saltate)}` : ''}`)
}

/** A world whose trail ids and texts draw from a stream of their own (so pass 1 and pass 2 agree). */
function withTrailRng(world: World, label: string): World {
  const rng = world.trail.rng.fork(label)
  const trail: TrailContext = { ...world.trail, rng }
  return Object.assign(Object.create(Object.getPrototypeOf(world) as object) as World, world, { trail })
}

function registryRow(rng: Rng, actor: { id: string; email: string }, atMs: number, mutation: string, returnType: string, args: Record<string, unknown>, result: unknown) {
  return {
    ...auditRow(rng, actor, `mutation.${mutation}`, auditEntityType(mutation, { toString: () => returnType }, args),
      auditEntityId(args, result, mutation), atMs, { args: auditableArgs(args), source: 'audit-registry' }),
  }
}

function slaInput(p: import('./config.js').PlannedSlaPolicy): Record<string, unknown> {
  return {
    name: p.name, entityType: p.entityType, priority: p.priority, category: p.category, teamId: null, timezone: null,
    responseMinutes: p.responseMinutes, resolveMinutes: p.resolveMinutes, warningMinutes: p.warningMinutes,
    calendarId: p.calendarId, complianceTarget: p.complianceTarget, complianceWarning: p.complianceWarning,
  }
}
