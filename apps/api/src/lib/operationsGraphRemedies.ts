/**
 * THE RUNNING OF A TENANT, PART TWO: WHAT IS STUCK IN THE GRAPH (26 Sep 2026).
 *
 * The owner chose the catalogue: retry failed jobs (`operationsRemedies.ts`),
 * re-evaluate stuck alarms, realign a service map, recompute CI health, and
 * «controllare anche workflow rimasti inceppati sui vari processi». These four
 * are here. Each one is a detector, a remedy of the closed catalogue and a
 * verification, and each follows the rules in `operationsRemedies.ts`: a
 * person's yes, one episode a day, verified not undone, never twice without
 * a person.
 *
 * ## Each remedy is a periodic pass that did not work, asked of a person
 * Every one of these conditions already has a pass that repairs it by itself
 * (alarms every 5 minutes, maps every 30, the recompute on every alarm, the
 * timer job at the end of a wait). A detector proposes only what that
 * pass has left behind for longer than it should — the thresholds are in
 * `OPERATIONS_LIMITS` — so a proposal means «the automatic road failed», not
 * «the product is busy».
 *
 * ## The parameters are re-checked, not trusted
 * Between the night a proposal is born and the click, days can pass. Every
 * remedy looks again at which of the named items are STILL stuck and acts on
 * those only; none left is said, not treated as a silent success.
 *
 * ## Workflows: the lost timers only
 * `transition_workflow` is forbidden to proposals for ever: a proposal never
 * chooses where a ticket goes. The workflow remedy carries ticket ids, not
 * steps; it follows only the exit the CUSTOMER drew out of a wait step, once
 * the timer of that wait has expired and its job was lost — with the arc's
 * condition evaluated by the engine and every guard of the transition
 * pipeline. Changes are left out: `riprendiTransizioni.ts` resumes them every
 * minute without asking.
 *
 * NOT every automatic arc (26 Sep 2026, found on the demo tenant before any
 * proposal was accepted). The first version also proposed tickets sitting on
 * a step with an automatic arc and no condition, reading it as «should have
 * fired at once» — true of a change, false elsewhere: the problem's arcs out
 * of `change_requested` have no condition because its CHANGE moves it
 * (back to investigation if rejected, on if started), and the incident's are
 * moved by alarms and services. Fourteen problems waiting for their change
 * were proposed; accepting would have sent them all back to investigation.
 * An automatic arc outside a change is fired by an event, not by time: only
 * a wait is fired by time, so only a wait can be «late».
 */
import type { Session } from 'neo4j-driver'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import { ENTITY_NEO4J_LABELS, WAIT_EXIT_TRIGGERS } from '@opengraphity/types'
import type { ProposalToWrite } from './proposals.js'
import type { EsitoAzione } from './proposalActions.js'
import { ValidationError } from './errors.js'
import { logger } from './logger.js'
import { stuckEventParams, stuckFiringWhereCypher } from '../services/events/stuck.js'
import { CI_HEALTH_SCALE, ciHealthCaseCypher } from '../services/events/ciHealth.js'
import { resolveCILifecycleSemantics } from './ciLifecycle.js'
import { loadDomainMatrix } from './domainMatrix.js'
import { SERVICE_STALE_MISSING_CI, SERVICE_STALE_OVER_LIMIT } from './serviceVocabularies.js'
import { TIMER_WAIT_STEP, waitTimerLost } from './waitSteps.js'
import { OPERATIONS_LIMITS as L, REMEDY_ACTOR, idsParam, operationsProposal, type VerificationOutcome } from './operationsRemedyCommon.js'

const MODULE = 'operations-remedies'

function nothingLeft(what: string): ValidationError {
  return new ValidationError(`none of the ${what} of this proposal is stuck any more`, { key: 'errors.proposal.nothingStuck' })
}

