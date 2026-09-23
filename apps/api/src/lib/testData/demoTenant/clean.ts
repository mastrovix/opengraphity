/**
 * REMOVING A DEMO TENANT'S DATA (23 Sep 2026).
 *
 * Everything the generator wrote carries `demo_run_id`: those nodes go, with
 * their relationships, in batches. What the run changed outside its own
 * nodes is put back from the run's record: the catalog limits, the event
 * policy, the notification retention and the notification rules the
 * generator narrowed.
 *
 * The tour of 23 Sep 2026 showed what that was not enough for:
 *  - D6: the ticket numbers went on from the previous run (INC00050001):
 *    the counters were put back to what the run had RECORDED, and the run had
 *    recorded counters that an older clean-up had not reset. Now a counter
 *    goes back to the highest number still in the tenant, or away if none is;
 *  - D47: the live system works on the demo while it exists — the hourly
 *    anomaly scan, the bell notifications, the improvement proposals — and
 *    none of that carries the mark: 601 anomalies of the previous run
 *    survived. What the product derives from the tenant's data goes whole;
 *  - the play on top of the demo (the tickets, comments, transitions and
 *    conversations of whoever used it after it was generated) hung from
 *    tickets that the clean-up removed: what was written after the first run
 *    started, in the labels of the work, goes too;
 *  - D60: 13,908 SLA timers of deleted tickets waited in the queue, and each
 *    one fired into «no SLAStatus (entity deleted)»: the timers of tickets
 *    that no longer exist are removed from the queue.
 *
 * Configuration is never swept by time: a rule, a policy, a user, a dashboard
 * someone added stays.
 */
import neo4j from 'neo4j-driver'
import type { Session } from 'neo4j-driver'
import { rm } from 'node:fs/promises'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { getQueue } from '../../bullmq.js'
import { TICKET_NUMBER_KINDS, type TicketNumberKind } from '../../ticketNumbering.js'
import { syntheticActorIds } from '../../auditActors.js'

interface RunRecord {
  id: string
  startedAt: string
  limits: string | null
  eventPolicy: string | null
  /** A run of an older generator did not record the policy: then it is not touched. */
  hasEventPolicy: boolean
  retention: number | null
  hasRetention: boolean
  rules: string | null
}

/** What the live system derives from the tenant's data: rebuilt by it, gone with the data (D47). */
export const DERIVED_LABELS: readonly string[] = ['Anomaly', 'InAppNotification', 'Proposal', 'ProposalRejection']

/**
 * The labels of the WORK done on the tenant, with the property that says when
 * each node was written: an unmarked one written after the first run started
 * is play on top of the demo. Configuration labels are not here, on purpose.
 */
export const WORK_SINCE_RUN: ReadonlyArray<readonly [label: string, at: string]> = [
  ['Incident', 'created_at'], ['Problem', 'created_at'], ['Change', 'created_at'], ['ServiceRequest', 'created_at'],
  ['KBArticle', 'created_at'], ['KBArticleVersion', 'edited_at'],
  ['WorkflowInstance', 'created_at'], ['WorkflowStepExecution', 'entered_at'], ['Comment', 'created_at'],
  ['ChangeAuditEntry', 'timestamp'], ['ChangeApproval', 'created_at'], ['AssessmentResponse', 'answered_at'],
  ['AssessmentTask', 'created_at'], ['DeployPlanTask', 'created_at'], ['ValidationTest', 'created_at'],
  ['DeploymentTask', 'created_at'], ['ReviewTask', 'created_at'], ['Task', 'created_at'],
  ['TicketTeamSegment', 'started_at'], ['SLAStatus', 'started_at'], ['ApprovalRequest', 'requested_at'],
  ['Attachment', 'uploaded_at'], ['ReportConversation', 'created_at'], ['ReportMessage', 'created_at'],
  ['InternalMessage', 'created_at'], ['CIAlias', 'created_at'], ['Event', 'created_at'],
  ['EventHistoryEntry', 'at'], ['ServiceHealthEntry', 'at'], ['LogEntry', 'timestamp'], ['AuditEntry', 'created_at'],
]

