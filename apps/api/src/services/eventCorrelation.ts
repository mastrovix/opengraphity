/**
 * Event Management — ondata 3: dagli allarmi agli incident.
 *
 * `runEventPipeline` è l'unico punto d'ingresso, chiamato da `ingestEvent`
 * (services/eventService.ts) DOPO deduplica e aggancio al CI, e da ogni
 * rivalutazione (mutation `reevaluateEvent`, `linkEventToCI`, fine finestra
 * di una change, job periodico, job ritardato). Ordine fisso:
 *
 *   1. soppressione   — una change "in finestra" (passo `deployment`, oppure
 *                       `scheduled` con una releaseWindow/validationWindow del
 *                       piano di rilascio che contiene l'istante) collegata al
 *                       CI dell'evento o a un CI a monte (DEPENDS_ON, fino a
 *                       `suppress_upstream_hops` salti) silenzia l'evento:
 *                       status `suppressed`, SUPPRESSED_BY, `event.suppressed`.
 *                       Niente salute, niente incident.
 *   2. salute del CI  — `recomputeCIHealth` (eventService), solo se non soppresso.
 *   3. soglia         — `open_incident_from` (`never` o severità sotto soglia →
 *                       `skipped_severity`).
 *   4. orfano         — senza CI l'apertura resta manuale (`skipped_orphan`).
 *   5. ritardo        — `open_delay_seconds` > 0 su un evento mai correlato →
 *                       `delayed` + job sulla coda `events-correlate`.
 *   6. raggruppamento — incident aperto già correlato (per CI o per impronta):
 *                       risolto → riapertura via transizione "Riapri";
 *                       aperto → aggancio (CORRELATED_INTO + commento);
 *                       nessuno → apertura con attore `monitoring`.
 *   7. chiusura       — evento `resolved` con incident correlato: se
 *                       `auto_resolve` e TUTTI gli eventi correlati sono
 *                       risolti → `incidentService.resolveIncident`. Se dal
 *                       passo corrente (es. `new`) non c'è un arco verso
 *                       `resolved`, si cerca nella definizione un cammino di
 *                       passi intermedi percorribili dal monitoraggio (vedi
 *                       findAutoResolvePath) e lo si esegue prima di risolvere.
 *
 * Ondata 4, prima di tutto questo:
 *
 *   0. sfarfallio     — un evento `flapping` non viene correlato (la salute del
 *                       CI vale degraded, vedi recomputeCIHealth). All'ingest, se
 *                       negli ultimi `flap_window_minutes` ci sono ≥ `flap_threshold`
 *                       passaggi firing↔resolved (Event.transitions), l'evento
 *                       ENTRA in `flapping`: `correlation = 'flapping'`,
 *                       `event.flapping` (una volta per episodio), UN commento
 *                       sull'incident già correlato. Lo stabilizza il job
 *                       periodico (`reevaluateFlappingEvents`): dopo
 *                       `flap_stable_minutes` senza passaggi torna allo stato
 *                       dell'ultimo payload, `event.stable`, e ripassa da qui.
 *   0b. tempesta      — services/eventStorm.ts: se la sorgente è in tempesta
 *                       l'evento (firing, dopo la soppressione e la salute) si
 *                       aggancia all'incident di tempesta (`correlation =
 *                       'storm'`, o `'storm_no_ci'` se non esiste ancora) e non
 *                       apre/aggancia incident per CI; un evento resolved in
 *                       tempesta aggiorna solo la salute.
 *
 * Atomicità del raggruppamento (revisione, 1.1): "trova l'incident del gruppo
 * → apri / aggancia / riapri" gira sotto un lock Redis per (tenant, gruppo)
 * — `og:events:group:<tenant>:ci:<ciId>` o `…:fp:<impronta>` (lib/redisLock.ts)
 * — perché il worker `events-ingest` ha concurrency 4 e due allarmi diversi
 * sullo stesso CI arrivano nello stesso batch: senza lock leggevano entrambi
 * "nessun incident" e ne aprivano due. Chi trova il lock occupato attende
 * (fino a GROUP_LOCK_WAIT_MS) che l'incident compaia (e vi si aggancia) o che
 * il lock si liberi e rilegge; oltre l'attesa → errore ritentabile. Anche la
 * chiusura automatica di un rientro gira sotto il lock del suo gruppo
 * (`groupIdOf`): due rientri paralleli o un rientro e un nuovo allarme sullo
 * stesso CI non si intrecciano più sull'incident.
 *
 * Stati ritentabili (1.2): fine soppressione e stabilizzazione NON scrivono
 * uno stato "libero" prima di aver correlato: scrivono `correlation =
 * 'pending'` con `correlation_due_at = now` e correlano nella stessa unità;
 * se la correlazione fallisce l'evento resta firing/pending e la passata
 * periodica `reevaluatePendingEvents` lo riprende (firing con correlation
 * pending/none e scadenza passata).
 *
 * Dieta di rumore (3.3): una ripetizione di un evento GIÀ agganciato allo
 * stesso incident non produce `event.correlated`, audit né commento; la
 * chiusura automatica lascia UN commento con il cammino percorso.
 *
 * Ogni scrittura sull'incident passa da incidentService / workflowEngine (mai
 * Cypher diretto sull'incident) con `userId: 'monitoring'`. Niente fallback
 * silenziosi: policy mancante, workflow senza passo "resolved", transizione di
 * riapertura assente o fallita → errore (il job BullMQ ritenta e resta visibile).
 */
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'
import type { MonitoringEventPayload } from '@opengraphity/types'
import type { GraphQLContext } from '../context.js'
import { NotFoundError, ValidationError } from '../lib/errors.js'
import { publishEvent } from '../lib/publishEvent.js'
import { audit } from '../lib/audit.js'
import { logger } from '../lib/logger.js'
import { getWorkflowSteps } from '../lib/workflowHelpers.js'
import { anyDeployWindowContains } from '../lib/deployWindows.js'
import { withRedisLock, type RedisLockOptions } from '../lib/redisLock.js'
import { runPagedPass, type PagedPassResult } from '../lib/pagedPass.js'
import type { EventPolicy } from '../lib/eventPolicy.js'
import type { CorrelationOutcome } from '../lib/eventVocabularies.js'
import { eventsFlappingTotal, eventsSuppressedTotal, incidentsAutoOpenedTotal, incidentsAutoResolvedTotal, incidentsReopenedTotal } from '../middleware/metrics.js'
import { EVENT_SEVERITIES, countTransitionsSince, getEventPolicy, mapEventPayload, recomputeCIHealth, transitionsOf, type EventSeverity } from './eventService.js'
import { getStormState, trackSourceStorm, replaceClosedStormIncident, stormLockKey, STORM_LOCK_TTL_SECONDS, STORM_LOCK_WAIT_MS, STORM_LOCK_POLL_MS, type StormState } from './eventStorm.js'

const log = logger.child({ module: 'event-correlation' })

// Collaboratori pesanti caricati al momento dell'uso: questo modulo è
// importato da eventService (quindi dal webhook in ingresso e dalla console);
// il motore del workflow, incidentService (trigger, regole, embedding) e la
// coda BullMQ non devono pesare su chi normalizza o elenca gli eventi.
const engine    = async () => (await import('@opengraphity/workflow')).workflowEngine
const incidents = () => import('./incidentService.js')
const queue     = () => import('../jobs/eventCorrelateWorker.js')

type Props = Record<string, unknown>

// ── Costanti del contratto ───────────────────────────────────────────────────

/** actor_id / userId delle azioni automatiche (audit, eventi di dominio, commenti). */
export const MONITORING_ACTOR = 'monitoring'

/**
 * Passi del workflow change (scripts/lib/workflowDefinitions.ts:
 * assessment → approval → scheduled → deployment → review → closed).
 * `deployment` è l'implementazione: silenzia sempre. `scheduled` è la change
 * approvata e pianificata: silenzia solo dentro una finestra del piano.
 */
export const CHANGE_IMPLEMENTATION_STEP = 'deployment'
export const CHANGE_PLANNED_STEPS = ['scheduled'] as const
export const CHANGE_WINDOW_STEPS: readonly string[] = [CHANGE_IMPLEMENTATION_STEP, ...CHANGE_PLANNED_STEPS]