/** When every item failed, the remedy did not run: said, and the proposal stays open with the reason. */
function allFailed(what: string, errors: string[]): Error {
  return new Error(`operations: every ${what} failed (${errors.slice(0, 3).join('; ')})`)
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── 1. Alarms the periodic pass did not pick up ─────────────────────────────

/** The alarms of a tenant still stuck `alarmsBeyondPassMinutes` past the pass's own threshold. */
export async function detectStuckAlarms(tenantId: string, now: Date = new Date()): Promise<ProposalToWrite[]> {
  const params = stuckEventParams(new Date(now.getTime() - L.alarmsBeyondPassMinutes * 60_000).toISOString())
  const session = getSession(undefined, 'READ')
  let row: { n: number; first: Array<{ id: string; title: string | null }> } | null
  try {
    row = await runQueryOne(session, `
      MATCH (e:Event {tenant_id: $tenantId, status: 'firing'})
      WHERE ${stuckFiringWhereCypher()}
      WITH e ORDER BY e.first_seen_at, e.id
      WITH collect({id: e.id, title: e.title}) AS stuck
      RETURN size(stuck) AS n, stuck[..toInteger($max)] AS first
    `, { tenantId, ...params, max: L.batchMax })
  } finally {
    await session.close()
  }
  const n = Number(row?.n ?? 0)
  if (n === 0 || !row) return []
  return [await operationsProposal({
    tenantId, now, cause: 'events:stuck', kind: 'proposal.operationsStuckAlarms',
    params: { count: String(n) }, n,
    refs: row.first.map((e) => ({ entityType: 'event', id: e.id, label: e.title ?? e.id })),
    action: { type: 'events.reevaluate_stuck', params: { eventIds: row.first.map((e) => e.id) } },
  })]
}

async function stillStuckAlarms(tenantId: string, ids: string[], now: string): Promise<string[]> {
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{ id: string }>(session, `
      MATCH (e:Event {tenant_id: $tenantId, status: 'firing'})
      WHERE e.id IN $ids AND (${stuckFiringWhereCypher()})
      RETURN e.id AS id
    `, { tenantId, ids, ...stuckEventParams(now) })
    return rows.map((r) => r.id)
  } finally {
    await session.close()
  }
}

/**
 * `events.reevaluate_stuck`: the named alarms still stuck go through the
 * event pipeline again, as the periodic pass would — now, and one by one, so
 * one that fails does not hold the others.
 */
export async function reevaluateStuckAlarms(tenantId: string, params: Record<string, unknown>): Promise<EsitoAzione> {
  const now = new Date().toISOString()
  const ids = await stillStuckAlarms(tenantId, idsParam(params, 'eventIds'), now)
  if (ids.length === 0) throw nothingLeft('alarms')
  const { runEventPipeline } = await import('../services/events/pipeline.js')
  const errors: string[] = []
  for (const eventId of ids) {
    try {
      await runEventPipeline({ tenantId, eventId, now, mode: 'reevaluate' })
    } catch (err) {
      errors.push(errText(err))
      logger.error({ module: MODULE, tenantId, eventId, err: errText(err) }, 'operations: a stuck alarm failed its re-evaluation')
    }
  }
  if (errors.length === ids.length) throw allFailed('re-evaluation', errors)
  logger.info({ module: MODULE, tenantId, alarms: ids.length, failed: errors.length }, 'operations: stuck alarms re-evaluated')
  return { details: { eventIds: ids, reevaluated: ids.length - errors.length, failed: errors.length }, undoState: null }
}

/** Resolved when none of the re-evaluated alarms is stuck any more (the pass's own predicate, now). */
export async function verifyAlarms(tenantId: string, details: Record<string, unknown>): Promise<VerificationOutcome> {
  const ids = idsParam(details, 'eventIds')
  if (ids.length === 0) throw new Error(`operations: the alarms to verify are missing (${JSON.stringify(details)})`)
  const still = await stillStuckAlarms(tenantId, ids, new Date().toISOString())
  return {
    verification: still.length === 0 ? 'resolved' : 'unresolved',
    detail:       { alarms: ids.length, stillStuck: still.length },
  }
}

// ── 2. Live service maps behind the CMDB ────────────────────────────────────

/**
 * Live maps (`auto_sync`, not paused) that the synchronization left behind:
 * not synchronized for `mapSyncLateMinutes` (two safety passes), or still
 * holding a CI that no longer exists well after the last synchronization.
 * Frozen maps are not proposed: freezing is the admin's choice, and a
 * synchronization would undo it. A map over the node limit is not either: no
 * synchronization can apply it — it asks for a smaller map, a person's work.
 */
