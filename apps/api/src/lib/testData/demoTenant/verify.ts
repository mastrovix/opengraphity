/**
 * CHECKING A GENERATED DEMO TENANT THE WAY THE APP READS IT (23 Sep 2026).
 *
 * The owner of the product asked for precision and no mistakes. After a run,
 * this reads the tenant back — with the app's own functions where the app
 * has one — and reports every rule that does not hold:
 *  - counts and shares the owner fixed (users by role, teams, CIs, 75%
 *    active CIs, the tickets still open by kind, 90% internal teams, 50 catalog
 *    models, 20 reports);
 *  - the CMDB rules (declared edges only, the allowed chains, certificates
 *    and the servers of their applications);
 *  - every ticket's workflow history against the tenant's definitions (each
 *    move allowed, rows consecutive, status = current step = last row);
 *  - the changes in conflict, counted with `deployConflictsForChange`, and
 *    the changes that resolve an incident or a problem;
 *  - SLA and OLA as the ticket page reads them, form answers as the request
 *    page reads them, every report section executed by the report engine;
 *  - nothing dated after now (D46), what the organization chose (D50, D52,
 *    D55, D58, D68), and the configuration diagnostics with nothing to say
 *    (V1): the tour found the demo's first page showing three warnings.
 *
 * One section per function, all sharing a `Verifier`: the count of checks,
 * the failures and the facts.
 */
import type { Session } from 'neo4j-driver'
import { runQuery, toNumber } from '@opengraphity/neo4j'
import { PERMISSIONS } from '@opengraphity/types'
import type { GraphQLContext } from '../../../auth/resolveAuth.js'
import { deployConflictsForChange } from '../../changeDeployConflicts.js'
import { executeReportSection } from '../../reportExecutor.js'
import { loadTemplateSections } from '../../reportTemplates.js'
import { ticketSlaStatusResolver } from '../../../graphql/resolvers/ticketSlaStatus.js'
import { ticketOLAs } from '../../../graphql/resolvers/ola.js'
import type { GraphQLResolveInfo } from 'graphql'
import { getSchemaForTenant } from '../../../graphql/schemaCache.js'
import { formAnswersOf } from '../../catalogForm.js'
import { incidentResolvers } from '../../../graphql/resolvers/incident.js'
import { problemResolvers } from '../../../graphql/resolvers/problem.js'
import { changeResolvers } from '../../../graphql/resolvers/change/index.js'
import { serviceRequestResolvers } from '../../../graphql/resolvers/service_request.js'
import { loadTicketWorkflows } from './workflowModel.js'
import { DECLARED_EDGES } from './cmdb.js'
import { DEFAULT_DEMO_COUNTS, DEMO_RATIOS, type DemoCounts } from './options.js'
import { OLA_CONTRACT_COUNT } from './olaPlan.js'
import { requestMeanOpenDays } from './serviceRequests.js'
import { DEMO_CATALOG } from './catalogContent.js'
import { getEventPolicy } from '../../../services/events/policy.js'
import { configurationIssues, invalidateConfigurationIssues } from '../../configurationIssues.js'
import { AI_AUDIT_ACTIONS } from '../../dailyWorkAggregates.js'
import { DEMO_NOTIFICATION_TARGETS } from './organization.js'
import { cmdbHealthSummary } from '../../../services/cmdbHealth.js'
import { expectedHealthCards, healthFindingsFor } from './healthFindings.js'

export interface VerifyReport { checks: number; failures: string[]; facts: string[] }

/** What every section shares: the graph, the checks counted, the failures and the facts. */
class Verifier {
  checks = 0
  readonly failures: string[] = []
  readonly facts: string[] = []
  /** Now, with a minute of margin: nothing the run wrote may be later than this. */
  readonly nowIso = new Date(Date.now() + 60_000).toISOString()
  constructor(readonly session: Session, readonly tenantId: string) {}
  check(ok: boolean, what: string): void { this.checks++; if (!ok) this.failures.push(what) }
  rows<T>(cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
    return runQuery<T>(this.session, cypher, { tenantId: this.tenantId, ...params })
  }
  async one(cypher: string, params: Record<string, unknown> = {}): Promise<number> {
    return toNumber((await this.rows<{ n: unknown }>(cypher, params))[0]?.n ?? 0)
  }
}

export async function verifyDemoTenant(session: Session, tenantId: string, counts: DemoCounts, log: (m: string) => void): Promise<VerifyReport> {
  const v = new Verifier(session, tenantId)
  await countsAndShares(v, counts)
  await openAndDuplicates(v, counts)
  await cmdbRules(v, counts)
  await workflowHistories(v)
  await changeRules(v)
  await monitoringSources(v)
  await alarmRules(v, counts)
  await healthAndServices(v, counts)
  const ctx = await adminContext(v)
  await listPages(v, ctx, counts)
  await slaOlaAndForms(v, ctx)
  await reportsRun(v)
  await nothingAfterNow(v)
  await whatTheOrganizationChose(v)
  await configurationDiagnostics(v)
  log(`verify: ${String(v.checks)} checks, ${String(v.failures.length)} failures`)
  return { checks: v.checks, failures: v.failures, facts: v.facts }
}