/**
 * Valori di `Event.correlation`. `flapping`, `storm`, `storm_no_ci` sono
 * dell'ondata 4; `pending` = firing in attesa di correlazione (fine
 * soppressione / stabilizzazione non ancora correlate: `correlation_due_at`
 * dice da quando, la passata periodica lo riprende). La lista vive in
 * lib/eventVocabularies.ts (fonte unica anche dell'enum SDL EventCorrelation).
 */
export { CORRELATION_OUTCOMES, type CorrelationOutcome } from '../lib/eventVocabularies.js'
/** Esiti di `event.correlated` (oltre a quelli scritti sull'evento). */
export type PipelineOutcome = CorrelationOutcome | 'auto_resolved' | 'auto_resolve_skipped'

/** Esiti che dicono "agganciato a un incident": una ripetizione con lo stesso esito e la stessa relazione è silenziosa. */
const ATTACHED_OUTCOMES: readonly string[] = ['opened', 'attached', 'reopened']
/** Correlazioni riprese dalla passata periodica `reevaluatePendingEvents` (con `correlation_due_at` scaduta). */
export const PENDING_CORRELATIONS: readonly string[] = ['pending', 'none']

/** Lock Redis del raggruppamento per (tenant, gruppo): TTL > durata massima di "apri incident + transizioni". */
export const GROUP_LOCK_TTL_SECONDS = 30
/** Attesa massima di chi trova il lock del gruppo occupato (poi errore ritentabile). */
export const GROUP_LOCK_WAIT_MS = 5_000
export const GROUP_LOCK_POLL_MS = 100
/** Esportate perché `createIncidentFromEvent` (resolver) si serializza con lo stesso lock della correlazione automatica. */
export const GROUP_LOCK_OPTS: RedisLockOptions = { ttlSeconds: GROUP_LOCK_TTL_SECONDS, waitMs: GROUP_LOCK_WAIT_MS, pollMs: GROUP_LOCK_POLL_MS }
const STORM_LOCK_OPTS: RedisLockOptions = { ttlSeconds: STORM_LOCK_TTL_SECONDS, waitMs: STORM_LOCK_WAIT_MS, pollMs: STORM_LOCK_POLL_MS }

export function groupLockKey(tenantId: string, groupBy: EventPolicy['group_by'], groupId: string): string {
  return `og:events:group:${tenantId}:${groupBy === 'ci' ? 'ci' : 'fp'}:${groupId}`
}

/**
 * Identità del gruppo di un evento secondo la policy: il CI (raggruppamento
 * per CI) oppure l'impronta. Un evento senza CI con raggruppamento per CI
 * (orfano collegato a mano a un incident) usa l'impronta: la stessa regola per
 * l'allarme e per il suo rientro, così apertura, aggancio, riapertura e
 * chiusura automatica dello stesso gruppo si escludono a vicenda.
 */
export function groupIdOf(policy: Pick<EventPolicy, 'group_by'>, ev: Pick<EventRecord, 'ciId' | 'props'>): string {
  const eventId = toStr(ev.props['id'])
  if (policy.group_by === 'ci' && ev.ciId) return ev.ciId
  return toStr(ev.props['fingerprint']) || eventId
}

/** Severity dell'evento → priorità dell'incident (createIncident accetta anche la sola severity). */
export const INCIDENT_SEVERITY_FROM_EVENT: Readonly<Record<EventSeverity, string>> = { critical: 'critical', warning: 'medium', info: 'low' }

const SEVERITY_RANK: Readonly<Record<EventSeverity, number>> = { info: 0, warning: 1, critical: 2 }

/** Contesto sintetico per audit e servizi: l'attore è il monitoraggio. */
export function monitoringContext(tenantId: string): GraphQLContext {
  return { tenantId, userId: MONITORING_ACTOR, userEmail: MONITORING_ACTOR, role: 'admin' }
}

export interface EventSuppressedPayload extends MonitoringEventPayload { change_id: string }
export interface EventCorrelatedPayload extends MonitoringEventPayload { incident_id: string | null; outcome: PipelineOutcome }
/** `event.flapping`: passaggi contati nella finestra e finestra in minuti. */
export interface EventFlappingPayload extends MonitoringEventPayload { transitions: number; window_minutes: number; flapping_since: string; incident_id: string | null }
/** `event.stable`: stato a cui l'evento è tornato e minuti di quiete richiesti. */
export interface EventStablePayload extends MonitoringEventPayload { stable_minutes: number; flapping_since: string | null }

// ── Sfarfallio (helper puri) ─────────────────────────────────────────────────

/** True se nei `flap_window_minutes` prima di `now` ci sono ≥ `flap_threshold` passaggi (soglia o finestra 0 = rilevamento spento). */
export function isFlapping(transitions: readonly string[], policy: Pick<EventPolicy, 'flap_threshold' | 'flap_window_minutes'>, now: string): boolean {
  if (policy.flap_threshold <= 0 || policy.flap_window_minutes <= 0) return false
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) throw new Error(`isFlapping: "${now}" is not an ISO date`)
  return countTransitionsSince(transitions, nowMs - policy.flap_window_minutes * 60_000) >= policy.flap_threshold
}

/** True se l'ultimo passaggio è più vecchio di `flap_stable_minutes` (nessun passaggio registrato → stabile). */
export function isStable(transitions: readonly string[], stableMinutes: number, now: string): boolean {
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) throw new Error(`isStable: "${now}" is not an ISO date`)
  let last = -Infinity
  for (const t of transitions) { const ms = Date.parse(t); if (ms > last) last = ms }
  return last === -Infinity || nowMs - last >= stableMinutes * 60_000
}

// ── Helper puri ──────────────────────────────────────────────────────────────

/** True se la severità raggiunge la soglia `open_incident_from` (`never` → mai). */
export function meetsOpenThreshold(severity: EventSeverity, openFrom: EventPolicy['open_incident_from']): boolean {
  if (openFrom === 'never') return false
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[openFrom]
}

/**
 * Una change è "in finestra" se è in implementazione, oppure pianificata con
 * almeno una finestra (release o validation) del piano che contiene l'istante.
 */
export function changeIsInWindow(step: string, plans: readonly unknown[], atMs: number): boolean {
  if (step === CHANGE_IMPLEMENTATION_STEP) return true
  if ((CHANGE_PLANNED_STEPS as readonly string[]).includes(step)) return anyDeployWindowContains(plans, atMs)
  return false
}

// ── Cammino verso "resolved" per la chiusura automatica ─────────────────────

/** Massimo numero di passi intermedi che il monitoraggio percorre per arrivare a un passo da cui "resolved" è raggiungibile. */
export const AUTO_RESOLVE_MAX_HOPS = 4
/** Trigger percorribili dal monitoraggio (mai `timer` né `sla_breach`). */
export const AUTO_RESOLVE_TRIGGERS: readonly string[] = ['manual', 'automatic']
/**
 * Condizioni d'arco soddisfatte dalle note che il monitoraggio passa a ogni
 * passaggio (la built-in del motore valuta `notes` non vuote; resolveIncident
 * fornisce la causa come notes). Qualunque altra condizione rende l'arco
 * impercorribile: non conosciamo il dominio che la soddisfa.
 */
export const AUTO_RESOLVE_SATISFIABLE_CONDITIONS: readonly string[] = ['rootCause != null']

/** Arco della definizione del workflow (TRANSITIONS_TO) con l'etichetta del passo di arrivo. */
export interface DefinitionTransition {
  fromStep:  string
  toStep:    string
  toLabel:   string | null
  trigger:   string
  condition: string | null
}

/** Passo intermedio da eseguire: arco scelto e trigger con cui percorrerlo. */
export interface AutoResolveHop { toStep: string; toLabel: string | null; trigger: 'manual' | 'automatic' }

function isUsableForAutoResolve(t: DefinitionTransition): boolean {
  return AUTO_RESOLVE_TRIGGERS.includes(t.trigger) && (t.condition == null || AUTO_RESOLVE_SATISFIABLE_CONDITIONS.includes(t.condition))
}

/**
 * Ricerca in ampiezza, nella definizione, del cammino più corto da `fromStep` a
 * un passo da cui `resolvedStep` è raggiungibile con un arco percorribile.
 * Restituisce i passi INTERMEDI da eseguire (l'ultimo arco, verso resolved, lo
 * percorre resolveIncident): `[]` se resolved è già raggiungibile da fromStep,
 * `null` se non esiste un cammino con al più `maxHops` passi intermedi. Solo
 * archi `manual`/`automatic` senza condizione o con condizione soddisfabile
 * dalle note; a parità di arrivo preferisce l'arco manuale; nessun ciclo (ogni
 * passo è visitato una volta sola); `resolvedStep` non è mai un passo intermedio.
 */