export async function detectStaleServiceMaps(tenantId: string, now: Date = new Date()): Promise<ProposalToWrite[]> {
  const lateCutoff = new Date(now.getTime() - L.mapSyncLateMinutes * 60_000).toISOString()
  const missingCutoff = new Date(now.getTime() - L.mapMissingCIMinutes * 60_000).toISOString()
  const session = getSession(undefined, 'READ')
  let rows: Array<{ id: string; name: string | null }>
  try {
    rows = await runQuery(session, `
      MATCH (m:ServiceMap {tenant_id: $tenantId})
      WHERE m.auto_sync = true AND m.status <> 'paused' AND coalesce(m.stale_reason, '') <> $overLimit
        AND (coalesce(m.synced_at, m.created_at, '') < $lateCutoff
             OR (m.stale = true AND m.stale_reason = $missingCI AND coalesce(m.synced_at, '') < $missingCutoff))
      RETURN m.id AS id, m.name AS name
      ORDER BY m.name, m.id
      LIMIT toInteger($max)
    `, { tenantId, lateCutoff, missingCutoff, overLimit: SERVICE_STALE_OVER_LIMIT, missingCI: SERVICE_STALE_MISSING_CI, max: L.mapsMax })
  } finally {
    await session.close()
  }
  const out: ProposalToWrite[] = []
  for (const m of rows) {
    const name = m.name ?? m.id
    out.push(await operationsProposal({
      tenantId, now, cause: `service_map:${m.id}`, kind: 'proposal.operationsStaleServiceMap',
      params: { map: name }, n: 1,
      refs: [{ entityType: 'service_map', id: m.id, label: name }],
      action: { type: 'service_map.sync', params: { mapId: m.id } },
    }))
  }
  return out
}

/**
 * `service_map.sync`: the synchronization an admin runs with «Sync now», on a
 * map that is still live — one frozen or paused since the proposal was born
 * is refused, not synchronized behind the admin's back.
 */
export async function syncServiceMapRemedy(tenantId: string, params: Record<string, unknown>): Promise<EsitoAzione> {
  const mapId = params['mapId']
  if (typeof mapId !== 'string' || mapId === '') throw new Error(`operations: service_map.sync without a map (${JSON.stringify(params)})`)
  const session = getSession(undefined, 'READ')
  let map: { autoSync: boolean | null; status: string | null } | null
  try {
    map = await runQueryOne(session, `
      MATCH (m:ServiceMap {tenant_id: $tenantId, id: $mapId})
      RETURN m.auto_sync AS autoSync, m.status AS status
    `, { tenantId, mapId })
  } finally {
    await session.close()
  }
  if (!map) throw new ValidationError(`service map ${mapId} no longer exists`, { key: 'errors.proposal.mapGone' })
  if (map.autoSync !== true || map.status === 'paused') {
    throw new ValidationError(`service map ${mapId} is frozen or paused: it is not synchronized behind the admin's back`, { key: 'errors.proposal.mapNotLive' })
  }
  const { syncServiceMap } = await import('../services/serviceImpact/sync.js')
  const r = await syncServiceMap(tenantId, mapId, 'manual', REMEDY_ACTOR)
  logger.info({ module: MODULE, tenantId, mapId, added: r.added, removed: r.removed, moved: r.moved, skipped: r.skipped }, 'operations: service map synchronized')
  return { details: { mapId, added: r.added, removed: r.removed, moved: r.moved, skipped: r.skipped }, undoState: null }
}

/** Resolved when the map is synchronized and no longer flagged as behind (a map deleted since has nothing left to fix). */
export async function verifyServiceMap(tenantId: string, details: Record<string, unknown>): Promise<VerificationOutcome> {
  const mapId = details['mapId']
  if (typeof mapId !== 'string') throw new Error(`operations: the map to verify is missing (${JSON.stringify(details)})`)
  const session = getSession(undefined, 'READ')
  try {
    const m = await runQueryOne<{ stale: boolean | null; syncedAt: string | null; reason: string | null }>(session, `
      MATCH (m:ServiceMap {tenant_id: $tenantId, id: $mapId})
      RETURN m.stale AS stale, m.synced_at AS syncedAt, m.stale_reason AS reason
    `, { tenantId, mapId })
    if (!m) return { verification: 'resolved', detail: { gone: 'true' } }
    const ok = m.stale !== true && m.syncedAt !== null
    return { verification: ok ? 'resolved' : 'unresolved', detail: { stale: String(m.stale === true), reason: m.reason ?? '' } }
  } finally {
    await session.close()
  }
}

// ── 3. CI health out of step with the alarms ────────────────────────────────

const HEALTHY = CI_HEALTH_SCALE[0]