// ── Counts and shares ────────────────────────────────────────────────────────
async function countsAndShares(v: Verifier, counts: DemoCounts): Promise<void> {
  const users = await v.rows<{ role: string; n: unknown }>(`MATCH (u:User {tenant_id: $tenantId}) WHERE u.demo_run_id IS NOT NULL RETURN u.role AS role, count(*) AS n`)
  const byRole = Object.fromEntries(users.map((u) => [u.role, toNumber(u.n)]))
  v.check(Object.values(byRole).reduce((a, b) => a + b, 0) === counts.users, `users: ${JSON.stringify(byRole)} (expected ${String(counts.users)})`)
  v.facts.push(`users by role: ${JSON.stringify(byRole)}`)
  const teams = await v.rows<{ type: string; sourcing: string; cm: boolean; n: unknown }>(`
    MATCH (t:Team {tenant_id: $tenantId}) WHERE t.demo_run_id IS NOT NULL
    RETURN t.type AS type, t.sourcing AS sourcing, coalesce(t.is_change_manager, false) AS cm, count(*) AS n`)
  const teamCount = (type: string) => teams.filter((t) => t.type === type && !t.cm).reduce((a, t) => a + toNumber(t.n), 0)
  v.check(teamCount('owner') === counts.ownerTeams, `owner teams ${String(teamCount('owner'))} ≠ ${String(counts.ownerTeams)}`)
  v.check(teamCount('support') === counts.supportTeams, `support teams ${String(teamCount('support'))} ≠ ${String(counts.supportTeams)}`)
  v.check(teams.filter((t) => t.cm).reduce((a, t) => a + toNumber(t.n), 0) === 1, 'exactly one change-manager team')
  const internal = teams.filter((t) => !t.cm && t.sourcing === 'internal').reduce((a, t) => a + toNumber(t.n), 0) / (counts.ownerTeams + counts.supportTeams)
  v.check(Math.abs(internal - 0.9) < 0.02, `internal teams ${(internal * 100).toFixed(1)}% (expected 90%)`)
  v.check(await v.one(`MATCH (t:Team {tenant_id: $tenantId}) WHERE t.demo_run_id IS NOT NULL AND NOT (t)-[:MANAGED_BY]->(:User) RETURN count(t) AS n`) === 0, 'every team has a manager')

  const labels: Array<[string, number]> = [['BusinessApplication', counts.businessApplications], ['Application', counts.applications], ['BusinessCapability', counts.capabilities],
    ['Server', counts.servers], ['DatabaseInstance', counts.databaseInstances], ['Database', counts.databases], ['Certificate', counts.certificates]]
  for (const [label, n] of labels) {
    const got = await v.one(`MATCH (c:ConfigurationItem:${label} {tenant_id: $tenantId}) RETURN count(c) AS n`)
    v.check(got === n, `${label}: ${String(got)} ≠ ${String(n)}`)
  }
  const active = await v.one(`MATCH (c:ConfigurationItem {tenant_id: $tenantId}) WHERE c.status = 'active' RETURN count(c) AS n`)
  const allCI = await v.one(`MATCH (c:ConfigurationItem {tenant_id: $tenantId}) RETURN count(c) AS n`)
  v.check(Math.abs(active / allCI - 0.75) < 0.02, `active CIs ${(active / allCI * 100).toFixed(1)}% (expected 75%)`)
  v.facts.push(`CIs: ${String(allCI)}, active ${(active / allCI * 100).toFixed(1)}%`)
  v.check(await v.one(`MATCH (i:ServiceCatalogItem {tenant_id: $tenantId}) RETURN count(i) AS n`) === counts.catalogItems, `catalog models ≠ ${String(counts.catalogItems)}`)
  v.check(await v.one(`MATCH (r:ReportTemplate {tenant_id: $tenantId}) WHERE r.demo_run_id IS NOT NULL RETURN count(r) AS n`) === counts.reports, `reports ≠ ${String(counts.reports)}`)
  v.check(await v.one(`MATCH (d:DashboardConfig {tenant_id: $tenantId}) WHERE d.demo_run_id IS NOT NULL RETURN count(d) AS n`) === 1, 'one demo dashboard')
}

/*
 * Gli APERTI non si controllano con una percentuale: escono dalle durate
 * (vedi `options.lifetimes`), quindi qui si controlla che il numero stia
 * nell'ordine di grandezza che la legge di Little prevede — arrivi al
 * giorno per durata media — e si RIPORTA il numero vero, che è quello che
 * poi si guarda nelle pagine.
 */
/** Durata media di una log-normale: mediana × e^(σ²/2), le due popolazioni pesate. */
function lifetimeMeanDays(life: { medianHours: number; spread: number; stuckShare: number; stuckMedianDays: number }): number {
  return (1 - life.stuckShare) * (life.medianHours / 24) * Math.exp(life.spread ** 2 / 2)
    + life.stuckShare * life.stuckMedianDays * Math.exp(0.85 ** 2 / 2)
}

async function openAndDuplicates(v: Verifier, counts: DemoCounts): Promise<void> {
  for (const [label, n, meanDays] of [
    ['Incident', counts.incidents, lifetimeMeanDays(DEMO_RATIOS.lifetimes.incident)],
    ['Problem', counts.problems, lifetimeMeanDays(DEMO_RATIOS.lifetimes.problem)],
    ['Change', counts.changes, lifetimeMeanDays(DEMO_RATIOS.lifetimes.change)],
    // The requests last as long as their catalog model says: the generator's own figure.
    ['ServiceRequest', counts.serviceRequests, requestMeanOpenDays(DEMO_CATALOG)],
  ] as const) {
    const total = await v.one(`MATCH (e:${label} {tenant_id: $tenantId}) RETURN count(e) AS n`)
    const open = await v.one(`MATCH (e:${label} {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance) WHERE wi.status = 'active' RETURN count(e) AS n`)
    v.check(total === n, `${label}: ${String(total)} ≠ ${String(n)}`)
    const expected = (total / (3 * 365)) * meanDays
    /*
     * La banda tiene conto del RUMORE dei numeri piccoli. Su un tenant in
     * scala 1:50 gli aperti attesi sono tre, e fra tre e tredici non c'è un
     * difetto: c'è il caso (e la coda incagliata, che pesa di più quando i
     * numeri sono pochi). Tre deviazioni di Poisson più un margine fisso
     * lasciano passare il caso e fermano l'errore di un ordine di grandezza.
     */
    const noise = 3 * Math.sqrt(expected) + 3
    v.check(open >= expected * 0.4 - noise && open <= expected * 2.5 + noise,
      `${label}: ${String(open)} open, but the lifetimes say about ${String(Math.round(expected))}`)
    v.facts.push(`${label}: ${String(total)}, open ${String(open)} (${(open / total * 100).toFixed(1)}%, expected about ${String(Math.round(expected))})`)
    const dup = await v.one(`MATCH (e:${label} {tenant_id: $tenantId}) WITH e.number AS num, count(*) AS c WHERE c > 1 RETURN count(num) AS n`)
    v.check(dup === 0, `${label}: duplicate numbers`)
  }
}