const TICKET_LABELS: Readonly<Record<TicketNumberKind, string>> = { incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'ServiceRequest' }
/** The nodes that carry a `TASK…` code (`getNextTaskCodes`, `ticketTasks.ts`). */
const TASK_CODE_LABELS: readonly string[] = ['AssessmentTask', 'DeployPlanTask', 'ValidationTest', 'DeploymentTask', 'ReviewTask', 'Task']

/** The number inside a ticket or task code: the digits at its end (`INC00000042` → 42). */
export function sequenceOf(code: unknown): number | null {
  const m = typeof code === 'string' ? /(\d+)$/.exec(code) : null
  return m ? Number(m[1]) : null
}

export async function cleanDemoTenant(tenantId: string, log: (message: string) => void): Promise<{ deleted: number }> {
  const session = getSession(undefined, neo4j.session.WRITE)
  try {
    const runs = await runQuery<RunRecord>(session, `
      MATCH (r:DemoDataRun {tenant_id: $tenantId})
      RETURN r.id AS id, r.started_at AS startedAt, r.previous_limits AS limits,
             r.previous_event_policy AS eventPolicy, 'previous_event_policy' IN keys(r) AS hasEventPolicy,
             r.previous_notification_retention AS retention, 'previous_notification_retention' IN keys(r) AS hasRetention,
             r.previous_notification_rules AS rules
      ORDER BY r.started_at ASC`, { tenantId })
    // The oldest run knows how the tenant was before any of them.
    const first = runs[0] ?? null
    const labels = (await runQuery<{ label: string }>(session, 'CALL db.labels() YIELD label RETURN label', {}))
      .map((r) => r.label).filter((l) => /^[A-Za-z][A-Za-z0-9_]*$/.test(l))
    const marked = await deleteMarked(session, tenantId, labels, log)
    const swept = await sweepLiveData(session, tenantId, first?.startedAt ?? null, labels)
    if (swept > 0) log(`removed ${String(swept)} nodes the live system and the people using the demo wrote on it`)
    const counters = await resetCounters(session, tenantId)
    log(`counters: ${counters.map((c) => `${c.kind} ${c.value === null ? 'removed' : `at ${String(c.value)}`}`).join(', ')}`)
    if (first) await restoreSettings(session, tenantId, first)
    const timers = await removeTimersOfDeletedTickets(session, tenantId)
    if (timers > 0) log(`removed ${String(timers)} SLA timers of tickets that no longer exist`)
    return { deleted: marked + swept }
  } finally {
    await session.close()
  }
}

/*
 * CANCELLARE CINQUE MILIONI DI NODI SENZA FAR CADERE IL DATABASE.
 *
 * Tre tentativi, e ognuno ha insegnato una cosa:
 *  1. blocchi da diecimila dentro una transazione → «the allocation of an
 *     extra 48 MiB would use more than the limit 2.8 GiB» (il tetto per
 *     transazione, il 70% dell'heap);
 *  2. blocchi da duemila → stesso muro: non è la dimensione del blocco,
 *     è il `MATCH` su TUTTI i nodi del tenant che lavora su un insieme
 *     enorme prima di tagliarlo;
 *  3. `CALL … IN TRANSACTIONS` sulla stessa MATCH senza etichetta → la
 *     scansione di tutti i nodi ha fatto CADERE il server a metà strada
 *     («Connection was closed by server»), e il tenant è rimasto mezzo
 *     cancellato.
 *
 * La forma che regge: una etichetta per volta. Con l'etichetta Neo4j parte
 * dalla scansione di quella sola etichetta (e dagli indici su `tenant_id`
 * dove ci sono) invece che da tutti i nodi del database, e `IN
 * TRANSACTIONS` spezza il lavoro in transazioni vere da mille righe che
 * liberano la memoria a ogni pezzo.
 */