/**
 * The CIs whose health is not what their alarms say, with the customer's
 * matrix — the same CASE as `recomputeCIHealth`. Candidates are the CIs with
 * an alarm firing or flapping, plus those still unhealthy (the alarm that made
 * them so may have cleared without the recompute). Out of the question: a
 * health set by hand, a CI in maintenance (the recompute leaves both alone),
 * and a severity the matrix does not know (that is an error of its own,
 * with its own message — not something a recompute fixes).
 */
export const CI_OUT_OF_STEP_CYPHER = `
  CALL {
    MATCH (e:Event {tenant_id: $tenantId})-[:RAISED_ON]->(ci:ConfigurationItem {tenant_id: $tenantId})
    WHERE e.status IN ['firing', 'flapping']
    RETURN DISTINCT ci
    UNION
    MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
    WHERE ci.health IS NOT NULL AND ci.health <> $healthy
    RETURN ci
  }
  WITH ci
  WHERE coalesce(ci.health_source, 'monitoring') = 'monitoring' AND NOT coalesce(ci.status, '') IN $maintenanceStatuses
    AND ($ids IS NULL OR ci.id IN $ids)
    AND ($quietCutoff IS NULL OR ci.last_event_at IS NULL OR ci.last_event_at < $quietCutoff)
  OPTIONAL MATCH (e:Event {tenant_id: $tenantId, status: 'firing'})-[:RAISED_ON]->(ci)
  WITH ci, collect(DISTINCT e.severity) AS severities
  OPTIONAL MATCH (f:Event {tenant_id: $tenantId, status: 'flapping'})-[:RAISED_ON]->(ci)
  WITH ci, severities, count(f) > 0 AS flapping
  WHERE all(s IN severities WHERE $healthBySeverity[s] IS NOT NULL)
  WITH ci, ${ciHealthCaseCypher('severities', 'flapping')} AS derived
  WHERE derived <> coalesce(ci.health, $healthy)
  RETURN ci.id AS id, ci.name AS name
  ORDER BY ci.name, ci.id`

async function ciHealthOutOfStep(tenantId: string, filter: { ids: string[] } | { quietCutoff: string }): Promise<Array<{ id: string; name: string | null }>> {
  const [lifecycle, matrix] = await Promise.all([resolveCILifecycleSemantics(tenantId), loadDomainMatrix(tenantId, 'ci_health')])
  const session = getSession(undefined, 'READ')
  try {
    return await runQuery(session, CI_OUT_OF_STEP_CYPHER, {
      tenantId, healthy: HEALTHY, maintenanceStatuses: [...lifecycle.maintenance], healthBySeverity: matrix.entries,
      ids: 'ids' in filter ? filter.ids : null, quietCutoff: 'quietCutoff' in filter ? filter.quietCutoff : null,
    })
  } finally {
    await session.close()
  }
}

export async function detectCIHealthOutOfStep(tenantId: string, now: Date = new Date()): Promise<ProposalToWrite[]> {
  const rows = await ciHealthOutOfStep(tenantId, { quietCutoff: new Date(now.getTime() - L.ciHealthQuietMinutes * 60_000).toISOString() })
  if (rows.length === 0) return []
  const first = rows.slice(0, L.batchMax)
  return [await operationsProposal({
    tenantId, now, cause: 'ci:health', kind: 'proposal.operationsCIHealthOutOfStep',
    params: { count: String(rows.length) }, n: rows.length,
    refs: first.map((c) => ({ entityType: 'ci', id: c.id, label: c.name ?? c.id })),
    action: { type: 'ci.recompute_health', params: { ciIds: first.map((c) => c.id) } },
  })]
}

/** `ci.recompute_health`: the recompute an alarm would have triggered, for the named CIs still out of step. */
export async function recomputeCIHealthRemedy(tenantId: string, params: Record<string, unknown>): Promise<EsitoAzione> {
  const named = idsParam(params, 'ciIds')
  const ids = named.length ? (await ciHealthOutOfStep(tenantId, { ids: named })).map((r) => r.id) : []
  if (ids.length === 0) throw nothingLeft('CIs')
  const { recomputeCIHealth } = await import('../services/events/ciHealth.js')
  const errors: string[] = []
  for (const ciId of ids) {
    try {
      await recomputeCIHealth(tenantId, ciId, REMEDY_ACTOR)
    } catch (err) {
      errors.push(errText(err))
      logger.error({ module: MODULE, tenantId, ciId, err: errText(err) }, 'operations: a CI health recompute failed')
    }
  }
  if (errors.length === ids.length) throw allFailed('recompute', errors)
  logger.info({ module: MODULE, tenantId, cis: ids.length, failed: errors.length }, 'operations: CI health recomputed')
  return { details: { ciIds: ids, recomputed: ids.length - errors.length, failed: errors.length }, undoState: null }
}