// ── CMDB rules ───────────────────────────────────────────────────────────────
async function cmdbRules(v: Verifier, counts: DemoCounts): Promise<void> {
  const planted = healthFindingsFor(counts)
  const edges = await v.rows<{ a: string; r: string; b: string; n: unknown }>(`
    MATCH (a:ConfigurationItem {tenant_id: $tenantId})-[r]->(b:ConfigurationItem {tenant_id: $tenantId})
    RETURN head([l IN labels(a) WHERE l <> 'ConfigurationItem']) AS a, type(r) AS r, head([l IN labels(b) WHERE l <> 'ConfigurationItem']) AS b, count(*) AS n`)
  const declared = new Set(DECLARED_EDGES.map(([a, r, b]) => `${a}|${r}|${b}`))
  for (const e of edges) v.check(declared.has(`${e.a}|${e.r}|${e.b}`), `undeclared edge ${e.a}-[:${e.r}]->${e.b} (${String(toNumber(e.n))})`)
  v.check(await v.one(`
    MATCH (a:ConfigurationItem:Application {tenant_id: $tenantId})-[:USES_CERTIFICATE]->(c:Certificate), (a)-[:HOSTED_ON]->(s:Server)
    WHERE NOT (c)-[:INSTALLED_ON]->(s) RETURN count(*) AS n`) === 0, 'a certificate used by an application is installed on all its servers')
  v.check(await v.one(`
    MATCH (i:ConfigurationItem:DatabaseInstance {tenant_id: $tenantId})-[:USES_CERTIFICATE]->(c:Certificate), (i)-[:HOSTED_ON]->(s:Server)
    WHERE NOT (c)-[:INSTALLED_ON]->(s) RETURN count(*) AS n`) === 0, 'a certificate used by an instance is installed on all its servers (24 Sep 2026)')
  v.check(await v.one(`MATCH (a:ConfigurationItem:Application {tenant_id: $tenantId}) WHERE NOT (:BusinessApplication)-[:REALIZES]->(a) RETURN count(a) AS n`) === 0, 'every application realizes a business application')
  v.check(await v.one(`MATCH (c:ConfigurationItem:BusinessCapability {tenant_id: $tenantId}) WHERE NOT (c)-[:ENABLED_BY]->(:BusinessApplication) RETURN count(c) AS n`) === 0, 'every capability is enabled by a business application')
  v.check(await v.one(`MATCH (c:ConfigurationItem {tenant_id: $tenantId}) WHERE c.chain IS NULL RETURN count(c) AS n`) === 0, 'every CI has its chain computed')
  // The owner's certificate shapes (24 Sep 2026): never a database's — but for the few planted
  // on purpose as relations no chain admits (healthFindings.ts).
  const databaseCertificates = await v.one(`MATCH (:Database {tenant_id: $tenantId})-[:USES_CERTIFICATE]->(c:Certificate) RETURN count(c) AS n`)
  v.check(databaseCertificates === planted.relationsNotAdmitted,
    `a certificate is a database's only where planted (${String(databaseCertificates)}, ${String(planted.relationsNotAdmitted)} planted)`)
  // The infrastructure flag: what serves the whole company is never in an application chain.
  v.check(await v.one(`MATCH (c:ConfigurationItem {tenant_id: $tenantId}) WHERE c.is_infrastructure = true AND c.chain = 'Application' RETURN count(c) AS n`) === 0,
    'no CI flagged as infrastructure is in an application chain')
  v.facts.push(`CIs flagged as infrastructure: ${String(await v.one(`MATCH (c:ConfigurationItem {tenant_id: $tenantId}) WHERE c.is_infrastructure = true RETURN count(c) AS n`))}`)
  // CMDB Health as the owner reads it (24 Sep 2026): each card shows exactly what was planted
  // (healthFindings.ts) — the rest of the demo breaks none of its rules — and all of them
  // together no more than 50 («non più di 50 tra tutte le casistiche»).
  const expected = expectedHealthCards(planted)
  const health = await cmdbHealthSummary(v.tenantId)
  for (const c of health.checks) {
    v.check(c.count === expected[c.key], `CMDB Health: "${c.key}" finds ${String(c.count)} of ${String(c.population)}, ${String(expected[c.key])} planted`)
  }
  const total = health.checks.reduce((sum, c) => sum + c.count, 0)
  v.check(total <= 50, `CMDB Health: ${String(total)} findings across every check, no more than 50 asked`)
  v.facts.push(`CMDB Health: ${String(total)} findings planted across ${String(health.checks.length)} checks; chains: ${health.chainCoverage.map((c) => `${c.name} ${String(c.complete)}/${String(c.roots)}`).join(', ')}`)
}