async function deleteMarked(session: Session, tenantId: string, labels: readonly string[], log: (message: string) => void): Promise<number> {
  const deleted = await countMarked(session, tenantId, labels)
  if (deleted > 0) log(`removing ${String(deleted)} nodes, ${String(labels.length)} labels`)
  for (const label of labels) {
    await session.run(`
      MATCH (n:${label} {tenant_id: $tenantId}) WHERE n.demo_run_id IS NOT NULL
      CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS
    `, { tenantId })
  }
  // Every node has a label, so the loop above reached them all: say so if not.
  const left = await countMarked(session, tenantId, labels)
  if (left > 0) throw new Error(`clean: ${String(left)} marked nodes are still there after the pass label by label`)
  return deleted
}

/**
 * The live system's and the people's writes (D47): the derived nodes whole,
 * the work written since the first run started, and — whenever they were
 * written — the health and alarm history left hanging from nodes that are
 * gone. Attachment files go with their nodes, as `deleteProblem` does.
 */
async function sweepLiveData(session: Session, tenantId: string, sinceIso: string | null, labels: readonly string[]): Promise<number> {
  const present = new Set(labels)
  let swept = 0
  const run = async (cypher: string, params: Record<string, unknown> = {}): Promise<number> => {
    const rows = await runQuery<{ n: unknown }>(session, cypher, { tenantId, ...params })
    return Number(rows[0]?.n ?? 0)
  }
  for (const label of DERIVED_LABELS.filter((l) => present.has(l))) {
    swept += await run(`MATCH (n:${label} {tenant_id: $tenantId}) CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS RETURN count(*) AS n`)
  }
  if (sinceIso) {
    const files = await runQuery<{ path: string | null }>(session, `
      MATCH (a:Attachment {tenant_id: $tenantId}) WHERE a.demo_run_id IS NULL AND a.uploaded_at >= $since RETURN a.storage_path AS path`,
    { tenantId, since: sinceIso })
    for (const [label, at] of WORK_SINCE_RUN.filter(([l]) => present.has(l))) {
      swept += await run(`
        MATCH (n:${label} {tenant_id: $tenantId}) WHERE n.demo_run_id IS NULL AND n[$at] >= $since
        CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 1000 ROWS RETURN count(*) AS n`, { since: sinceIso, at })
    }
    for (const f of files) if (f.path) await rm(f.path, { force: true })
  }
  swept += await run(ORPHAN_AUDIT_CYPHER, { synthetic: syntheticActorIds() })
  swept += await run(`
    MATCH (h:ServiceHealthEntry {tenant_id: $tenantId}) WHERE NOT ()-[:HAS_HEALTH_HISTORY]->(h)
    CALL (h) { DETACH DELETE h } IN TRANSACTIONS OF 1000 ROWS RETURN count(*) AS n`)
  swept += await run(`
    MATCH (h:EventHistoryEntry {tenant_id: $tenantId}) WHERE NOT ()-[:HAS_HISTORY]->(h)
    CALL (h) { DETACH DELETE h } IN TRANSACTIONS OF 1000 ROWS RETURN count(*) AS n`)
  return swept
}

/**
 * THE HISTORY OF WHAT NO LONGER EXISTS. An entry without the mark that an
 * earlier clean-up missed (written by a mutation after its phase was moved,
 * before `settleLateAudits` existed; or by the live system on an alarm since
 * deleted) stays in the Audit Log for ever, speaking of a person or a ticket
 * that is gone. Swept whenever it was written: by a person who no longer
 * exists in the tenant, or about a piece of work that no longer exists. The
 * entries of the synthetic actors about things that still exist, and of the
 * people still there, stay.
 */
