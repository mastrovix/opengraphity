/**
 * Passi 3–6 della pipeline: soglia, orfano, ritardo, raggruppamento in
 * incident (per CI o per impronta) e aggancio all'incident di tempesta.
 *
 * Atomicità del raggruppamento (revisione, 1.1): "trova l'incident del gruppo
 * → apri / aggancia / riapri" gira sotto un lock Redis per (tenant, gruppo)
 * — `og:events:group:<tenant>:ci:<ciId>` o `…:fp:<impronta>` (lib/redisLock.ts)
 * — perché il worker `events-ingest` ha concurrency 4 e due allarmi diversi
 * sullo stesso CI arrivano nello stesso batch: senza lock leggevano entrambi
 * "nessun incident" e ne aprivano due. Chi trova il lock occupato attende
 * (fino a GROUP_LOCK_WAIT_MS) che l'incident compaia (e vi si aggancia) o che
 * il lock si liberi e rilegge; oltre l'attesa → errore ritentabile.
 *
 * Dieta di rumore (3.3): una ripetizione di un evento GIÀ agganciato allo
 * stesso incident non produce `event.correlated`, audit né commento.
 */
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'
import type { MonitoringEventPayload } from '@opengraphity/types'
import { ValidationError } from '../../lib/errors.js'
import { publishEvent } from '../../lib/publishEvent.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { withRedisLock, type RedisLockOptions } from '../../lib/redisLock.js'
import type { EventPolicy } from '../../lib/eventPolicy.js'
import type { CorrelationOutcome, EventSeverity } from '../../lib/eventVocabularies.js'
import { incidentsAutoOpenedTotal, incidentsReopenedTotal } from '../../middleware/metrics.js'
import { incidents, queue } from './deps.js'
import { MONITORING_ACTOR, SEVERITY_RANK, assertSeverity, mapEventPayload, monitoringContext, toNumber, toStr, type Props } from './shared.js'
import { getEventPolicy } from './policy.js'
import { attachEventToIncident, setCorrelation } from './repo.js'
import { incidentStep, incidentStepInfo, reopenIncident, type IncidentStepInfo, type OpenIncidentRow } from './incidentWorkflow.js'
import { replaceClosedStormIncident, stormLockKey, STORM_LOCK_TTL_SECONDS, STORM_LOCK_WAIT_MS, STORM_LOCK_POLL_MS, type StormState } from './storm.js'
import type { EventRecord, PipelineMode, PipelineOutcome, PipelineResult } from './types.js'

const log = logger.child({ module: 'event-correlation' })

/** Esiti che dicono "agganciato a un incident": una ripetizione con lo stesso esito e la stessa relazione è silenziosa. */
const ATTACHED_OUTCOMES: readonly string[] = ['opened', 'attached', 'reopened']

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

export interface EventCorrelatedPayload extends MonitoringEventPayload { incident_id: string | null; outcome: PipelineOutcome }

/** True se la severità raggiunge la soglia `open_incident_from` (`never` → mai). */
export function meetsOpenThreshold(severity: EventSeverity, openFrom: EventPolicy['open_incident_from']): boolean {
  if (openFrom === 'never') return false
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[openFrom]
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
  /** Policy già letta dal chiamante (la pipeline): assente → letta qui (mutation manuale). */
  policy?:  EventPolicy
  /** Sessione del chiamante per CORRELATED_INTO ed esito: assente → sessione propria. */
  session?: Session
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
  const policy = args.policy ?? await getEventPolicy(tenantId)
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

  const own = args.session ? null : getSession(undefined, 'WRITE')
  const session = args.session ?? own!
  try {
    await attachEventToIncident(session, tenantId, eventId, incident.id, manual, now)
    await setCorrelation(session, tenantId, eventId, 'opened', now)
  } finally { if (own) await own.close() }
  if (!manual) incidentsAutoOpenedTotal.inc({})
  return incident
}

// ── 6. Raggruppamento ────────────────────────────────────────────────────────

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