// ── Workflow histories ───────────────────────────────────────────────────────
async function workflowHistories(v: Verifier): Promise<void> {
  const workflows = await loadTicketWorkflows(v.session, v.tenantId)
  const defById = new Map(workflows.all.map((d) => [d.id, d]))
  let histories = 0
  for (const label of ['Incident', 'Problem', 'Change', 'ServiceRequest']) {
   for await (const rows of historyPages(v, label)) {
    for (const r of rows) {
      histories++
      const def = defById.get(r.def)!
      const moves = r.ex.filter((x) => x['from_step'] != null)
      const last = moves[moves.length - 1]
      v.check(!last || last['step_name'] === r.cur, `${label} ${r.id}: current step ${r.cur} is not the last one entered (${String(last?.['step_name'])})`)
      if (label !== 'Change' || moves.length > 0) v.check(r.status === r.cur, `${label} ${r.id}: status ${String(r.status)} ≠ step ${r.cur}`)
      v.check(r.wiStatus === (def.steps.get(r.cur)!.isTerminal ? 'completed' : 'active'), `${label} ${r.id}: instance status ${r.wiStatus} for step ${r.cur}`)
      for (const m of moves) {
        const allowed = def.transitions.some((t) => t.from === m['from_step'] && t.to === m['step_name'])
        v.check(allowed, `${label} ${r.id}: move ${String(m['from_step'])} → ${String(m['step_name'])} not in "${def.name}"`)
      }
      const open = r.ex.filter((x) => x['exited_at'] == null)
      v.check(open.length === 1, `${label} ${r.id}: ${String(open.length)} open history rows`)
      v.check(r.created <= r.updated && r.updated <= v.nowIso, `${label} ${r.id}: dates out of order`)
    }
   }
  }
  v.facts.push(`workflow histories checked: ${String(histories)}`)
}

type HistoryRow = { id: string; status: string | null; created: string; updated: string; def: string; cur: string; wiStatus: string; ex: Array<Record<string, unknown>> }

/**
 * The histories a page of tickets at a time (review of 23 Sep 2026). One
 * statement per label collected every history row of every ticket — about a
 * million property maps for the service requests at full scale, in one
 * transaction on a machine that has already hit the per-transaction memory
 * limit (clean.ts). Now the ids of a page first, then their histories.
 */
async function* historyPages(v: Verifier, label: string): AsyncGenerator<HistoryRow[]> {
  let after = ''
  for (;;) {
    const ids = (await v.rows<{ id: string }>(`MATCH (e:${label} {tenant_id: $tenantId}) WHERE e.id > $after RETURN e.id AS id ORDER BY e.id LIMIT 2000`,
      { after })).map((r) => r.id)
    if (!ids.length) return
    after = ids[ids.length - 1]!
    yield await v.rows<HistoryRow>(`
      MATCH (e:${label} {tenant_id: $tenantId}) WHERE e.id IN $ids
      MATCH (e)-[:HAS_WORKFLOW]->(wi:WorkflowInstance)-[:STEP_HISTORY]->(x:WorkflowStepExecution)
      WITH e, wi, x ORDER BY x.entered_at, coalesce(x.exited_at, '9999') , x.from_step IS NULL DESC
      RETURN e.id AS id, e.status AS status, e.created_at AS created, e.updated_at AS updated, wi.definition_id AS def,
             wi.current_step AS cur, wi.status AS wiStatus, collect(properties(x)) AS ex`, { ids })
  }
}

// ── Changes: conflicts and resolutions (the app's own conflict rule) ─────────
async function changeRules(v: Verifier): Promise<void> {
  const changes = await v.rows<{ id: string }>(`MATCH (c:Change {tenant_id: $tenantId}) RETURN c.id AS id`)
  let inConflict = 0
  for (const c of changes) if ((await deployConflictsForChange(v.session, v.tenantId, c.id)).items.length > 0) inConflict++
  const openChanges = await v.one(`MATCH (c:Change {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance) WHERE wi.status = 'active' RETURN count(c) AS n`)
  // Il 15% chiesto dal proprietario si misura su quelle APERTE: un conflitto
  // esiste fra finestre che si sovrappongono e con l'altra change non
  // conclusa, e le finestre delle change chiuse stanno nel passato.
  v.check(inConflict / Math.max(1, openChanges) >= 0.15, `changes in conflict ${String(inConflict)} of ${String(openChanges)} open (asked: at least 15%)`)
  v.facts.push(`changes in conflict: ${String(inConflict)} (${(inConflict / Math.max(1, openChanges) * 100).toFixed(1)}% of the open ones)`)
  const resolving = await v.one(`MATCH (c:Change {tenant_id: $tenantId}) WHERE (:Incident)-[:RESOLVED_BY]->(c) OR (:Problem)-[:RESOLVED_BY]->(c) RETURN count(c) AS n`)
  v.check(Math.abs(resolving / changes.length - 0.1) < 0.01, `resolving changes ${(resolving / changes.length * 100).toFixed(1)}% (asked: 10%)`)
  v.facts.push(`changes resolving an incident or problem: ${String(resolving)}`)
  /*
   * E la change nasce DOPO il ticket che risolve. Nella realtà l'incident si
   * apre, e solo allora qualcuno chiede la change che lo sistema: una change
   * più vecchia del suo incident si vede a occhio nel dettaglio del ticket, e
   * racconta una storia che non è mai successa.
   */
  const backwards = await v.rows<{ ticket: string; change: string }>(`
    MATCH (t)-[:RESOLVED_BY]->(c:Change {tenant_id: $tenantId})
    WHERE (t:Incident OR t:Problem) AND c.created_at < t.created_at
    RETURN t.number AS ticket, c.code AS change LIMIT 5`)
  v.check(backwards.length === 0, `changes created before the ticket they resolve: ${backwards.map((b) => `${b.change} < ${b.ticket}`).join(', ')}`)
  // G30: a task somebody is working on is held by somebody, as the product does
  // when the first answer or the saved plan starts it.
  const unheld = await v.one(`
    CALL {
      MATCH (t:AssessmentTask {tenant_id: $tenantId, status: 'in-progress'}) WHERE NOT (t)-[:ASSIGNED_TO]->(:User) RETURN t
      UNION ALL
      MATCH (t:DeployPlanTask {tenant_id: $tenantId, status: 'in-progress'}) WHERE NOT (t)-[:ASSIGNED_TO]->(:User) RETURN t
    }
    RETURN count(t) AS n`)
  v.check(unheld === 0, `change tasks in progress with nobody holding them: ${String(unheld)}`)
}