export const ORPHAN_AUDIT_CYPHER = `
  MATCH (a:AuditEntry {tenant_id: $tenantId}) WHERE a.demo_run_id IS NULL
    AND ((a.user_id IS NOT NULL AND NOT a.user_id IN $synthetic AND NOT EXISTS { MATCH (:User {id: a.user_id, tenant_id: $tenantId}) })
      OR (a.entity_type = 'Event' AND NOT EXISTS { MATCH (:Event {id: a.entity_id, tenant_id: $tenantId}) })
      OR (a.entity_type = 'Incident' AND NOT EXISTS { MATCH (:Incident {id: a.entity_id, tenant_id: $tenantId}) })
      OR (a.entity_type = 'Problem' AND NOT EXISTS { MATCH (:Problem {id: a.entity_id, tenant_id: $tenantId}) })
      OR (a.entity_type = 'Change' AND NOT EXISTS { MATCH (:Change {id: a.entity_id, tenant_id: $tenantId}) })
      OR (a.entity_type = 'ServiceRequest' AND NOT EXISTS { MATCH (:ServiceRequest {id: a.entity_id, tenant_id: $tenantId}) })
      OR (a.entity_type = 'ServiceMap' AND NOT EXISTS { MATCH (:ServiceMap {id: a.entity_id, tenant_id: $tenantId}) })
      OR (a.entity_type = 'KBArticle' AND NOT EXISTS { MATCH (:KBArticle {id: a.entity_id, tenant_id: $tenantId}) }))
  CALL (a) { DETACH DELETE a } IN TRANSACTIONS OF 1000 ROWS
  RETURN count(*) AS n`

/**
 * D6: each counter goes back to the highest number still in the tenant, and
 * away when there is none — the next generation, or the next ticket someone
 * opens, numbers from there. Read from the tickets and the tasks themselves,
 * not from a record that can be stale.
 */
async function resetCounters(session: Session, tenantId: string): Promise<Array<{ kind: string; value: number | null }>> {
  const highest = async (labels: readonly string[], property: string): Promise<number | null> => {
    let max: number | null = null
    for (const label of labels) {
      const rows = await runQuery<{ code: unknown }>(session, `
        MATCH (n:${label} {tenant_id: $tenantId}) WHERE n[$property] IS NOT NULL
        RETURN n[$property] AS code ORDER BY size(n[$property]) DESC, n[$property] DESC LIMIT 1`, { tenantId, property })
      const n = sequenceOf(rows[0]?.code)
      if (n !== null && (max === null || n > max)) max = n
    }
    return max
  }
  const out: Array<{ kind: string; value: number | null }> = []
  const kinds: Array<[string, readonly string[], string]> = [
    ...TICKET_NUMBER_KINDS.map((k): [string, readonly string[], string] => [k, [TICKET_LABELS[k]], 'number']),
    ['task', TASK_CODE_LABELS, 'code'],
  ]
  for (const [kind, labels, property] of kinds) {
    const value = await highest(labels, property)
    await session.executeWrite((tx) => (value === null
      ? tx.run('MATCH (c:Counter {tenant_id: $tenantId, kind: $kind}) DELETE c', { tenantId, kind })
      // MERGE: tickets that remain without a counter would be numbered again from 1.
      : tx.run('MERGE (c:Counter {tenant_id: $tenantId, kind: $kind}) SET c.value = $value', { tenantId, kind, value: neo4j.int(value) })))
    out.push({ kind, value })
  }
  return out
}