export async function verifyCIHealth(tenantId: string, details: Record<string, unknown>): Promise<VerificationOutcome> {
  const ids = idsParam(details, 'ciIds')
  if (ids.length === 0) throw new Error(`operations: the CIs to verify are missing (${JSON.stringify(details)})`)
  const still = await ciHealthOutOfStep(tenantId, { ids })
  return { verification: still.length === 0 ? 'resolved' : 'unresolved', detail: { cis: ids.length, stillOutOfStep: still.length } }
}

// ── 4. Tickets stuck in a wait whose timer was lost ─────────────────────────

/** The workflows this remedy looks at: every one but the change's, which `riprendiTransizioni.ts` resumes by itself. */
const WORKFLOW_TYPES = Object.keys(ENTITY_NEO4J_LABELS).filter((t) => t !== 'change')

/** Candidates read per pass: the conditions are evaluated one by one, oldest first. */
const MAX_CANDIDATES = 200

interface ArcRow {
  instanceId: string
  entityType: string
  entityId:   string
  label:      string
  props:      Record<string, unknown>
  since:      string | null
  fromStep:   string
  delay:      unknown
  toStep:     string
  condition:  string | null
}

export interface StuckTicket {
  instanceId: string
  entityType: string
  entityId:   string
  label:      string
  fromStep:   string
  toStep:     string
}

/**
 * The tickets still in a wait step whose timer expired `TIMER_GRACE_MINUTES`
 * ago — a wait is never cut short —, with the first exit whose condition
 * holds (the engine evaluates it), in the designer's order.
 */
async function stuckTickets(session: Session, tenantId: string, now: Date, ids?: string[]): Promise<StuckTicket[]> {
  const { workflowEngine } = await import('@opengraphity/workflow')
  const rows = await runQuery<ArcRow>(session, `
    MATCH (entity)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId, status: 'active'})-[:CURRENT_STEP]->(cur:WorkflowStep)
    WHERE wi.entity_type IN $types AND coalesce(entity.deleted, false) = false AND ($ids IS NULL OR wi.id IN $ids)
    MATCH (cur)-[tr:TRANSITIONS_TO]->(next:WorkflowStep)
    WHERE cur.type = $timerWait AND tr.trigger IN $waitExit
    RETURN wi.id AS instanceId, wi.entity_type AS entityType, wi.entity_id AS entityId,
           toString(coalesce(entity.number, entity.code, entity.id)) AS label, properties(entity) AS props,
           wi.updated_at AS since, cur.name AS fromStep, cur.timer_delay_minutes AS delay,
           next.name AS toStep, tr.condition AS condition
    ORDER BY wi.updated_at, wi.id, coalesce(next.step_order, 999), next.name
    LIMIT toInteger($max)
  `, { tenantId, types: WORKFLOW_TYPES, timerWait: TIMER_WAIT_STEP, waitExit: [...WAIT_EXIT_TRIGGERS], ids: ids ?? null, max: MAX_CANDIDATES })
  if (rows.length === 0) return []
  // The ITSM conditions register themselves on the engine when loaded (see changesStuck.ts).
  await import('../workflow/conditions.js')

  const seen = new Set<string>()
  const out: StuckTicket[] = []
  for (const r of rows) {
    if (seen.has(r.instanceId)) continue
    // The one rule for a lost timer (waitSteps.ts): a wait is never cut short.
    if (!waitTimerLost(r.since, r.delay, now)) continue
    if (r.condition) {
      try {
        const holds = await workflowEngine.evaluateCondition(session, r.condition, {
          instanceId: r.instanceId, entityId: r.entityId, entityType: r.entityType, tenantId,
          fromStepName: r.fromStep, toStepName: r.toStep, triggerType: 'automatic', entityData: r.props,
        })
        if (!holds) continue
      } catch {
        // A condition the engine does not know is a misconfigured workflow: the engine refuses the arc and says so.
        continue
      }
    }
    seen.add(r.instanceId)
    out.push({ instanceId: r.instanceId, entityType: r.entityType, entityId: r.entityId, label: r.label, fromStep: r.fromStep, toStep: r.toStep })
  }
  return out
}