// ── Il monitoraggio ──────────────────────────────────────────────────────────
async function monitoringSources(v: Verifier): Promise<void> {
  const sources = await v.one(`MATCH (w:InboundWebhook {tenant_id: $tenantId, entity_type: 'event'}) WHERE w.demo_run_id IS NOT NULL RETURN count(w) AS n`)
  v.check(sources === 3, `monitoring sources: ${String(sources)} (expected 3)`)
  // Le sorgenti devono raccontare quello che hanno ricevuto: una pagina che
  // dice «0 ricevuti» accanto a centomila allarmi è peggio di una vuota.
  const silent = await v.one(`MATCH (w:InboundWebhook {tenant_id: $tenantId, entity_type: 'event'}) WHERE w.demo_run_id IS NOT NULL AND coalesce(w.receive_count, 0) = 0 RETURN count(w) AS n`)
  v.check(silent === 0, `${String(silent)} monitoring sources show no received alarms`)
  const alarms = await v.one(`MATCH (e:Event {tenant_id: $tenantId}) RETURN count(e) AS n`)
  v.check(alarms > 0, 'there are monitoring alarms in the retention window')
  v.check(await v.one(`MATCH (e:Event {tenant_id: $tenantId}) WHERE NOT (e)-[:FROM_SOURCE]->(:InboundWebhook) RETURN count(e) AS n`) === 0, 'every alarm comes from a source')
  v.check(await v.one(`MATCH (e:Event {tenant_id: $tenantId}) WHERE NOT (e)-[:RAISED_ON]->(:ConfigurationItem) RETURN count(e) AS n`) === 0, 'every alarm is raised on a CI')
  v.check(await v.one(`MATCH (e:Event {tenant_id: $tenantId}) WHERE NOT (e)-[:HAS_HISTORY]->(:EventHistoryEntry) RETURN count(e) AS n`) === 0, 'every alarm has a history')
  const dup = await v.one(`MATCH (e:Event {tenant_id: $tenantId}) WITH e.fingerprint AS f, count(*) AS c WHERE c > 1 RETURN count(f) AS n`)
  v.check(dup === 0, `${String(dup)} fingerprints are used by more than one alarm`)
  /*
   * L'allarme del certificato deve dire la stessa cosa del CMDB: parte trenta
   * giorni prima della scadenza scritta sul CI, e se è ancora acceso oggi quel
   * certificato è scaduto o sta per scadere. Due letture dello stesso fatto.
   */
  const certLies = await v.one(`
    MATCH (e:Event {tenant_id: $tenantId})-[:RAISED_ON]->(c:ConfigurationItem:Certificate {tenant_id: $tenantId})
    WHERE e.status = 'firing' AND datetime(c.expires_at) > datetime() + duration({days: 30})
    RETURN count(e) AS n`)
  v.check(certLies === 0, `${String(certLies)} certificate alarms are firing on a certificate that expires in more than 30 days`)
  const certAlarms = await v.one(`MATCH (e:Event {tenant_id: $tenantId})-[:RAISED_ON]->(:ConfigurationItem:Certificate) RETURN count(e) AS n`)
  v.facts.push(`alarms: ${String(alarms)} (${String(certAlarms)} on certificates), still firing ${String(await v.one(`MATCH (e:Event {tenant_id: $tenantId}) WHERE e.status = 'firing' RETURN count(e) AS n`))}`)
}

async function alarmRules(v: Verifier, counts: DemoCounts): Promise<void> {
  /*
   * Nessun allarme acceso senza esito: il motore vero lo riprenderebbe con la
   * sua rete di sicurezza e aprirebbe un incident datato «adesso». È successo
   * davvero con la prima versione — cinque incident nati tre minuti dopo la
   * generazione — ed è il controllo che l'avrebbe fermata.
   */
  const undecided = await v.one(`MATCH (e:Event {tenant_id: $tenantId}) WHERE e.status = 'firing' AND e.correlation IN ['none', 'pending'] RETURN count(e) AS n`)
  v.check(undecided === 0, `${String(undecided)} firing alarms have no correlation outcome: the engine would open incidents for them`)
  v.check(await v.one(`MATCH (e:Event {tenant_id: $tenantId}) WHERE e.correlation = 'suppressed' AND NOT (e)-[:SUPPRESSED_BY]->(:Change) RETURN count(e) AS n`) === 0,
    'every silenced alarm points at the change that silenced it')
  /*
   * Uno stato che il prodotto non produce: silenziato ma con l'ultimo payload
   * «rientrato». La tabella delle transizioni lo porta a `resolved`; lasciato
   * così, a fine finestra il motore lo libera e apre un incident. È successo.
   */
  v.check(await v.one(`MATCH (e:Event {tenant_id: $tenantId}) WHERE e.status = 'suppressed' AND e.last_payload_status = 'resolved' RETURN count(e) AS n`) === 0,
    'no alarm is silenced after it cleared (the engine would lift it and open an incident)')
  // Il generatore non lascia allarmi silenziati accesi: alla fine della loro finestra il motore aprirebbe incident «adesso».
  v.check(await v.one(`MATCH (e:Event {tenant_id: $tenantId}) WHERE e.status = 'suppressed' RETURN count(e) AS n`) === 0,
    'no alarm is still silenced (at the end of its window the engine would open an incident dated now)')
  v.check(await v.one(`MATCH (e:Event {tenant_id: $tenantId}) WHERE e.correlation IN ['opened', 'attached'] AND NOT (e)-[:CORRELATED_INTO]->(:Incident) RETURN count(e) AS n`) === 0,
    'every correlated alarm points at its incident')
  // Gli incident nati dal monitoraggio: quanti previsti, e ognuno con la sua traccia.
  const planned = Math.round(counts.incidents * DEMO_RATIOS.incidentsFromMonitoring)
  const bornIncidents = await v.one(`MATCH (i:Incident {tenant_id: $tenantId}) WHERE i.created_by = 'monitoring' RETURN count(i) AS n`)
  v.check(bornIncidents === planned, `incidents opened by monitoring: ${String(bornIncidents)} (planned ${String(planned)})`)
  const bornWithoutTrace = await v.one(`
    MATCH (i:Incident {tenant_id: $tenantId}) WHERE i.created_by = 'monitoring'
      AND NOT (:Event)-[:CORRELATED_INTO]->(i) AND coalesce(i.correlated_events_purged, 0) = 0
    RETURN count(i) AS n`)
  v.check(bornWithoutTrace === 0, `${String(bornWithoutTrace)} incidents opened by monitoring have neither their alarm nor the retention counter`)
  const autoResolved = await v.one(`
    MATCH (i:Incident {tenant_id: $tenantId})-[:HAS_WORKFLOW]->(:WorkflowInstance)-[:STEP_HISTORY]->(x:WorkflowStepExecution {step_name: 'resolved'})
    WHERE i.created_by = 'monitoring' AND x.triggered_by = 'monitoring' RETURN count(DISTINCT i) AS n`)
  v.facts.push(`incidents opened by monitoring: ${String(bornIncidents)}, closed by the engine when the alarm cleared: ${String(autoResolved)}`)
  const cutoffDays = (await getEventPolicy(v.tenantId)).retention_days
  if (cutoffDays > 0) {
    const tooOld = await v.one(`
      MATCH (e:Event {tenant_id: $tenantId})
      WHERE datetime(e.last_seen_at) < datetime() - duration({days: $days}) AND e.status <> 'firing'
        AND NOT EXISTS { MATCH (e)-[:CORRELATED_INTO]->(:Incident)-[:HAS_WORKFLOW]->(wi:WorkflowInstance) WHERE wi.status = 'active' }
      RETURN count(e) AS n`, { days: cutoffDays + 1 })
    v.check(tooOld === 0, `${String(tooOld)} alarms are older than the tenant keeps them (${String(cutoffDays)} days)`)
  }
}