export function findAutoResolvePath(transitions: readonly DefinitionTransition[], fromStep: string, resolvedStep: string, maxHops: number = AUTO_RESOLVE_MAX_HOPS): AutoResolveHop[] | null {
  const usable = transitions.filter(isUsableForAutoResolve)
  // Ordine stabile: gli archi manuali prima, così a parità di passo di arrivo vince il manuale.
  usable.sort((a, b) => (a.trigger === b.trigger ? 0 : a.trigger === 'manual' ? -1 : 1))
  const outgoing = new Map<string, DefinitionTransition[]>()
  for (const t of usable) {
    const list = outgoing.get(t.fromStep) ?? []
    list.push(t)
    outgoing.set(t.fromStep, list)
  }

  const visited = new Set<string>([fromStep])
  let frontier: Array<{ step: string; path: AutoResolveHop[] }> = [{ step: fromStep, path: [] }]
  while (frontier.length > 0) {
    const next: typeof frontier = []
    for (const { step, path } of frontier) {
      const edges = outgoing.get(step) ?? []
      if (edges.some((e) => e.toStep === resolvedStep)) return path
      if (path.length >= maxHops) continue
      for (const e of edges) {
        if (e.toStep === resolvedStep || visited.has(e.toStep)) continue
        visited.add(e.toStep)
        next.push({ step: e.toStep, path: [...path, { toStep: e.toStep, toLabel: e.toLabel, trigger: e.trigger as 'manual' | 'automatic' }] })
      }
    }
    frontier = next
  }
  return null
}

function assertSeverity(value: unknown, eventId: string): EventSeverity {
  if (typeof value !== 'string' || !(EVENT_SEVERITIES as readonly string[]).includes(value)) {
    throw new Error(`Event ${eventId} has an invalid severity ${JSON.stringify(value)}`)
  }
  return value as EventSeverity
}

function toStr(v: unknown): string { return v == null ? '' : typeof v === 'string' ? v : String(v) }

/** Conteggi Neo4j (Integer o number) → number; null → 0. Locale per non dipendere dall'export `toNumber` del driver nei mock. */
function toNumber(v: unknown): number {
  if (v == null) return 0
  if (typeof v === 'object' && 'toNumber' in v && typeof (v as { toNumber: unknown }).toNumber === 'function') return (v as { toNumber(): number }).toNumber()
  return Number(v)
}

// ── Caricamento ──────────────────────────────────────────────────────────────

export interface EventRecord { props: Props; ciId: string | null }

async function loadEventRecord(tenantId: string, eventId: string): Promise<EventRecord> {
  const session = getSession()
  try {
    const row = await runQueryOne<EventRecord>(session, `
      MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
      OPTIONAL MATCH (e)-[:RAISED_ON]->(ci:ConfigurationItem {tenant_id: $tenantId})
      RETURN properties(e) AS props, ci.id AS ciId
    `, { eventId, tenantId })
    if (!row) throw new NotFoundError('Event', eventId)
    return row
  } finally { await session.close() }
}

async function setCorrelation(tenantId: string, eventId: string, correlation: CorrelationOutcome, now: string, dueAt: string | null = null): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    await runQuery(session, `
      MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
      SET e.correlation = $correlation, e.correlation_at = $now, e.correlation_due_at = $dueAt, e.updated_at = $now
    `, { eventId, tenantId, correlation, now, dueAt })
  } finally { await session.close() }
}

// ── 1. Soppressione ──────────────────────────────────────────────────────────

export interface SuppressingChange { changeId: string; code: string; step: string }

/**
 * La change (non eliminata) che silenzia il CI: collegata con AFFECTS_CI al CI
 * stesso o a un CI da cui questo dipende entro `hops` salti (0 = solo diretto),
 * con il workflow in un passo "di finestra" (vedi changeIsInWindow). Preferisce
 * la più vicina, poi quella in implementazione.
 */
export async function findSuppressingChange(tenantId: string, ciId: string, hops: number, at: string): Promise<SuppressingChange | null> {
  if (!Number.isInteger(hops) || hops < 0) throw new Error(`suppress_upstream_hops must be an integer >= 0, got ${JSON.stringify(hops)}`)
  const atMs = Date.parse(at)
  if (Number.isNaN(atMs)) throw new Error(`findSuppressingChange: "${at}" is not an ISO date`)
  // hops è un intero validato dalla policy: entra nel pattern di lunghezza variabile, non come parametro.
  const upstream = hops > 0
    ? `OPTIONAL MATCH p = (ci)-[:DEPENDS_ON*1..${hops}]->(up:ConfigurationItem {tenant_id: $tenantId})
       WITH ci, collect(DISTINCT {node: up, dist: length(p)}) AS ups`
    : `WITH ci, [] AS ups`
  const session = getSession()
  try {
    const rows = await runQuery<{ changeId: string; code: string | null; step: string; plans: unknown[] }>(session, `
      MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
      ${upstream}
      UNWIND [{node: ci, dist: 0}] + ups AS t
      WITH t.node AS target, t.dist AS dist
      WHERE target IS NOT NULL
      MATCH (c:Change {tenant_id: $tenantId})-[:AFFECTS_CI]->(target)
      WHERE coalesce(c.deleted, false) = false
      MATCH (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
      WHERE wi.current_step IN $windowSteps
      OPTIONAL MATCH (c)-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask {tenant_id: $tenantId})
      WITH c, wi, min(dist) AS dist, collect(DISTINCT dp.steps) AS plans
      RETURN c.id AS changeId, c.code AS code, wi.current_step AS step, plans
      ORDER BY dist, CASE WHEN wi.current_step = $implementationStep THEN 0 ELSE 1 END, c.created_at
    `, { ciId, tenantId, windowSteps: CHANGE_WINDOW_STEPS, implementationStep: CHANGE_IMPLEMENTATION_STEP })
    for (const r of rows) {
      if (changeIsInWindow(r.step, r.plans ?? [], atMs)) return { changeId: r.changeId, code: r.code ?? r.changeId, step: r.step }
    }
    return null
  } finally { await session.close() }
}