export async function correlateFiringEvent(session: Session, tenantId: string, ev: EventRecord, policy: EventPolicy, actorId: string, now: string, mode: PipelineMode, logCtx: Record<string, unknown> = {}): Promise<PipelineResult> {
  const eventId = toStr(ev.props['id'])
  const done = (outcome: CorrelationOutcome, incidentId: string | null = null): PipelineResult =>
    ({ outcome, status: 'firing', suppressedByChangeId: null, incidentId })

  // 3. soglia (la salute è già stata aggiornata)
  const severity = assertSeverity(ev.props['severity'], eventId)
  if (!meetsOpenThreshold(severity, policy.open_incident_from)) {
    await setCorrelation(session, tenantId, eventId, 'skipped_severity', now)
    return done('skipped_severity')
  }
  // 4. orfano: l'apertura resta manuale
  if (!ev.ciId) {
    await setCorrelation(session, tenantId, eventId, 'skipped_orphan', now)
    return done('skipped_orphan')
  }

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
      await setCorrelation(session, tenantId, eventId, 'delayed', now, dueAt)
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
      const created = await attachEventToIncident(session, tenantId, eventId, open.incidentId, false, now)
      incidentsReopenedTotal.inc({})
      return { outcome: 'reopened', incidentId: open.incidentId, created }
    }
    const created = await attachEventToIncident(session, tenantId, eventId, open.incidentId, false, now)
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
      const incident = await openIncidentFromEvent({ tenantId, props: ev.props, ciId: ev.ciId, actorId: MONITORING_ACTOR, manual: false, now, policy, session })
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
    log.debug({ ...logCtx, tenantId, eventId, incidentId }, 'Repeated event already correlated: nothing to publish')
    return done(outcome, incidentId)
  }
  if (outcome !== 'opened') await setCorrelation(session, tenantId, eventId, outcome, now)   // opened: già scritto da openIncidentFromEvent

  const payload: EventCorrelatedPayload = { ...mapEventPayload({ ...ev.props, status: 'firing' }, ev.ciId), incident_id: incidentId, outcome }
  await publishEvent('event.correlated', tenantId, actorId, payload, now)
  void audit(monitoringContext(tenantId), `event.${outcome}`, 'Event', eventId, { incidentId, groupBy: policy.group_by })
  log.info({ ...logCtx, tenantId, eventId, incidentId, outcome }, 'Event correlated')
  return done(outcome, incidentId)
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
 * (storm.replaceClosedStormIncident); tempesta finita nel frattempo →
 * correlazione normale. Mai un allarme "assorbito" da un ticket chiuso.
 */
export async function correlateIntoStorm(session: Session, tenantId: string, ev: EventRecord, policy: EventPolicy, storm: StormState, actorId: string, now: string, mode: PipelineMode, logCtx: Record<string, unknown> = {}): Promise<PipelineResult> {
  const eventId = toStr(ev.props['id'])
  const sourceId = toStr(ev.props['source_id'])
  const noCi = async (): Promise<PipelineResult> => {
    if (ev.props['correlation'] !== 'storm_no_ci') await setCorrelation(session, tenantId, eventId, 'storm_no_ci', now)
    return { outcome: 'storm_no_ci', status: 'firing', suppressedByChangeId: null, incidentId: null }
  }
  if (!storm.incidentId) return noCi()

  let incidentId: string = storm.incidentId
  let sourceName = storm.sourceName
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
    if (!target.active) return correlateFiringEvent(session, tenantId, ev, policy, actorId, now, mode, logCtx)
    if (!target.incidentId) return noCi()
    incidentId = target.incidentId
    sourceName = target.sourceName
  }

  const created = await attachEventToIncident(session, tenantId, eventId, incidentId, false, now)
  if (created || ev.props['correlation'] !== 'storm') await setCorrelation(session, tenantId, eventId, 'storm', now)
  log.debug({ ...logCtx, tenantId, eventId, incidentId, sourceName }, 'Event attached to storm incident')
  return { outcome: 'storm', status: 'firing', suppressedByChangeId: null, incidentId }
}