async function healthAndServices(v: Verifier, counts: DemoCounts): Promise<void> {
  // La salute la scrive solo il monitoraggio, e mai sul ciclo di vita del CI.
  const badHealth = await v.one(`MATCH (c:ConfigurationItem {tenant_id: $tenantId}) WHERE c.health IS NOT NULL AND c.health_source <> 'monitoring' RETURN count(c) AS n`)
  v.check(badHealth === 0, `${String(badHealth)} CIs have a health that does not come from monitoring`)
  const withHealth = await v.one(`MATCH (c:ConfigurationItem {tenant_id: $tenantId}) WHERE c.health IS NOT NULL RETURN count(c) AS n`)
  v.facts.push(`CIs with a health from monitoring: ${String(withHealth)}`)
  // I servizi monitorati: esistono, hanno componenti e una salute valutata —
  // una mappa vuota è una pagina che promette e non mantiene.
  const maps = await v.one(`MATCH (m:ServiceMap {tenant_id: $tenantId}) RETURN count(m) AS n`)
  v.check(maps === counts.monitoredServices, `monitored services: ${String(maps)} (expected ${String(counts.monitoredServices)})`)
  const emptyMaps = await v.one(`MATCH (m:ServiceMap {tenant_id: $tenantId}) WHERE NOT (m)-[:INCLUDES]->() RETURN count(m) AS n`)
  v.check(emptyMaps === 0, `${String(emptyMaps)} monitored services have no components`)
  const unevaluated = await v.one(`MATCH (m:ServiceMap {tenant_id: $tenantId}) WHERE m.health IS NULL RETURN count(m) AS n`)
  v.check(unevaluated === 0, `${String(unevaluated)} monitored services have no health`)
  const mapHealth = await v.rows<{ health: string; n: unknown }>(`MATCH (m:ServiceMap {tenant_id: $tenantId}) RETURN m.health AS health, count(*) AS n`)
  v.facts.push(`monitored services by health: ${mapHealth.map((r) => `${r.health}=${String(toNumber(r.n))}`).join(', ')}`)
  const correlated = await v.one(`MATCH (:Event {tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId}) RETURN count(DISTINCT i) AS n`)
  v.facts.push(`incidents with monitoring alarms attached: ${String(correlated)}`)
}

// ── SLA, OLA, forms, as the pages read them (a sample) ───────────────────────
async function adminContext(v: Verifier): Promise<GraphQLContext> {
  const admin = (await v.rows<{ id: string; email: string }>(`MATCH (u:User {tenant_id: $tenantId, role: 'admin'}) WHERE u.demo_run_id IS NOT NULL RETURN u.id AS id, u.email AS email LIMIT 1`))[0]!
  return { tenantId: v.tenantId, userId: admin.id, userEmail: admin.email, role: 'admin', permissions: new Set(PERMISSIONS) } as unknown as GraphQLContext
}

/*
 * E le QUATTRO PAGINE di elenco, lette con i loro resolver: il proprietario
 * ha chiesto «mancano le service request» guardando l'app, e un conteggio di
 * nodi giusto non dice niente su quello che la pagina mostra. Qui si chiede
 * al resolver quante ne vede, esattamente come fa la pagina alla prima
 * apertura (nessun filtro, prima pagina).
 */