/** What the run changed outside its own nodes, put back as the first run found it. */
async function restoreSettings(session: Session, tenantId: string, first: RunRecord): Promise<void> {
  if (first.limits) {
    const limits = JSON.parse(first.limits) as Record<string, unknown>
    await session.executeWrite((tx) => tx.run(`
      MATCH (t:Tenant {id: $tenantId})
      SET t.max_form_fields = $a, t.max_form_fields_per_form = $b, t.max_form_table_rows = $c`,
    { tenantId, a: limits['max_form_fields'] ?? null, b: limits['max_form_fields_per_form'] ?? null, c: limits['max_form_table_rows'] ?? null }))
  }
  /*
   * D4: the event policy the tenant had (the processes read it again within
   * their cache's 30 s). Only when the run recorded it: a run of an older
   * generator did not, and writing its absence would take the policy away.
   * A property written as null is not stored, so a recorded null never
   * reaches here as «recorded»: the policy then stays as it is.
   */
  if (first.hasEventPolicy && first.eventPolicy) {
    await session.executeWrite((tx) => tx.run('MATCH (t:Tenant {id: $tenantId}) SET t.event_policy = $policy', { tenantId, policy: first.eventPolicy }))
  }
  // D55: the retention, only when the run recorded it (a run of an older generator did not).
  if (first.hasRetention) {
    await session.executeWrite((tx) => tx.run('MATCH (t:Tenant {id: $tenantId}) SET t.inapp_notification_retention_days = $days',
      { tenantId, days: first.retention === null ? null : neo4j.int(first.retention) }))
  }
  // D58: the notification rules as they were (the channels too, when the run recorded them).
  const rules = first.rules ? JSON.parse(first.rules) as Array<{ id: string; target: string; enabled: boolean; channels?: string[] }> : []
  if (rules.length) {
    await session.executeWrite((tx) => tx.run(`
      UNWIND $rules AS rule
      MATCH (r:NotificationRule {id: rule.id, tenant_id: $tenantId})
      SET r.target = rule.target, r.enabled = rule.enabled, r.channels = coalesce(rule.channels, r.channels)`,
    { tenantId, rules: rules.map((r) => ({ ...r, channels: r.channels ?? null })) }))
  }
}

/**
 * D60: the SLA timers waiting in the queue for tickets of this tenant that no
 * longer exist. Read page by page, checked against the graph in one query,
 * removed — a timer of a ticket that is still there is left alone.
 */
async function removeTimersOfDeletedTickets(session: Session, tenantId: string): Promise<number> {
  const queue = getQueue<{ tenantId?: string; entityId?: string }>('sla-jobs')
  const ours: Array<{ id: string; entityId: string }> = []
  // One state at a time: with several, the range applies to each and a page is not a page.
  for (const state of ['delayed', 'waiting', 'prioritized'] as const) {
    for (let start = 0; ; start += 1000) {
      const jobs = await queue.getJobs([state], start, start + 999)
      for (const j of jobs) {
        if (j?.id && j.data?.tenantId === tenantId && j.data.entityId) ours.push({ id: j.id, entityId: j.data.entityId })
      }
      if (jobs.length < 1000) break
    }
  }
  if (ours.length === 0) return 0
  const alive = new Set((await runQuery<{ id: string }>(session, `
    UNWIND $ids AS id
    CALL (id) {
      MATCH (s:SLAStatus {tenant_id: $tenantId, entity_id: id}) RETURN s.entity_id AS found LIMIT 1
    }
    RETURN found AS id`, { tenantId, ids: [...new Set(ours.map((o) => o.entityId))] })).map((r) => r.id))
  let removed = 0
  for (const o of ours.filter((x) => !alive.has(x.entityId))) removed += await queue.remove(o.id)
  return removed
}

/**
 * The marked nodes of the tenant, label by label: a count over a pattern
 * without a label reads every node of the database (D25).
 */
async function countMarked(session: Session, tenantId: string, labels: readonly string[]): Promise<number> {
  if (labels.length === 0) return 0
  const branches = labels.map((l) => `MATCH (n:${l} {tenant_id: $tenantId}) WHERE n.demo_run_id IS NOT NULL RETURN count(n) AS c`)
  const rows = await runQuery<{ n: unknown }>(session, `CALL () { ${branches.join(' UNION ALL ')} } RETURN sum(c) AS n`, { tenantId })
  return Number(rows[0]?.n ?? 0)
}