export async function detectStuckWorkflows(tenantId: string, now: Date = new Date()): Promise<ProposalToWrite[]> {
  const session = getSession(undefined, 'READ')
  let stuck: StuckTicket[]
  try {
    stuck = await stuckTickets(session, tenantId, now)
  } finally {
    await session.close()
  }
  if (stuck.length === 0) return []
  const first = stuck.slice(0, L.batchMax)
  return [await operationsProposal({
    tenantId, now, cause: 'workflows:stuck', kind: 'proposal.operationsStuckWorkflows',
    params: { count: String(stuck.length) }, n: stuck.length,
    refs: first.map((t) => ({ entityType: t.entityType, id: t.entityId, label: t.label })),
    action: { type: 'workflow.resume_automatic', params: { instanceIds: first.map((t) => t.instanceId) } },
  })]
}

/**
 * `workflow.resume_automatic`: each named ticket still in its expired wait
 * follows the wait's exit through the transition pipeline, with every guard. The target
 * is NOT a parameter: it is read again now, from the customer's workflow.
 */
export async function resumeStuckWorkflows(tenantId: string, params: Record<string, unknown>): Promise<EsitoAzione> {
  const named = idsParam(params, 'instanceIds')
  const session = getSession(undefined, 'WRITE')
  try {
    const stuck = named.length ? await stuckTickets(session, tenantId, new Date(), named) : []
    if (stuck.length === 0) throw nothingLeft('tickets')
    const { transitionTicket } = await import('../services/ticketTransition.js')
    const moves: Array<{ instanceId: string; from: string; to: string; moved: boolean }> = []
    const errors: string[] = []
    for (const t of stuck) {
      try {
        const esito = await transitionTicket(session, {
          tenantId, instanceId: t.instanceId, toStep: t.toStep,
          actor: { kind: 'system', path: 'operations_remedy', userId: REMEDY_ACTOR }, triggerType: 'automatic',
        })
        moves.push({ instanceId: t.instanceId, from: t.fromStep, to: t.toStep, moved: esito.moved })
      } catch (err) {
        errors.push(errText(err))
        logger.error({ module: MODULE, tenantId, ticket: t.label, from: t.fromStep, to: t.toStep, err: errText(err) },
          'operations: resuming a stuck ticket failed, the others go on')
      }
    }
    if (errors.length === stuck.length) throw allFailed('resume', errors)
    const moved = moves.filter((m) => m.moved).length
    logger.info({ module: MODULE, tenantId, tickets: stuck.length, moved, failed: errors.length }, 'operations: stuck workflows resumed')
    return { details: { moves, moved, refused: moves.length - moved, failed: errors.length }, undoState: null }
  } finally {
    await session.close()
  }
}

/**
 * Resolved when none of the tickets is still on the step it was stuck on. A
 * refusal of a guard counts as not resolved: the ticket is still there, and a
 * person has to read the note the pipeline left on it.
 */
export async function verifyWorkflows(tenantId: string, details: Record<string, unknown>): Promise<VerificationOutcome> {
  const moves = Array.isArray(details['moves'])
    ? (details['moves'] as Array<{ instanceId?: unknown; from?: unknown }>).filter((m) => typeof m.instanceId === 'string' && typeof m.from === 'string')
    : []
  if (moves.length === 0) throw new Error(`operations: the tickets to verify are missing (${JSON.stringify(details)})`)
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{ id: string; step: string | null; status: string | null }>(session, `
      MATCH (wi:WorkflowInstance {tenant_id: $tenantId})
      WHERE wi.id IN $ids
      OPTIONAL MATCH (wi)-[:CURRENT_STEP]->(s:WorkflowStep)
      RETURN wi.id AS id, s.name AS step, wi.status AS status
    `, { tenantId, ids: moves.map((m) => m.instanceId as string) })
    const where = new Map(rows.map((r) => [r.id, r]))
    const still = moves.filter((m) => {
      const r = where.get(m.instanceId as string)
      return r !== undefined && r.status === 'active' && r.step === m.from
    }).length
    return { verification: still === 0 ? 'resolved' : 'unresolved', detail: { tickets: moves.length, stillStuck: still } }
  } finally {
    await session.close()
  }
}