async function listPages(v: Verifier, ctx: GraphQLContext, counts: DemoCounts): Promise<void> {
  const schema = await getSchemaForTenant(v.tenantId)
  for (const [what, resolver, expected] of [
    ['incidents', incidentResolvers.Query.incidents, counts.incidents],
    ['problems', problemResolvers.Query.problems, counts.problems],
    ['changes', changeResolvers.Query.changes, counts.changes],
    ['service requests', serviceRequestResolvers.Query.serviceRequests, counts.serviceRequests],
  ] as const) {
    // I resolver degli elenchi leggono `info.schema` per sapere su quali campi
    // si può filtrare: qui si passa lo schema vero del tenant, lo stesso che
    // serve la pagina, invece di un finto che direbbe un'altra cosa.
    const page = await (resolver as (p: unknown, a: unknown, c: GraphQLContext, i: GraphQLResolveInfo) => Promise<{ items: unknown[]; total: number }>)(
      null, { limit: 20, offset: 0 }, ctx, { schema } as GraphQLResolveInfo)
    v.check(page.total === expected, `the ${what} page shows ${String(page.total)} of them, not ${String(expected)}`)
    // La prima pagina è piena, a meno che le righe siano meno di una pagina.
    v.check(page.items.length === Math.min(20, expected), `the ${what} page returns ${String(page.items.length)} rows on the first page`)
    v.facts.push(`${what} page: ${String(page.total)}`)
  }
}

async function slaOlaAndForms(v: Verifier, ctx: GraphQLContext): Promise<void> {
  // The contracts the run made are all there, and a full demo has the owner's twelve (review of 23 Sep 2026).
  const run = await v.rows<{ planned: unknown; counts: string | null }>(`MATCH (r:DemoDataRun {tenant_id: $tenantId}) WHERE r.status = 'completed' RETURN r.ola_contracts AS planned, r.counts AS counts ORDER BY r.completed_at DESC LIMIT 1`)
  const contracts = await v.one(`MATCH (o:OLAContract {tenant_id: $tenantId}) WHERE o.demo_run_id IS NOT NULL RETURN count(o) AS n`)
  const planned = run[0]?.planned == null ? null : toNumber(run[0].planned)
  if (planned !== null) v.check(contracts === planned, `OLA/UC contracts: ${String(contracts)}, the run made ${String(planned)}`)
  const runCounts = run[0]?.counts ? JSON.parse(run[0].counts) as { problems?: number; incidents?: number } : {}
  if ((runCounts.problems ?? 0) >= DEFAULT_DEMO_COUNTS.problems && (runCounts.incidents ?? 0) >= DEFAULT_DEMO_COUNTS.incidents) {
    v.check(contracts === OLA_CONTRACT_COUNT, `OLA/UC contracts: ${String(contracts)} of the ${String(OLA_CONTRACT_COUNT)} the full demo has`)
  }
  v.facts.push(`OLA/UC contracts: ${String(contracts)}`)
  for (const [label, entity] of [['Incident', 'incident'], ['Problem', 'problem'], ['ServiceRequest', 'service_request']] as const) {
    const withoutSla = await v.one(`MATCH (e:${label} {tenant_id: $tenantId}) WHERE NOT (e)-[:HAS_SLA]->(:SLAStatus) RETURN count(e) AS n`)
    v.check(withoutSla === 0, `${label}: ${String(withoutSla)} without SLA`)
    const sample = await v.rows<{ id: string }>(`MATCH (e:${label} {tenant_id: $tenantId}) RETURN e.id AS id ORDER BY e.id LIMIT 200`)
    const resolver = ticketSlaStatusResolver(label)
    for (const s of sample) {
      try { await resolver({ id: s.id }, null, ctx); v.checks++ } catch (e) { v.failures.push(`${label} ${s.id}: SLA badge fails: ${(e as Error).message}`) }
      try { await ticketOLAs(null, { entityType: entity, entityId: s.id }, ctx); v.checks++ } catch (e) { v.failures.push(`${label} ${s.id}: OLA card fails: ${(e as Error).message}`) }
    }
  }
  const met = await v.one(`MATCH (s:SLAStatus {tenant_id: $tenantId}) WHERE s.resolve_met = true RETURN count(s) AS n`)
  const concluded = await v.one(`MATCH (s:SLAStatus {tenant_id: $tenantId}) WHERE s.resolved_at IS NOT NULL RETURN count(s) AS n`)
  v.facts.push(`SLA met on concluded tickets: ${(met / Math.max(1, concluded) * 100).toFixed(1)}%`)
  const requests = await v.rows<{ id: string; item: string; rev: unknown; props: Record<string, unknown> }>(`
    MATCH (r:ServiceRequest {tenant_id: $tenantId}) RETURN r.id AS id, r.catalog_item_id AS item, r.form_revision AS rev, properties(r) AS props ORDER BY r.id LIMIT 300`)
  let emptyForms = 0
  for (const r of requests) {
    const answers = await formAnswersOf(v.session, v.tenantId, { id: r.id, catalogItemId: r.item, formRevision: toNumber(r.rev), props: r.props })
    if (answers.length === 0) emptyForms++
  }
  v.check(emptyForms === 0, `${String(emptyForms)} service requests show no form answers`)
  v.check(await v.one(`
    MATCH (r:ServiceRequest {tenant_id: $tenantId}) WHERE r.requires_approval = true AND r.status IN ['in_progress', 'fulfilled', 'closed']
      AND NOT EXISTS { MATCH (r)-[:HAS_WORKFLOW]->(:WorkflowInstance)-[:STEP_HISTORY]->(x:WorkflowStepExecution {step_name: 'approval'}) WHERE x.exited_at IS NOT NULL }
    RETURN count(r) AS n`) === 0, 'every request that needs an approval went through it')
}

// ── Reports: every section runs ──────────────────────────────────────────────
async function reportsRun(v: Verifier): Promise<void> {
  const templates = await v.rows<{ id: string; name: string }>(`MATCH (t:ReportTemplate {tenant_id: $tenantId}) WHERE t.demo_run_id IS NOT NULL RETURN t.id AS id, t.name AS name`)
  for (const t of templates) {
    for (const section of await loadTemplateSections(v.session, t.id, v.tenantId)) {
      const r = await executeReportSection(section, v.tenantId)
      v.check(r.error === null, `report "${t.name}" / "${section.title}": ${String(r.error)}`)
    }
  }
}