async function applySuppression(tenantId: string, ev: EventRecord, change: SuppressingChange, actorId: string, now: string, mode: PipelineMode): Promise<void> {
  const eventId = toStr(ev.props['id'])
  const alreadyByThisChange = ev.props['status'] === 'suppressed' && ev.props['suppressed_by_change_id'] === change.changeId
  if (alreadyByThisChange) {
    // Già silenziato da questa change: nessun nuovo avviso. `correlation_at`
    // resta "quando è stato silenziato"; `SUPPRESSED_BY.last_seen_at` avanza
    // solo quando lo strumento ha davvero rimandato l'allarme (ingest), non a
    // ogni passata periodica.
    if (mode !== 'ingest') return
    const session = getSession(undefined, 'WRITE')
    try {
      await runQuery(session, `
        MATCH (e:Event {id: $eventId, tenant_id: $tenantId})-[r:SUPPRESSED_BY]->(c:Change {id: $changeId, tenant_id: $tenantId})
        SET r.last_seen_at = $now, e.updated_at = $now
      `, { eventId, tenantId, changeId: change.changeId, now })
    } finally { await session.close() }
    return
  }
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
      MATCH (c:Change {id: $changeId, tenant_id: $tenantId})
      SET e.status = 'suppressed', e.suppressed_by_change_id = $changeId,
          e.correlation = 'suppressed', e.correlation_at = $now, e.correlation_due_at = null, e.updated_at = $now
      MERGE (e)-[r:SUPPRESSED_BY]->(c)
      ON CREATE SET r.created_at = $now
      SET r.last_seen_at = $now
      RETURN e.id AS id
    `, { eventId, tenantId, changeId: change.changeId, now })
    if (!row) throw new Error(`Event ${eventId} or Change ${change.changeId} vanished while suppressing (tenant ${tenantId})`)
  } finally { await session.close() }

  eventsSuppressedTotal.inc({})
  const payload: EventSuppressedPayload = { ...mapEventPayload({ ...ev.props, status: 'suppressed' }, ev.ciId), change_id: change.changeId }
  await publishEvent('event.suppressed', tenantId, actorId, payload, now)
  void audit(monitoringContext(tenantId), 'event.suppressed', 'Event', eventId, { changeId: change.changeId, changeCode: change.code, changeStep: change.step, ciId: ev.ciId })
  log.info({ tenantId, eventId, changeId: change.changeId, step: change.step, ciId: ev.ciId }, 'Event suppressed by change window')
}

/**
 * Fine soppressione: torna firing, via il puntatore alla change; SUPPRESSED_BY
 * resta per la storia. `correlation = 'pending'` + `correlation_due_at = now`:
 * se la correlazione che segue fallisce, la passata periodica lo riprende.
 */
async function liftSuppression(tenantId: string, eventId: string, now: string): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    await runQuery(session, `
      MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
      SET e.status = 'firing', e.suppressed_by_change_id = null,
          e.correlation = 'pending', e.correlation_at = $now, e.correlation_due_at = $now, e.updated_at = $now
    `, { eventId, tenantId, now })
  } finally { await session.close() }
}

// ── Workflow dell'incident ───────────────────────────────────────────────────

interface IncidentStepInfo { resolvedStep: string; terminalSteps: string[] }

async function incidentStepInfo(session: Session, tenantId: string): Promise<IncidentStepInfo> {
  const steps = await getWorkflowSteps(session, tenantId, 'incident')
  const resolved = steps.find((s) => s.category === 'resolved') ?? steps.find((s) => s.name === 'resolved')
  if (!resolved) throw new Error(`Tenant ${tenantId}: incident workflow has no step with category "resolved"`)
  return { resolvedStep: resolved.name, terminalSteps: steps.filter((s) => s.isTerminal).map((s) => s.name) }
}

/** MERGE CORRELATED_INTO; true se la relazione è nuova (per non ripetere il commento a ogni ricorrenza). */
async function attachEventToIncident(tenantId: string, eventId: string, incidentId: string, manual: boolean, now: string): Promise<boolean> {
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ created: boolean }>(session, `
      MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
      MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})
      MERGE (e)-[r:CORRELATED_INTO]->(i)
      ON CREATE SET r.created_at = $now, r.manual = $manual
      RETURN r.created_at = $now AS created
    `, { eventId, tenantId, incidentId, manual, now })
    if (!row) throw new Error(`Event ${eventId} or Incident ${incidentId} not found while correlating (tenant ${tenantId})`)
    return Boolean(row.created)
  } finally { await session.close() }
}

// ── Apertura (condivisa con la mutation manuale createIncidentFromEvent) ─────

export interface OpenIncidentArgs {
  tenantId: string
  props:    Props
  ciId:     string | null
  actorId:  string
  /** true dalla mutation manuale, false dalla correlazione automatica. */
  manual:   boolean
  now?:     string
}

/**
 * Crea l'incident dall'evento (priorità e impatto/urgenza dalla severity_map
 * della policy, il CI come impattato), lo collega con CORRELATED_INTO e
 * scrive `correlation = 'opened'`. Un evento orfano è rifiutato: un incident
 * deve avere almeno un CI impattato.
 */
export async function openIncidentFromEvent(args: OpenIncidentArgs) {
  const { tenantId, props, ciId, actorId, manual } = args
  const now = args.now ?? new Date().toISOString()
  const eventId = toStr(props['id'])
  if (!ciId) {
    throw new ValidationError('Evento orfano: collega prima un CI (linkEventToCI) — un incident deve avere almeno un CI impattato')
  }
  const severity = assertSeverity(props['severity'], eventId)
  const policy = await getEventPolicy(tenantId)
  const iu = policy.severity_map[severity]

  const description = [
    `Evento di monitoraggio: ${toStr(props['title'])}`,
    `Risorsa: ${toStr(props['resource'])} (${toStr(props['resource_kind'])})`,
    `Severità: ${severity}`,
    `Occorrenze: ${toNumber(props['count'])} (prima: ${toStr(props['first_seen_at'])}, ultima: ${toStr(props['last_seen_at'])})`,
    props['description'] ? `\n${toStr(props['description'])}` : '',
  ].filter(Boolean).join('\n')

  const incident = await (await incidents()).createIncident({
    title:         toStr(props['title']),
    description,
    severity:      INCIDENT_SEVERITY_FROM_EVENT[severity],
    impact:        iu.impact,
    urgency:       iu.urgency,
    affectedCIIds: [ciId],
  }, { tenantId, userId: actorId })

  await attachEventToIncident(tenantId, eventId, incident.id, manual, now)
  await setCorrelation(tenantId, eventId, 'opened', now)
  if (!manual) incidentsAutoOpenedTotal.inc({})
  return incident
}

// ── 0. Sfarfallio ────────────────────────────────────────────────────────────

/** Incident non terminale a cui l'evento è già correlato (per il commento di sfarfallio). */
async function findLinkedOpenIncident(session: Session, tenantId: string, eventId: string, info: IncidentStepInfo): Promise<string | null> {
  const row = await runQueryOne<{ incidentId: string }>(session, `
    MATCH (e:Event {id: $eventId, tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId})
    MATCH (i)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
    WHERE NOT wi.current_step IN $terminalSteps
    RETURN i.id AS incidentId, i.created_at AS createdAt
    ORDER BY createdAt DESC LIMIT 1
  `, { eventId, tenantId, terminalSteps: info.terminalSteps })
  return row?.incidentId ?? null
}

/**
 * L'evento entra in sfarfallio: status `flapping`, `flapping_since`,
 * `correlation = 'flapping'`; la salute del CI viene ricalcolata (vale
 * degraded); un commento sull'incident già correlato, `event.flapping`. Nessun
 * incident viene aperto né chiuso finché sfarfalla.
 */
async function enterFlapping(tenantId: string, ev: EventRecord, policy: EventPolicy, actorId: string, now: string): Promise<PipelineResult> {
  const eventId = toStr(ev.props['id'])
  const transitions = countTransitionsSince(transitionsOf(ev.props), Date.parse(now) - policy.flap_window_minutes * 60_000)
  const session = getSession(undefined, 'WRITE')
  let incidentId: string | null
  try {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
      SET e.status = 'flapping', e.flapping_since = $now, e.suppressed_by_change_id = null,
          e.correlation = 'flapping', e.correlation_at = $now, e.correlation_due_at = null, e.updated_at = $now
      RETURN e.id AS id
    `, { eventId, tenantId, now })
    if (!row) throw new Error(`Event ${eventId} vanished while entering flapping (tenant ${tenantId})`)
    incidentId = await findLinkedOpenIncident(session, tenantId, eventId, await incidentStepInfo(session, tenantId))
  } finally { await session.close() }

  if (ev.ciId) await recomputeCIHealth(tenantId, ev.ciId, actorId)
  if (incidentId) {
    await (await incidents()).addIncidentComment(incidentId, { tenantId, userId: MONITORING_ACTOR },
      `Allarme instabile: ${transitions} passaggi in ${policy.flap_window_minutes} minuti, correlazione sospesa`)
  }
  eventsFlappingTotal.inc({})
  const payload: EventFlappingPayload = { ...mapEventPayload({ ...ev.props, status: 'flapping' }, ev.ciId), transitions, window_minutes: policy.flap_window_minutes, flapping_since: now, incident_id: incidentId }
  await publishEvent('event.flapping', tenantId, actorId, payload, now)
  void audit(monitoringContext(tenantId), 'event.flapping', 'Event', eventId, { transitions, windowMinutes: policy.flap_window_minutes, ciId: ev.ciId, incidentId })
  log.info({ tenantId, eventId, transitions, windowMinutes: policy.flap_window_minutes, ciId: ev.ciId, incidentId }, 'Event is flapping: correlation suspended')
  return { outcome: 'flapping', status: 'flapping', suppressedByChangeId: null, incidentId }
}

/**
 * Job periodico: ogni evento `flapping` (di ogni tenant) senza passaggi da
 * `flap_stable_minutes` torna allo stato dell'ultimo payload, pubblica
 * `event.stable` e ripassa dalla pipeline (`reevaluate`: correlazione se
 * firing, chiusura automatica se resolved). Paginato (lib/pagedPass.ts); un
 * errore su un evento non ferma gli altri ma fa fallire il job.
 */
export async function reevaluateFlappingEvents(now: string = new Date().toISOString()): Promise<PagedPassResult & { stabilized: number }> {
  const policies = new Map<string, EventPolicy>()
  let stabilized = 0
  const result = await runPagedPass<EventRef>({
    // tenant-ok: passata di manutenzione su tutti i tenant; ogni evento è poi trattato nel suo tenant.
    fetchPage: (cursor, limit) => fetchEventPage(`MATCH (e:Event {status: 'flapping'})\n      WHERE e.id > $cursor`, {}, cursor, limit),
    keyOf: (r) => r.id,
    handle: async (r) => {
      let policy = policies.get(r.tenantId)
      if (!policy) { policy = await getEventPolicy(r.tenantId); policies.set(r.tenantId, policy) }
      const ev = await loadEventRecord(r.tenantId, r.id)
      if (!isStable(transitionsOf(ev.props), policy.flap_stable_minutes, now)) return
      await stabilizeEvent(r.tenantId, ev, policy, now)
      stabilized++
    },
    onError: (r, err) => log.error({ err, tenantId: r.tenantId, eventId: r.id }, 'Flapping event stabilisation failed'),
  })
  if (result.truncated) log.warn({ evaluated: result.evaluated }, 'reevaluateFlappingEvents: page cap reached, remaining flapping events are checked on the next pass')
  if (result.failed > 0) throw new Error(`reevaluateFlappingEvents: ${result.failed}/${result.evaluated} flapping events failed stabilisation (see logs)`)
  return { ...result, stabilized }
}

/**
 * Torna allo stato dell'ultimo payload. Se è `firing` l'evento resta
 * `pending` (con `correlation_due_at = now`) finché la pipeline che segue non
 * lo correla: se questa fallisce lo riprende `reevaluatePendingEvents`.
 */