/**
 * NOTHING DATED AFTER NOW (tour of 23 Sep 2026, D46). A certificate alarm
 * written at «expiry − 30 days», later than the run's now: the source said
 * «Last received: just now» for hours and the alarm led the list. Every
 * instant of a thing that has HAPPENED, label by label; deadlines and planned
 * windows are in the future on purpose and are not here.
 */
export const HAPPENED_AT: ReadonlyArray<readonly [label: string, props: readonly string[]]> = [
  ['Incident', ['created_at', 'updated_at', 'resolved_at', 'closed_at']], ['Problem', ['created_at', 'updated_at', 'resolved_at']],
  ['Change', ['created_at', 'updated_at']], ['ServiceRequest', ['created_at', 'updated_at', 'fulfilled_at', 'closed_at']],
  ['WorkflowStepExecution', ['entered_at', 'exited_at']], ['Comment', ['created_at']], ['AuditEntry', ['created_at']],
  ['Event', ['created_at', 'first_seen_at', 'last_seen_at', 'last_received_at', 'resolved_at', 'correlation_at']], ['EventHistoryEntry', ['at']],
  ['InboundWebhook', ['created_at', 'last_received_at']], ['KBArticle', ['created_at', 'updated_at', 'published_at']],
  ['LogEntry', ['timestamp']], ['ServiceHealthEntry', ['at']], ['ApprovalRequest', ['requested_at', 'resolved_at']],
]

async function nothingAfterNow(v: Verifier): Promise<void> {
  for (const [label, props] of HAPPENED_AT) {
    const late = await v.one(`
      MATCH (n:${label} {tenant_id: $tenantId}) WHERE n.demo_run_id IS NOT NULL AND any(p IN $props WHERE n[p] > $now)
      RETURN count(n) AS n`, { now: v.nowIso, props })
    v.check(late === 0, `${label}: ${String(late)} dated after now (${props.join(', ')})`)
  }
}

/**
 * WHAT THE ORGANIZATION CHOSE, AND WHAT RAN ON IT (tour of 23 Sep 2026: D47,
 * D50, D52, D58, D68). The retention (D55) is in the diagnostics below.
 */
async function whatTheOrganizationChose(v: Verifier): Promise<void> {
  const everyone = await v.one(`MATCH (r:NotificationRule {tenant_id: $tenantId}) WHERE r.event_type IN $events AND r.target = 'all' RETURN count(r) AS n`,
    { events: DEMO_NOTIFICATION_TARGETS.map(([e]) => e) })
  v.check(everyone === 0, `${String(everyone)} notification rules still tell everyone (D58)`)
  const triggers = await v.rows<{ name: string; count: unknown; last: string | null; audits: unknown; lastAudit: string | null }>(`
    MATCH (t:AutoTrigger {tenant_id: $tenantId}) WHERE t.demo_run_id IS NOT NULL
    OPTIONAL MATCH (a:AuditEntry {tenant_id: $tenantId, action: 'trigger.executed', entity_id: t.id})
    RETURN t.name AS name, t.execution_count AS count, t.last_executed_at AS last, count(a) AS audits, max(a.created_at) AS lastAudit`)
  for (const t of triggers) {
    v.check(toNumber(t.count) === toNumber(t.audits) && t.last === t.lastAudit, `trigger "${t.name}": ${String(toNumber(t.count))} runs counted, ${String(toNumber(t.audits))} in the Audit Log (D68)`)
  }
  const rules = await v.one(`MATCH (r:BusinessRule {tenant_id: $tenantId}) WHERE r.demo_run_id IS NOT NULL RETURN count(r) AS n`)
  v.check(triggers.length > 0 && rules > 0, `automations: ${String(triggers.length)} triggers, ${String(rules)} business rules (D68)`)
  const run = (await v.rows<{ now: string; started: string }>(`MATCH (r:DemoDataRun {tenant_id: $tenantId}) RETURN r.now AS now, r.started_at AS started ORDER BY r.started_at DESC LIMIT 1`))[0]
  const lastAnalysis = (await v.rows<{ at: string }>(`MATCH (a:AuditEntry {tenant_id: $tenantId, action: 'proposal.analysis_run'}) RETURN a.created_at AS at ORDER BY at DESC LIMIT 1`))[0]?.at ?? null
  // The final scans run only when the run's now was the present (they read the real clock).
  if (run && Math.abs(Date.parse(run.now) - Date.parse(run.started)) < 86_400_000) {
    v.check(lastAnalysis !== null, 'the improvement proposals were never analysed (D50)')
    const stale = await v.one(`MATCH (a:Anomaly {tenant_id: $tenantId}) WHERE a.detected_at < $started RETURN count(a) AS n`, { started: run.started })
    v.check(stale === 0, `${String(stale)} anomalies are older than this run (D47)`)
  }
  const aiActions = await v.rows<{ action: string; n: unknown }>(`
    MATCH (a:AuditEntry {tenant_id: $tenantId}) WHERE a.action IN $actions AND a.created_at >= $since RETURN a.action AS action, count(*) AS n`,
  { actions: [...AI_AUDIT_ACTIONS], since: new Date(Date.now() - 30 * 86_400_000).toISOString() })
  v.facts.push(`proposals analysed: ${String(lastAnalysis)}; AI actions in the last 30 days: ${aiActions.map((a) => `${a.action}=${String(toNumber(a.n))}`).join(', ') || 'none'}`)
}

/**
 * V1 (tour of 23 Sep 2026): the configuration diagnostics, as the banner reads
 * them, have nothing to say. The tour found three warnings on the demo's first
 * page (vocabularies without Italian labels, the notification retention, the
 * catalog items without a fulfilment group): each one is a failure here.
 */
async function configurationDiagnostics(v: Verifier): Promise<void> {
  invalidateConfigurationIssues(v.tenantId)
  const issues = await configurationIssues(v.tenantId)
  v.check(issues.length === 0, `configuration diagnostics: ${issues.map((i) => `${i.kind} ${JSON.stringify(i.params)}`).join(' · ')}`)
}