async function stabilizeEvent(tenantId: string, ev: EventRecord, policy: EventPolicy, now: string): Promise<void> {
  const eventId = toStr(ev.props['id'])
  const last = ev.props['last_payload_status']
  if (last !== 'firing' && last !== 'resolved') throw new Error(`Event ${eventId} is flapping but has no last_payload_status (${JSON.stringify(last)})`)
  const flappingSince = typeof ev.props['flapping_since'] === 'string' ? ev.props['flapping_since'] : null
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
      SET e.status = $status, e.flapping_since = null, e.correlation = $correlation, e.correlation_at = $now, e.correlation_due_at = $dueAt, e.updated_at = $now
      RETURN e.id AS id
    `, { eventId, tenantId, status: last, now, correlation: last === 'firing' ? 'pending' : 'none', dueAt: last === 'firing' ? now : null })
    if (!row) throw new Error(`Event ${eventId} vanished while stabilising (tenant ${tenantId})`)
  } finally { await session.close() }

  const payload: EventStablePayload = { ...mapEventPayload({ ...ev.props, status: last }, ev.ciId), stable_minutes: policy.flap_stable_minutes, flapping_since: flappingSince }
  await publishEvent('event.stable', tenantId, MONITORING_ACTOR, payload, now)
  void audit(monitoringContext(tenantId), 'event.stable', 'Event', eventId, { status: last, flappingSince, stableMinutes: policy.flap_stable_minutes })
  const result = await runEventPipeline({ tenantId, eventId, now, mode: 'reevaluate' })
  log.info({ tenantId, eventId, status: last, flappingSince, outcome: result.outcome }, 'Flapping event stabilised and re-evaluated')
}

// ── 6. Raggruppamento ────────────────────────────────────────────────────────

interface OpenIncidentRow { incidentId: string; instanceId: string; step: string }

/**
 * Incident non terminale già correlato con eventi dello stesso gruppo:
 * `ci` → stesso CI (RAISED_ON); `fingerprint` → questo stesso evento (la
 * deduplica per impronta fa sì che "stessa impronta" = stesso nodo Event).
 * Gli incident di tempesta (`storm_source_id`) non sono "l'incident del CI":
 * finita la tempesta un nuovo allarme apre/riapre l'incident del suo gruppo.
 */
async function findOpenIncidentForGroup(session: Session, tenantId: string, eventId: string, groupBy: EventPolicy['group_by'], info: IncidentStepInfo): Promise<OpenIncidentRow | null> {
  const match = groupBy === 'ci'
    ? `MATCH (e:Event {id: $eventId, tenant_id: $tenantId})-[:RAISED_ON]->(ci:ConfigurationItem {tenant_id: $tenantId})
       MATCH (other:Event {tenant_id: $tenantId})-[:RAISED_ON]->(ci)
       MATCH (other)-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId})`
    : `MATCH (e:Event {id: $eventId, tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId})`
  // Nelle definizioni reali il passo "resolved" è marcato terminale (chiude gli
  // orologi SLA), ma per il monitoraggio non lo è: un incident risolto va
  // RIAPERTO se l'allarme torna, non affiancato da un secondo incident. Quindi
  // si escludono i passi terminali tranne "resolved". Solo "closed" è definitivo.
  return runQueryOne<OpenIncidentRow>(session, `
    ${match}
    WHERE i.storm_source_id IS NULL
    MATCH (i)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
    WHERE NOT wi.current_step IN $terminalSteps OR wi.current_step = $resolvedStep
    RETURN DISTINCT i.id AS incidentId, wi.id AS instanceId, wi.current_step AS step, i.created_at AS createdAt
    ORDER BY createdAt DESC LIMIT 1
  `, { eventId, tenantId, terminalSteps: info.terminalSteps, resolvedStep: info.resolvedStep })
}

/** Passo corrente dell'incident (qualunque sia): null se l'incident non esiste. */
async function incidentStep(session: Session, tenantId: string, incidentId: string): Promise<OpenIncidentRow | null> {
  return runQueryOne<OpenIncidentRow>(session, `
    MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId})-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
    RETURN i.id AS incidentId, wi.id AS instanceId, wi.current_step AS step
  `, { incidentId, tenantId })
}

/**
 * Esegue UNA transizione del workflow dell'incident per conto del monitoraggio
 * replicando i side effect della mutation manuale: transizione via motore,
 * commento in timeline (se `comment`: i passi intermedi della chiusura
 * automatica lasciano un solo commento riassuntivo alla fine), evento
 * `incident.<step>`. Transizione rifiutata dal motore → errore (nessun
 * fallback: il job ritenta e resta visibile). Le enter/exit action del passo
 * (es. orologi SLA) girano come per un utente; un loro errore è già
 * persistito dal motore e viene loggato, non nascosto.
 */
async function runMonitoringTransition(session: Session, tenantId: string, incidentId: string, instanceId: string, toStep: string, triggerType: 'manual' | 'automatic', notes: string, what: string, comment = true): Promise<void> {
  const res = await (await engine()).transition(
    session,
    { instanceId, toStepName: toStep, triggeredBy: MONITORING_ACTOR, triggerType, notes, tenantId },
    { userId: MONITORING_ACTOR, notes, entityData: {} },
  )
  if (!res.success) throw new Error(`Incident ${incidentId}: ${what} transition to "${toStep}" failed: ${res.error ?? 'unknown error'}`)
  if (res.actionErrors?.length) log.error({ tenantId, incidentId, toStep, actionErrors: res.actionErrors }, `Incident moved to "${toStep}" by monitoring but step actions failed`)
  const ctx = { tenantId, userId: MONITORING_ACTOR }
  const incidentService = await incidents()
  if (comment) await incidentService.addIncidentComment(incidentId, ctx, `Workflow: ${toStep} — ${notes}`)
  await incidentService.publishIncidentTransition(incidentId, toStep, ctx)
}

/**
 * Riapre un incident risolto con la transizione manuale "Riapri" (seed:
 * tr-resolved-inprogress, `inputField: notes`) tramite il motore del workflow,
 * come fa la mutation manuale. Nessuna transizione di riapertura → errore.
 */
async function reopenIncident(session: Session, tenantId: string, inc: OpenIncidentRow, info: IncidentStepInfo, notes: string): Promise<string> {
  const transitions = await (await engine()).getAvailableTransitions(session, inc.instanceId, tenantId)
  const target = transitions.find((t) => t.toStep === 'in_progress')
    ?? transitions.find((t) => t.toStep !== info.resolvedStep && !info.terminalSteps.includes(t.toStep))
  if (!target) throw new Error(`Incident ${inc.incidentId}: no manual transition out of "${inc.step}" to reopen it`)
  await runMonitoringTransition(session, tenantId, inc.incidentId, inc.instanceId, target.toStep, 'manual', notes, 'reopen')
  return target.toStep
}

/** Tutti gli archi della definizione a cui appartiene l'istanza (non solo quelli dal passo corrente). */
async function loadDefinitionTransitions(session: Session, instanceId: string, tenantId: string): Promise<DefinitionTransition[]> {
  return runQuery<DefinitionTransition>(session, `
    MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})
    MATCH (wd:WorkflowDefinition {id: wi.definition_id, tenant_id: $tenantId})-[:HAS_STEP]->(from:WorkflowStep)
    MATCH (from)-[tr:TRANSITIONS_TO]->(to:WorkflowStep)
    RETURN from.name AS fromStep, to.name AS toStep, to.label AS toLabel, tr.trigger AS trigger, tr.condition AS condition
  `, { instanceId, tenantId })
}

async function correlateFiringEvent(tenantId: string, ev: EventRecord, policy: EventPolicy, actorId: string, now: string, mode: PipelineMode): Promise<PipelineResult> {
  const eventId = toStr(ev.props['id'])
  const done = (outcome: CorrelationOutcome, incidentId: string | null = null): PipelineResult =>
    ({ outcome, status: 'firing', suppressedByChangeId: null, incidentId })

  // 3. soglia (la salute è già stata aggiornata)
  const severity = assertSeverity(ev.props['severity'], eventId)
  if (!meetsOpenThreshold(severity, policy.open_incident_from)) {
    await setCorrelation(tenantId, eventId, 'skipped_severity', now)
    return done('skipped_severity')
  }
  // 4. orfano: l'apertura resta manuale
  if (!ev.ciId) {
    await setCorrelation(tenantId, eventId, 'skipped_orphan', now)
    return done('skipped_orphan')
  }

  const session = getSession(undefined, 'WRITE')
  try {
    const info = await incidentStepInfo(session, tenantId)

    // 5. ritardo: solo all'ingest e solo per un evento mai correlato a un incident
    if (mode === 'ingest' && policy.open_delay_seconds > 0) {
      const ever = await runQueryOne<{ n: unknown }>(session, `
        MATCH (e:Event {id: $eventId, tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId})
        RETURN count(i) AS n
      `, { eventId, tenantId })
      if (toNumber(ever?.n) === 0) {
        const nowMs = Date.parse(now)
        const pendingDue = ev.props['correlation'] === 'delayed' && typeof ev.props['correlation_due_at'] === 'string' && Date.parse(ev.props['correlation_due_at']) > nowMs
          ? ev.props['correlation_due_at']
          : null
        const dueAt = pendingDue ?? new Date(nowMs + policy.open_delay_seconds * 1000).toISOString()
        await setCorrelation(tenantId, eventId, 'delayed', now, dueAt)
        await (await queue()).enqueueCorrelation(tenantId, eventId, dueAt)
        return done('delayed')
      }
    }

    // 6. raggruppamento, sotto lock per (tenant, gruppo): mai due incident per lo stesso gruppo.
    const lockKey = groupLockKey(tenantId, policy.group_by, groupIdOf(policy, ev))
    const findOpen = () => findOpenIncidentForGroup(session, tenantId, eventId, policy.group_by, info)

    interface Grouped { outcome: CorrelationOutcome; incidentId: string; created: boolean }
    const joinIncident = async (open: OpenIncidentRow): Promise<Grouped> => {
      if (open.step === info.resolvedStep) {
        await reopenIncident(session, tenantId, open, info, `Allarme tornato: ${toStr(ev.props['title'])} (${toStr(ev.props['resource'])})`)
        const created = await attachEventToIncident(tenantId, eventId, open.incidentId, false, now)
        incidentsReopenedTotal.inc({})
        return { outcome: 'reopened', incidentId: open.incidentId, created }
      }
      const created = await attachEventToIncident(tenantId, eventId, open.incidentId, false, now)
      if (created) {
        await (await incidents()).addIncidentComment(open.incidentId, { tenantId, userId: MONITORING_ACTOR },
          `Allarme correlato: ${toStr(ev.props['title'])}, ${severity}, ricorrenze ${toNumber(ev.props['count'])}`)
      }
      return { outcome: 'attached', incidentId: open.incidentId, created }
    }

    const grouped = await withRedisLock<Grouped>(lockKey, GROUP_LOCK_OPTS,
      async () => {
        const open = await findOpen()
        if (open) return joinIncident(open)
        const incident = await openIncidentFromEvent({ tenantId, props: ev.props, ciId: ev.ciId, actorId: MONITORING_ACTOR, manual: false, now })
        return { outcome: 'opened', incidentId: incident.id, created: true }
      },
      async () => {
        // Lock occupato: se l'incident del gruppo è comparso (e non va riaperto)
        // ci si aggancia senza entrare — il MERGE è idempotente.
        const open = await findOpen()
        return open && open.step !== info.resolvedStep ? joinIncident(open) : null
      },
      `no open incident appeared for event ${eventId}`,
    )
    const { outcome, incidentId } = grouped

    // Ripetizione di un allarme già agganciato a questo incident: nessun
    // nuovo esito, avviso, audit o commento (Alertmanager/Zabbix rimandano
    // ogni pochi minuti). L'esito scritto resta quello di quando è cambiato.
    if (outcome === 'attached' && !grouped.created && ATTACHED_OUTCOMES.includes(toStr(ev.props['correlation']))) {
      log.debug({ tenantId, eventId, incidentId }, 'Repeated event already correlated: nothing to publish')
      return done(outcome, incidentId)
    }
    if (outcome !== 'opened') await setCorrelation(tenantId, eventId, outcome, now)   // opened: già scritto da openIncidentFromEvent

    const payload: EventCorrelatedPayload = { ...mapEventPayload({ ...ev.props, status: 'firing' }, ev.ciId), incident_id: incidentId, outcome }
    await publishEvent('event.correlated', tenantId, actorId, payload, now)
    void audit(monitoringContext(tenantId), `event.${outcome}`, 'Event', eventId, { incidentId, groupBy: policy.group_by })
    log.info({ tenantId, eventId, incidentId, outcome }, 'Event correlated')
    return done(outcome, incidentId)
  } finally { await session.close() }
}

// ── 6b. Tempesta ─────────────────────────────────────────────────────────────

/**
 * Sorgente in tempesta: l'evento firing si aggancia all'incident di tempesta
 * (`storm`), senza commento per evento e senza avviso (l'avviso è
 * event.storm_started, uno per sorgente); se l'incident non esiste ancora
 * (solo eventi orfani finora) resta `storm_no_ci`. Mai apertura/aggancio per CI.
 *
 * Lo stato dell'incident di tempesta è controllato: `resolved` → riapertura
 * con la transizione "Riapri" (sotto il lock della sorgente, come per il
 * raggruppamento); passo terminale (chiuso) → nuovo incident di tempesta
 * (eventStorm.replaceClosedStormIncident); tempesta finita nel frattempo →
 * correlazione normale. Mai un allarme "assorbito" da un ticket chiuso.
 */
async function correlateIntoStorm(tenantId: string, ev: EventRecord, policy: EventPolicy, storm: StormState, actorId: string, now: string, mode: PipelineMode): Promise<PipelineResult> {
  const eventId = toStr(ev.props['id'])
  const sourceId = toStr(ev.props['source_id'])
  const noCi = async (): Promise<PipelineResult> => {
    if (ev.props['correlation'] !== 'storm_no_ci') await setCorrelation(tenantId, eventId, 'storm_no_ci', now)
    return { outcome: 'storm_no_ci', status: 'firing', suppressedByChangeId: null, incidentId: null }
  }
  if (!storm.incidentId) return noCi()

  let incidentId: string = storm.incidentId
  let sourceName = storm.sourceName
  const session = getSession(undefined, 'WRITE')
  try {
    const info = await incidentStepInfo(session, tenantId)
    const inc = await incidentStep(session, tenantId, incidentId)
    if (!inc) throw new Error(`Storm incident ${storm.incidentId} of source ${sourceId} not found (tenant ${tenantId})`)
    if (inc.step === info.resolvedStep) {
      await withRedisLock(stormLockKey(tenantId, sourceId), STORM_LOCK_OPTS, async () => {
        const fresh = await incidentStep(session, tenantId, inc.incidentId)
        if (fresh?.step === info.resolvedStep) {
          await reopenIncident(session, tenantId, fresh, info, `Tempesta ancora in corso dalla sorgente "${storm.sourceName}": allarme tornato (${toStr(ev.props['title'])})`)
          incidentsReopenedTotal.inc({})
        }
      })
    } else if (info.terminalSteps.includes(inc.step)) {
      const target = await replaceClosedStormIncident(tenantId, sourceId, inc.incidentId, ev.ciId, actorId, now)
      if (!target.active) return correlateFiringEvent(tenantId, ev, policy, actorId, now, mode)
      if (!target.incidentId) return noCi()
      incidentId = target.incidentId
      sourceName = target.sourceName
    }
  } finally { await session.close() }

  const created = await attachEventToIncident(tenantId, eventId, incidentId, false, now)
  if (created || ev.props['correlation'] !== 'storm') await setCorrelation(tenantId, eventId, 'storm', now)
  log.debug({ tenantId, eventId, incidentId, sourceName }, 'Event attached to storm incident')
  return { outcome: 'storm', status: 'firing', suppressedByChangeId: null, incidentId }
}

// ── 7. Chiusura automatica ───────────────────────────────────────────────────

async function handleResolvedEvent(tenantId: string, ev: EventRecord, actorId: string, now: string, mode: PipelineMode, storm: StormState): Promise<PipelineResult> {
  const eventId = toStr(ev.props['id'])
  const done = (outcome: PipelineOutcome, incidentId: string | null = null): PipelineResult =>
    ({ outcome, status: 'resolved', suppressedByChangeId: null, incidentId })

  if (mode === 'resume') {
    // Risolto durante l'attesa: nessuna correlazione. Salute e chiusura sono
    // già state valutate all'ingest del payload resolved.
    if (ev.props['correlation'] === 'delayed') await setCorrelation(tenantId, eventId, 'none', now)
    return done('none')
  }
  if (ev.ciId) await recomputeCIHealth(tenantId, ev.ciId, actorId)
  // In tempesta solo la salute: l'incident di tempesta si chiude a mano o
  // automaticamente quando, finita la tempesta, l'ultimo allarme rientra.
  if (storm.active) return done('storm', storm.incidentId)

  // La chiusura automatica gira sotto lo STESSO lock del raggruppamento
  // (tenant, gruppo): "leggi incident e allarmi ancora accesi → percorri i passi
  // → risolvi" non deve intrecciarsi né con un altro rientro dello stesso
  // gruppo (due payload resolved in parallelo: entrambi leggevano "nessun altro
  // acceso" e il secondo falliva con "transizione concorrente" sul primo passo)
  // né con un allarme che nel frattempo apre/riapre/aggancia. Nessuna
  // scorciatoia: chi trova il lock occupato attende e poi rilegge.
  const policy = await getEventPolicy(tenantId)
  const lockKey = groupLockKey(tenantId, policy.group_by, groupIdOf(policy, ev))
  return withRedisLock<PipelineResult>(lockKey, GROUP_LOCK_OPTS, () => resolveAgainstIncident(tenantId, ev, policy, actorId, now, done),
    undefined, `auto-resolve of event ${eventId} could not start`)
}

async function resolveAgainstIncident(tenantId: string, ev: EventRecord, policy: EventPolicy, actorId: string, now: string,
  done: (outcome: PipelineOutcome, incidentId?: string | null) => PipelineResult): Promise<PipelineResult> {
  const eventId = toStr(ev.props['id'])
  const session = getSession(undefined, 'WRITE')
  try {
    const info = await incidentStepInfo(session, tenantId)
    const linked = await runQueryOne<{ incidentId: string; instanceId: string; step: string; stillFiring: unknown }>(session, `
      MATCH (e:Event {id: $eventId, tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId})
      MATCH (i)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
      WHERE NOT wi.current_step IN $terminalSteps
      OPTIONAL MATCH (other:Event {tenant_id: $tenantId})-[:CORRELATED_INTO]->(i)
        WHERE other.status <> 'resolved'
      WITH i, wi, count(DISTINCT other) AS stillFiring
      RETURN i.id AS incidentId, wi.id AS instanceId, wi.current_step AS step, stillFiring, i.created_at AS createdAt
      ORDER BY createdAt DESC LIMIT 1
    `, { eventId, tenantId, terminalSteps: info.terminalSteps })
    if (!linked) return done('none')

    if (!policy.auto_resolve) return done('none', linked.incidentId)
    if (toNumber(linked.stillFiring) > 0) return done('none', linked.incidentId)
    if (linked.step === info.resolvedStep) return done('none', linked.incidentId)

    const ctx = { tenantId, userId: MONITORING_ACTOR }
    const title = toStr(ev.props['title'])
    const transitions = await (await engine()).getAvailableTransitions(session, linked.instanceId, tenantId)
    const incidentService = await incidents()

    // Cammino verso resolved: [] se "Risolvi" è già disponibile dal passo
    // corrente; altrimenti (es. incident nato in "new" dal monitoraggio) i passi
    // intermedi percorribili trovati nella definizione; null se non esistono.
    const path = transitions.some((t) => t.toStep === info.resolvedStep)
      ? []
      : findAutoResolvePath(await loadDefinitionTransitions(session, linked.instanceId, tenantId), linked.step, info.resolvedStep)

    let outcome: PipelineOutcome
    if (path) {
      // Ogni passo intermedio è una transizione vera (storia del workflow,
      // evento incident.<step>, senza commento: un solo commento riassuntivo
      // alla fine): le sue enter/exit action possono avviare o fermare gli
      // orologi SLA (seed: assigned avvia il response, in_progress lo ferma e
      // avvia il resolve) — è accettato, l'incident risulta preso in carico e
      // risolto dal monitoraggio. Un passo rifiutato → errore: i passi già
      // fatti restano (ciascuno è atomico e coerente), il job ritenta.
      for (const hop of path) {
        await runMonitoringTransition(session, tenantId, linked.incidentId, linked.instanceId, hop.toStep, hop.trigger,
          `Chiusura automatica dal monitoraggio: passaggio a ${hop.toLabel ?? hop.toStep}`, 'auto-resolve', false)
      }
      // La transizione "Risolvi" richiede la causa (rootCause = notes).
      await incidentService.resolveIncident(linked.incidentId, ctx, `Allarme di monitoraggio rientrato: ${title}`)
      const via = path.length ? ` — passando per ${path.map((h) => h.toLabel ?? h.toStep).join(', ')}` : ''
      await incidentService.addIncidentComment(linked.incidentId, ctx, `Risolto automaticamente: tutti gli allarmi di monitoraggio correlati sono rientrati (ultimo: ${title})${via}`)
      incidentsAutoResolvedTotal.inc({})
      outcome = 'auto_resolved'
    } else {
      // Nessun cammino percorribile (archi solo con condizioni di dominio, o
      // più lungo di AUTO_RESOLVE_MAX_HOPS): si lascia traccia senza forzare.
      await incidentService.addIncidentComment(linked.incidentId, ctx,
        `Tutti gli allarmi di monitoraggio correlati sono rientrati (ultimo: ${title}); l'incident è in "${linked.step}" e non può essere risolto automaticamente da questo passo`)
      outcome = 'auto_resolve_skipped'
    }
    const payload: EventCorrelatedPayload = { ...mapEventPayload(ev.props, ev.ciId), incident_id: linked.incidentId, outcome }
    await publishEvent('event.correlated', tenantId, actorId, payload, now)
    void audit(monitoringContext(tenantId), `event.${outcome}`, 'Event', eventId, { incidentId: linked.incidentId, incidentStep: linked.step, path: path?.map((h) => h.toStep) ?? null })
    log.info({ tenantId, eventId, incidentId: linked.incidentId, outcome }, 'Resolved event evaluated against its incident')
    return done(outcome, linked.incidentId)
  } finally { await session.close() }
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * `ingest`     — tutto (soppressione, salute, ritardo, correlazione / chiusura).
 * `reevaluate` — come ingest ma senza ritardo (mutation reevaluateEvent,
 *                linkEventToCI, fine finestra, job periodico).
 * `resume`     — job ritardato: soppressione e salute già fatte, si riparte dal
 *                raggruppamento se l'evento è ancora firing.
 */
export type PipelineMode = 'ingest' | 'reevaluate' | 'resume'

export interface PipelineInput {
  tenantId: string
  eventId:  string
  /** actor_id degli eventi di dominio; default 'monitoring'. */
  actorId?: string
  now?:     string
  mode?:    PipelineMode
  /** Solo in `ingest`: true se l'Event è stato CREATO da questo ingest (alimenta il contatore di tempesta della sorgente). */
  created?: boolean
}

export interface PipelineResult {
  outcome:              PipelineOutcome
  /** Stato dell'evento dopo la pipeline. */
  status:               string
  suppressedByChangeId: string | null
  incidentId:           string | null
}

export async function runEventPipeline(input: PipelineInput): Promise<PipelineResult> {
  const { tenantId, eventId } = input
  const mode = input.mode ?? 'ingest'
  const now = input.now ?? new Date().toISOString()
  const actorId = input.actorId ?? MONITORING_ACTOR

  const ev = await loadEventRecord(tenantId, eventId)
  const status = toStr(ev.props['status'])
  const policy = await getEventPolicy(tenantId)

  // 0. sfarfallio in corso: nessuna correlazione, la salute (degraded) resta aggiornata
  if (status === 'flapping') {
    if (ev.ciId) await recomputeCIHealth(tenantId, ev.ciId, actorId)
    return { outcome: 'flapping', status, suppressedByChangeId: null, incidentId: null }
  }
  // 0. rilevamento: solo all'ingest, dove i passaggi vengono registrati
  if (mode === 'ingest' && isFlapping(transitionsOf(ev.props), policy, now)) {
    return enterFlapping(tenantId, ev, policy, actorId, now)
  }
  // 0b. tempesta della sorgente: all'ingest si aggiorna il contatore (e si
  // apre/chiude la tempesta), nelle rivalutazioni si legge soltanto.
  const sourceId = toStr(ev.props['source_id'])
  const storm = mode === 'ingest'
    ? await trackSourceStorm({ tenantId, sourceId, created: input.created === true, policy, now, actorId, ciId: ev.ciId })
    : await getStormState(tenantId, sourceId)

  if (status === 'resolved') return handleResolvedEvent(tenantId, ev, actorId, now, mode, storm)

  if (mode === 'resume') {
    if (status === 'suppressed') return { outcome: 'suppressed', status, suppressedByChangeId: toStr(ev.props['suppressed_by_change_id']) || null, incidentId: null }
    if (storm.active) return correlateIntoStorm(tenantId, ev, policy, storm, actorId, now, mode)
    return correlateFiringEvent(tenantId, ev, policy, actorId, now, mode)
  }

  // 1. soppressione: blocca salute e correlazione
  if (ev.ciId) {
    const change = await findSuppressingChange(tenantId, ev.ciId, policy.suppress_upstream_hops, now)
    if (change) {
      await applySuppression(tenantId, ev, change, actorId, now, mode)
      return { outcome: 'suppressed', status: 'suppressed', suppressedByChangeId: change.changeId, incidentId: null }
    }
  }
  if (status === 'suppressed') {
    await liftSuppression(tenantId, eventId, now)
    ev.props['status'] = 'firing'
    ev.props['suppressed_by_change_id'] = null
    ev.props['correlation'] = 'pending'
  }
  // 2. salute del CI
  if (ev.ciId) await recomputeCIHealth(tenantId, ev.ciId, actorId)
  // 2b. tempesta: aggancio all'incident di tempesta, niente correlazione per CI
  if (storm.active) return correlateIntoStorm(tenantId, ev, policy, storm, actorId, now, mode)
  // 3–6
  return correlateFiringEvent(tenantId, ev, policy, actorId, now, mode)
}

// ── Fine finestra ────────────────────────────────────────────────────────────

/**
 * Rivaluta gli eventi ancora silenziati da una change (job
 * `reevaluate-change-window`, accodato quando la change esce dai passi di
 * finestra; vedi graphql/resolvers/change/autoTransitions.ts). Ogni evento
 * rientra nella pipeline: se un'altra change lo copre resta soppresso,
 * altrimenti torna firing e viene correlato. Un errore su un evento non ferma
 * gli altri ma fa fallire il job alla fine (ritenta; la passata periodica è la
 * rete di sicurezza). Restituisce il numero di eventi rivalutati.
 */
export async function reevaluateSuppressedEvents(tenantId: string, changeId: string, actorId: string = MONITORING_ACTOR): Promise<number> {
  const session = getSession()
  let ids: string[]
  try {
    const rows = await runQuery<{ id: string }>(session, `
      MATCH (e:Event {tenant_id: $tenantId, status: 'suppressed', suppressed_by_change_id: $changeId})
      RETURN e.id AS id ORDER BY e.last_seen_at DESC
    `, { tenantId, changeId })
    ids = rows.map((r) => r.id)
  } finally { await session.close() }
  let failed = 0
  for (const eventId of ids) {
    try {
      await runEventPipeline({ tenantId, eventId, actorId, mode: 'reevaluate' })
    } catch (err) {
      failed++
      log.error({ err, tenantId, changeId, eventId }, 'Suppressed event re-evaluation after change window failed')
    }
  }
  if (ids.length) log.info({ tenantId, changeId, count: ids.length, failed }, 'Suppressed events re-evaluated after change window')
  if (failed > 0) throw new Error(`reevaluateSuppressedEvents: ${failed}/${ids.length} events suppressed by change ${changeId} failed re-evaluation (see logs)`)
  return ids.length
}

// ── Passate periodiche (coda events-maintenance) ─────────────────────────────

interface EventRef { tenantId: string; id: string }

/** Una pagina di (tenant, evento) con id > cursor, ordinata per id. `match` è il MATCH … WHERE … (senza RETURN). */
async function fetchEventPage(match: string, params: Props, cursor: string, limit: number): Promise<EventRef[]> {
  const session = getSession()
  try {
    // tenant-ok: job di manutenzione su tutti i tenant; ogni evento è poi rivalutato nel suo tenant.
    return await runQuery<EventRef>(session, `
      ${match}
      RETURN e.tenant_id AS tenantId, e.id AS id
      ORDER BY e.id LIMIT toInteger($limit)
    `, { ...params, cursor, limit })
  } finally { await session.close() }
}

/** Passata paginata che ripassa ogni riga dalla pipeline in `reevaluate`. */
async function reevaluatePass(name: string, match: string, params: Props, now: string, what: string): Promise<PagedPassResult> {
  const result = await runPagedPass<EventRef>({
    fetchPage: (cursor, limit) => fetchEventPage(match, params, cursor, limit),
    keyOf: (r) => r.id,
    handle: async (r) => { await runEventPipeline({ tenantId: r.tenantId, eventId: r.id, now, mode: 'reevaluate' }) },
    onError: (r, err) => log.error({ err, tenantId: r.tenantId, eventId: r.id }, `${what} re-evaluation failed`),
  })
  if (result.truncated) log.warn({ evaluated: result.evaluated }, `${name}: page cap reached, remaining events are re-evaluated on the next pass`)
  if (result.failed > 0) throw new Error(`${name}: ${result.failed}/${result.evaluated} ${what} events failed re-evaluation (see logs)`)
  return result
}

/**
 * Job periodico: ogni evento soppresso (di ogni tenant) viene rivalutato; quelli
 * la cui finestra è chiusa tornano firing. Paginato; un errore su un evento
 * non ferma gli altri, ma alla fine fa fallire il job (visibile in coda).
 */
export async function reevaluateClosedWindows(now: string = new Date().toISOString()): Promise<PagedPassResult> {
  // tenant-ok: passata di manutenzione su tutti i tenant; ogni evento è poi rivalutato nel suo tenant.
  return reevaluatePass('reevaluateClosedWindows', `MATCH (e:Event {status: 'suppressed'})\n      WHERE e.id > $cursor`, {}, now, 'suppressed')
}

/**
 * Job periodico: gli eventi firing rimasti senza correlazione — `pending`
 * (fine soppressione / stabilizzazione la cui correlazione è fallita) o
 * `none` con una scadenza — con `correlation_due_at` passata rientrano nella
 * pipeline. È la rete di sicurezza degli stati ritentabili: nessun allarme
 * attivo resta senza incident per ore in silenzio.
 */
export async function reevaluatePendingEvents(now: string = new Date().toISOString()): Promise<PagedPassResult> {
  // tenant-ok: passata di manutenzione su tutti i tenant; ogni evento è poi rivalutato nel suo tenant.
  return reevaluatePass('reevaluatePendingEvents', `MATCH (e:Event {status: 'firing'})
      WHERE e.correlation IN $correlations AND e.correlation_due_at IS NOT NULL AND e.correlation_due_at <= $now AND e.id > $cursor`,
    { correlations: PENDING_CORRELATIONS, now }, now, 'pending')
}
