/**
 * Servizi monitorati — motore di valutazione (coda `services-impact`,
 * jobs/serviceImpactWorker.ts; innesco dal consumer di `ci.health_changed`,
 * consumers/serviceImpactConsumer.ts; rete di sicurezza: passata periodica).
 *
 * `evaluateServiceMap`: UNA query legge la mappa, le INCLUDES con la salute
 * del CI e, per ogni CI, le change collegate in un passo di finestra
 * (stessa regola di services/events/suppression.ts#findSuppressingChange con
 * hops 0, applicata qui a tutti i nodi in una volta invece di una query per
 * CI); applica le regole (rules.ts); scrive in UNO statement: SET su
 * ServiceMap + voce di cronologia + cap (history.ts). La decisione «salute
 * cambiata» è presa NEL Cypher (`previous IS NULL OR previous <> $health`),
 * così due valutazioni concorrenti della stessa mappa non scrivono due voci
 * né pubblicano due eventi. Punteggio e spiegazione vengono aggiornati anche
 * a salute invariata (un punteggio stantio sarebbe un dato falso); voce di
 * cronologia ed evento `service.health_changed` solo se la salute cambia.
 *
 * Ondata 3: dopo la scrittura, se la valutazione è rilevante (salute cambiata
 * oppure insieme delle cause diverso da quello dell'ultima spiegazione),
 * `reconcileServiceIncident` (incident.ts) porta l'incident del servizio nello
 * stato coerente — apertura, commento, riapertura, chiusura automatica.
 *
 * Un nodo incluso che non esiste più (`node_ids` della mappa ⊄ INCLUDES:
 * cancellare un CI porta via la relazione) marca la mappa `stale` e scrive una
 * voce `map_changed` con gli id mancanti, UNA volta (finché resta stale); la
 * valutazione prosegue sui nodi rimasti: fail-loud, mai un nodo ignorato in
 * silenzio.
 */
import { v4 as uuidv4 } from 'uuid'
import { getSession, runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import type { ServiceHealthChangedPayload } from '@opengraphity/types'
import { publishEvent } from '../../lib/publishEvent.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { ciTypeFromLabels } from '../../lib/ciTypeFromLabels.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { runPagedPass, type PagedPassResult } from '../../lib/pagedPass.js'
import { serviceEvaluationDurationSeconds, serviceEvaluationsTotal, serviceMapsStale, servicesHealth } from '../../middleware/metrics.js'
import type { CIHealth } from '../../lib/eventVocabularies.js'
import {
  NODE_PROPAGATIONS, SERVICE_HEALTHS, SERVICE_MAP_STATUSES, SERVICE_NODE_ROLES, parseServiceImpactRules,
  type NodePropagation, type ServiceHealth, type ServiceHealthTrigger, type ServiceImpactRules, type ServiceMapStatus, type ServiceNodeRole,
} from '../../lib/serviceVocabularies.js'
import { MONITORING_ACTOR, monitoringContext, toNumber, toStr, type Props } from '../events/shared.js'
import { CHANGE_WINDOW_STEPS, changeIsInWindow } from '../events/suppression.js'
import { evaluateImpact, type ImpactCause, type ImpactNodeInput } from './rules.js'
import { causeIdsOf, sameCauseIds, serviceHistoryParams, serviceHistoryWriteCypher, type StoredCause } from './history.js'
import { buildServiceMap, createServiceMapNode, type ServiceMapProposal } from './build.js'
import { reconcileServiceIncident, type ServiceIncidentResult } from './incident.js'

const log = logger.child({ module: 'service-impact' })

/** Mappe attive con `evaluated_at` più vecchio di così (o `stale`) vengono rivalutate dalla passata periodica. */
export const SERVICE_STALE_EVALUATION_MINUTES = 10

// ── Lettura ──────────────────────────────────────────────────────────────────

/** Un nodo incluso come esce dalla lettura: l'input delle regole più quanto serve ai resolver. */
export interface LoadedNode extends ImpactNodeInput {
  name:         string
  labels:       string[]
  healthSource: string | null
  status:       string | null
  addedBy:      string
}

export interface ServiceMapState {
  props:  Props
  rules:  ServiceImpactRules
  nodes:  LoadedNode[]
  /** Id inclusi alla costruzione che non esistono più nel grafo. */
  missing: string[]
}

interface ChangeRow { step: string | null; plans: unknown[] | null }
interface NodeRow {
  ciId: string; name: string | null; labels: string[]; level: unknown; role: string; propagate: string; weight: unknown; critical: unknown; via: string | null; addedBy: string | null
  health: string | null; healthSource: string | null; status: string | null; changes: ChangeRow[]
}
interface StateRow { props: Props; nodes: NodeRow[] }

/**
 * La mappa, i nodi inclusi con la salute del CI e, per ciascuno, le change
 * (non eliminate) collegate con AFFECTS_CI il cui workflow è in un passo di
 * finestra, con i piani di rilascio: la finestra vera (deployment sempre,
 * scheduled solo dentro una finestra del piano) si decide in TypeScript con
 * `changeIsInWindow`, la stessa della soppressione degli allarmi.
 */
export const LOAD_SERVICE_MAP_CYPHER = `
  MATCH (m:ServiceMap {id: $mapId, tenant_id: $tenantId})
  OPTIONAL MATCH (m)-[inc:INCLUDES]->(ci {tenant_id: $tenantId})
  WITH m, inc, ci,
       CASE WHEN ci IS NULL THEN [] ELSE
         [(c:Change {tenant_id: $tenantId})-[:AFFECTS_CI]->(ci)
            WHERE coalesce(c.deleted, false) = false
              AND EXISTS { (c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId}) WHERE wi.current_step IN $windowSteps }
          | {step:  head([(c)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId}) | wi.current_step]),
             plans: [(c)-[:HAS_DEPLOY_PLAN]->(dp:DeployPlanTask {tenant_id: $tenantId}) | dp.steps]}]
       END AS changes
  WITH m, collect(CASE WHEN ci IS NULL THEN null ELSE {
         ciId: ci.id, name: ci.name, labels: [l IN labels(ci) WHERE l <> 'ConfigurationItem'],
         level: inc.level, role: inc.role, propagate: inc.propagate, weight: inc.weight, critical: inc.critical, via: inc.via, addedBy: inc.added_by,
         health: ci.health, healthSource: ci.health_source, status: ci.status, changes: changes
       } END) AS nodes
  RETURN properties(m) AS props, [n IN nodes WHERE n IS NOT NULL] AS nodes`

/** Ciclo di vita del CI per cui l'Event Management non aggiorna la salute (services/events/ciHealth.ts). */
export const CI_LIFECYCLE_MAINTENANCE = 'maintenance'

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${what} is ${JSON.stringify(value)}: expected one of ${allowed.join(', ')}`)
  }
  return value as T
}

function mapNode(row: NodeRow, mapId: string, nowMs: number): LoadedNode {
  const where = `ServiceMap ${mapId} node ${row.ciId}`
  const health = row.health == null ? null : assertEnum<CIHealth>(row.health, ['operational', 'degraded', 'down'], `${where} health`)
  const changes = row.changes ?? []
  return {
    ciId:          row.ciId,
    name:          row.name ?? '',
    labels:        row.labels ?? [],
    level:         toNumber(row.level),
    role:          assertEnum<ServiceNodeRole>(row.role, SERVICE_NODE_ROLES, `${where} role`),
    propagate:     assertEnum<NodePropagation>(row.propagate, NODE_PROPAGATIONS, `${where} propagate`),
    weight:        toNumber(row.weight),
    critical:      row.critical === true,
    via:           row.via ?? null,
    addedBy:       row.addedBy ?? 'auto',
    health,
    healthSource:  row.healthSource ?? null,
    status:        row.status ?? null,
    // In manutenzione = change in finestra sul CI (stessa regola della soppressione)
    // OPPURE ciclo di vita `status = 'maintenance'`: l'Event Management non tocca
    // la salute di quel CI (ciHealth.ts), quindi i suoi allarmi non arriverebbero
    // mai al servizio; contarlo come «sano» sarebbe un fallback silenzioso.
    inMaintenance: row.status === CI_LIFECYCLE_MAINTENANCE
      || changes.some((c) => typeof c.step === 'string' && changeIsInWindow(c.step, c.plans ?? [], nowMs)),
  }
}

/** Legge lo stato della mappa nella sessione del chiamante. Mappa assente → NotFoundError. */
export async function loadServiceMapState(session: Queryable, tenantId: string, mapId: string, now: string): Promise<ServiceMapState> {
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) throw new Error(`loadServiceMapState: "${now}" is not an ISO date`)
  const row = await runQueryOne<StateRow>(session, LOAD_SERVICE_MAP_CYPHER, { mapId, tenantId, windowSteps: CHANGE_WINDOW_STEPS })
  if (!row) throw new NotFoundError('ServiceMap', mapId)
  const nodes = row.nodes.map((n) => mapNode(n, mapId, nowMs))
  const nodeIds = row.props['node_ids']
  if (!Array.isArray(nodeIds)) throw new Error(`ServiceMap ${mapId} has no node_ids — run the 20260910_1080_service_maps_bootstrap migration`)
  const present = new Set(nodes.map((n) => n.ciId))
  const missing = (nodeIds as unknown[]).map(toStr).filter((id) => !present.has(id))
  return { props: row.props, rules: parseServiceImpactRules(row.props['rules'], mapId), nodes, missing }
}

/** Riferimento a un CI per la spiegazione (istantanea): dai nodi caricati; un `via` non più nella mappa resta solo con l'id. */
function causeRef(id: string, byId: ReadonlyMap<string, LoadedNode>): StoredCause['ci'] {
  const n = byId.get(id)
  if (!n) return { id, name: id, type: 'unknown', health: null }
  return { id, name: n.name, type: ciTypeFromLabels(n.labels), health: n.health }
}

/**
 * Cause con i riferimenti ai CI risolti dai nodi caricati (istantanea):
 * la usano la valutazione (che le persiste) e l'anteprima dell'ondata 2 (che
 * non scrive nulla), così la spiegazione ha la stessa forma in entrambe.
 */
export function storedCausesOf(causes: readonly ImpactCause[], nodes: readonly LoadedNode[]): StoredCause[] {
  const byId = new Map(nodes.map((n) => [n.ciId, n]))
  return causes.map((c) => ({ ...c, ci: causeRef(c.ciId, byId), path: c.path.map((id) => causeRef(id, byId)) }))
}

// ── Valutazione ──────────────────────────────────────────────────────────────

export interface EvaluateInput {
  tenantId: string
  mapId:    string
  trigger:  ServiceHealthTrigger
  /** actor_id dell'evento di dominio e dell'audit; default monitoring. */
  actorId?: string
  now?:     string
  /** Solo per i log. */
  jobId?:   string
}

export interface EvaluateResult {
  mapId:          string
  health:         ServiceHealth
  previousHealth: ServiceHealth | null
  impactScore:    number
  changed:        boolean
  stale:          boolean
  causes:         StoredCause[]
  /** Esito della riconciliazione dell'incident del servizio; null se la valutazione non era rilevante (salute e cause invariate). */
  incident:       ServiceIncidentResult | null
}

interface WriteRow { id: string; previous: string | null; previousExplanation: unknown; changed: boolean; wasStale: boolean; serviceId: string; name: string; criticality: string | null }

/**
 * Scrittura della valutazione: stato + voce (se la salute cambia) + voce
 * `map_changed` (se la mappa diventa stale) + cap, in uno statement.
 *
 * La riga porta anche la spiegazione PRECEDENTE (letta prima del SET) e la
 * criticità del servizio: servono all'incident del servizio (incident.ts) —
 * la prima per sapere se l'insieme delle cause è cambiato, la seconda per
 * l'impatto dell'incident — senza una lettura in più.
 */
export function evaluationWriteCypher(): string {
  return `
      MATCH (m:ServiceMap {id: $mapId, tenant_id: $tenantId})
      WITH m, m.health AS previous, m.explanation AS previousExplanation, coalesce(m.stale, false) AS wasStale
      WITH m, previous, previousExplanation, wasStale, (previous IS NULL OR previous <> $health) AS changed, ($stale AND NOT wasStale) AS becameStale
      SET m.health = $health, m.impact_score = toInteger($impactScore), m.explanation = $explanation, m.evaluated_at = $now, m.stale = $stale,
          m.health_since = CASE WHEN changed THEN $now ELSE m.health_since END
      ${serviceHistoryWriteCypher({ when: 'changed', prefix: 'h', fields: { previousHealth: 'previous' }, cap: false })}
      ${serviceHistoryWriteCypher({ when: 'becameStale', prefix: 'st', fields: { previousHealth: 'previous' }, imports: ['previous', 'wasStale', 'changed', 'becameStale'], capWhen: 'changed OR becameStale' })}
      RETURN m.id AS id, previous, previousExplanation, changed, wasStale, m.service_id AS serviceId, m.name AS name,
             head([(ba:BusinessApplication {tenant_id: $tenantId})-[:HAS_SERVICE_MAP]->(m) | ba.criticality]) AS criticality`
}

/**
 * Gli id delle cause di una spiegazione salvata (`ServiceMap.explanation`),
 * per il confronto con quelle appena calcolate. Assente o corrotta = non
 * scritta dal motore: errore, mai un insieme vuoto per comodità.
 */
export function explanationCauseIds(raw: unknown, mapId: string): string[] {
  if (typeof raw !== 'string') throw new Error(`ServiceMap ${mapId} explanation is not a JSON string (got ${typeof raw}) — run the 20260910_1080_service_maps_bootstrap migration`)
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (e) { throw new Error(`ServiceMap ${mapId} explanation is corrupt JSON: ${e instanceof Error ? e.message : String(e)}`) }
  if (!Array.isArray(parsed)) throw new Error(`ServiceMap ${mapId} explanation is not a JSON array`)
  return causeIdsOf(parsed as StoredCause[])
}

/**
 * Valuta la mappa e persiste l'esito. Restituisce l'esito; un errore propaga
 * (il job ritenta, la passata periodica è la rete di sicurezza).
 */
export async function evaluateServiceMap(input: EvaluateInput): Promise<EvaluateResult> {
  const { tenantId, mapId, trigger } = input
  const actorId = input.actorId ?? MONITORING_ACTOR
  const now = input.now ?? new Date().toISOString()
  const startedAt = performance.now()
  const logCtx = { tenantId, mapId, trigger, jobId: input.jobId }
  try {
    const session = getSession(undefined, 'WRITE')
    let state: ServiceMapState
    let row: WriteRow | null
    let causes: StoredCause[]
    let result: ReturnType<typeof evaluateImpact>
    try {
      state = await loadServiceMapState(session, tenantId, mapId, now)
      result = evaluateImpact(state.nodes, state.rules)
      causes = storedCausesOf(result.causes, state.nodes)
      const stale = state.missing.length > 0
      const staleNote = stale ? `Componenti non più presenti nella CMDB: ${state.missing.join(', ')}` : null
      const explanation = JSON.stringify(causes)
      row = await runQueryOne<WriteRow>(session, evaluationWriteCypher(), {
        mapId, tenantId, now, stale,
        health: result.health, impactScore: result.impactScore, explanation,
        ...serviceHistoryParams({ trigger, health: result.health, previousHealth: null, impactScore: result.impactScore, causes }, now, 'h'),
        ...serviceHistoryParams({ trigger: 'map_changed', health: result.health, previousHealth: null, impactScore: result.impactScore, causes, note: staleNote }, now, 'st'),
      })
    } finally {
      await session.close()
    }
    if (!row) throw new Error(`ServiceMap ${mapId} vanished while writing its evaluation (tenant ${tenantId})`)

    const previous = row.previous == null ? null : assertEnum<ServiceHealth>(row.previous, SERVICE_HEALTHS, `ServiceMap ${mapId} previous health`)
    const changed = row.changed === true
    const stale = state.missing.length > 0
    if (stale && !row.wasStale) {
      log.warn({ ...logCtx, missing: state.missing }, 'Service map is stale: included CIs no longer exist in the CMDB')
    }
    if (changed) {
      const payload: ServiceHealthChangedPayload = {
        id: mapId, map_id: mapId, service_id: row.serviceId, name: row.name,
        previous_health: previous, new_health: result.health, impact_score: result.impactScore,
      }
      await publishEvent('service.health_changed', tenantId, actorId, payload, now)
      void audit(actorId === MONITORING_ACTOR ? monitoringContext(tenantId) : { tenantId, userId: actorId, userEmail: actorId, role: 'admin' }, 'service.health_changed', 'ServiceMap', mapId, {
        trigger, previousHealth: previous, health: result.health, impactScore: result.impactScore, causes: causes.map((c) => c.ciId), stale,
      })
      log.info({ ...logCtx, previousHealth: previous, health: result.health, impactScore: result.impactScore, causes: causes.length }, 'Service health changed')
    } else {
      log.debug({ ...logCtx, health: result.health, impactScore: result.impactScore }, 'Service health unchanged')
    }
    // Incident del servizio (ondata 3): si riconcilia solo quando la
    // valutazione è rilevante — salute cambiata, oppure stesso stato ma cause
    // diverse (un componente malato al posto di un altro: se un incident è
    // aperto va aggiornato). Una raffica di valutazioni che non cambia nulla
    // non prende nemmeno il lock.
    const causesChanged = !sameCauseIds(causeIdsOf(causes), explanationCauseIds(row.previousExplanation, mapId))
    const incident = changed || causesChanged
      ? await reconcileServiceIncident({
        tenantId, mapId, serviceId: row.serviceId, serviceName: row.name, criticality: row.criticality ?? null,
        status: assertEnum<ServiceMapStatus>(state.props['status'], SERVICE_MAP_STATUSES, `ServiceMap ${mapId} status`),
        rules: state.rules, health: result.health, impactScore: result.impactScore, causes,
        actorId, now, jobId: input.jobId,
      })
      : null
    // La metrica si incrementa alla FINE: una riconciliazione fallita conta
    // come `error` (il catch), non anche come `changed`.
    serviceEvaluationsTotal.inc({ result: changed ? 'changed' : 'unchanged' })
    return { mapId, health: result.health, previousHealth: previous, impactScore: result.impactScore, changed, stale, causes, incident }
  } catch (err) {
    serviceEvaluationsTotal.inc({ result: 'error' })
    throw err
  } finally {
    serviceEvaluationDurationSeconds.observe({}, (performance.now() - startedAt) / 1000)
  }
}

// ── Creazione ────────────────────────────────────────────────────────────────

export interface CreateServiceMapInput {
  tenantId:          string
  serviceId:         string
  maxDepth:          number
  relationshipTypes: readonly string[]
  actorId:           string
  /** `active` in ondata 1 (draft arriva con la UI di ondata 2). */
  status?:           ServiceMapStatus
  now?:              string
}

export interface CreateServiceMapResult { mapId: string; proposal: ServiceMapProposal; evaluation: EvaluateResult }

/** Piano del tenant, limite di mappe del piano e mappe già esistenti: UNA lettura. */
export const SERVICE_MAP_PLAN_LIMIT_CYPHER = `
  MATCH (t:Tenant {id: $tenantId})
  OPTIONAL MATCH (m:ServiceMap {tenant_id: $tenantId})
  RETURN t.plan AS plan, t.max_service_maps AS maxServiceMaps, count(m) AS maps`

interface PlanLimitRow { plan: string | null; maxServiceMaps: unknown; maps: unknown }

/**
 * Limite di piano sulle mappe di servizio (`TenantSettings.max_service_maps`:
 * starter 5, pro 50, enterprise 200 — lib/tenantPlans.ts). Si controlla PRIMA
 * della costruzione automatica: inutile espandere il grafo per poi rifiutare.
 *
 * Nessun default di comodo: un tenant senza nodo :Tenant o senza
 * `max_service_maps` è un errore che nomina la migrazione da eseguire, non un
 * limite inventato a runtime. Due creazioni simultanee sull'ultimo posto
 * possono superare il limite di una (Neo4j non blocca un conteggio): la
 * creazione successiva viene comunque rifiutata.
 */
export async function assertServiceMapPlanLimit(session: Queryable, tenantId: string): Promise<void> {
  const row = await runQueryOne<PlanLimitRow>(session, SERVICE_MAP_PLAN_LIMIT_CYPHER, { tenantId })
  if (!row) throw new Error(`Tenant ${tenantId} has no :Tenant node — run the 20260910_1070_event_management_tenants migration`)
  if (typeof row.plan !== 'string' || row.plan === '') throw new Error(`Tenant ${tenantId} has no plan (got ${JSON.stringify(row.plan)}): fix the tenant before creating service maps`)
  if (row.maxServiceMaps == null) throw new Error(`Tenant ${tenantId} has no max_service_maps — run the 20260910_1100_service_map_plan_limit migration`)
  const max = toNumber(row.maxServiceMaps)
  const maps = toNumber(row.maps)
  if (maps >= max) {
    throw new ValidationError(`piano ${row.plan}: massimo ${max} mappe di servizio, ne esistono già ${maps}`)
  }
}

/**
 * Limite di piano + costruzione automatica + scrittura (una transazione) +
 * valutazione immediata (trigger `created`: prima voce di cronologia). Una sola
 * mappa per servizio: se esiste già → ValidationError (dalla scrittura, anche
 * in gara).
 */
export async function createServiceMap(input: CreateServiceMapInput): Promise<CreateServiceMapResult> {
  const now = input.now ?? new Date().toISOString()
  const status = assertEnum<ServiceMapStatus>(input.status ?? 'active', SERVICE_MAP_STATUSES, 'ServiceMap status')
  const mapId = uuidv4()
  const session = getSession(undefined, 'WRITE')
  let proposal: ServiceMapProposal
  try {
    await assertServiceMapPlanLimit(session, input.tenantId)
    proposal = await buildServiceMap(session, input.tenantId, input.serviceId, input.maxDepth, input.relationshipTypes)
    await session.executeWrite((tx) => createServiceMapNode(tx, { tenantId: input.tenantId, serviceId: input.serviceId, mapId, status, proposal, actorId: input.actorId, now }))
  } finally {
    await session.close()
  }
  log.info({ tenantId: input.tenantId, serviceId: input.serviceId, mapId, nodes: proposal.nodes.length, maxDepth: proposal.maxDepth, relationshipTypes: proposal.relationshipTypes, actorId: input.actorId }, 'Service map created')
  const evaluation = await evaluateServiceMap({ tenantId: input.tenantId, mapId, trigger: 'created', actorId: input.actorId, now })
  return { mapId, proposal, evaluation }
}

// ── Mappe che includono un CI (consumer) ─────────────────────────────────────

export interface ServiceMapRef { id: string; status: string }

/** Le mappe del tenant che includono il CI, tranne quelle in pausa (non valutate automaticamente). */
export async function findMapsIncludingCI(tenantId: string, ciId: string): Promise<ServiceMapRef[]> {
  const session = getSession()
  try {
    return await runQuery<ServiceMapRef>(session, `
      MATCH (m:ServiceMap {tenant_id: $tenantId})-[:INCLUDES]->(ci {id: $ciId, tenant_id: $tenantId})
      WHERE m.status <> 'paused'
      RETURN m.id AS id, m.status AS status
      ORDER BY m.id
    `, { tenantId, ciId })
  } finally { await session.close() }
}

// ── Passata periodica (rete di sicurezza) ────────────────────────────────────

interface MapRef { tenantId: string; id: string }

/**
 * Mappe attive con `evaluated_at` più vecchio di SERVICE_STALE_EVALUATION_MINUTES
 * (o mai valutate) o `stale`, di ogni tenant, paginate (lib/pagedPass.ts):
 * ognuna viene rivalutata con trigger `periodic`. Un errore su una mappa non
 * ferma le altre ma fa fallire il job alla fine.
 */
export async function evaluateStaleOrOldMaps(now: string = new Date().toISOString()): Promise<PagedPassResult> {
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) throw new Error(`evaluateStaleOrOldMaps: "${now}" is not an ISO date`)
  const cutoff = new Date(nowMs - SERVICE_STALE_EVALUATION_MINUTES * 60_000).toISOString()
  const result = await runPagedPass<MapRef>({
    fetchPage: async (cursor, limit) => {
      const session = getSession()
      try {
        return await runQuery<MapRef>(session, `
          // tenant-ok: passata di manutenzione su tutti i tenant; ogni mappa è poi valutata nel suo tenant.
          MATCH (m:ServiceMap {status: 'active'})
          WHERE (m.evaluated_at IS NULL OR m.evaluated_at < $cutoff OR m.stale = true) AND m.id > $cursor
          RETURN m.tenant_id AS tenantId, m.id AS id
          ORDER BY m.id LIMIT toInteger($limit)
        `, { cutoff, cursor, limit })
      } finally { await session.close() }
    },
    keyOf:   (r) => r.id,
    handle:  async (r) => { await evaluateServiceMap({ tenantId: r.tenantId, mapId: r.id, trigger: 'periodic', now }) },
    onError: (r, err) => log.error({ err, tenantId: r.tenantId, mapId: r.id }, 'Periodic service map evaluation failed'),
  })
  if (result.truncated) log.warn({ evaluated: result.evaluated }, 'evaluateStaleOrOldMaps: page cap reached, remaining maps are evaluated on the next pass')
  if (result.failed > 0) throw new Error(`evaluateStaleOrOldMaps: ${result.failed}/${result.evaluated} service maps failed evaluation (see logs)`)
  return result
}

/** Istantanea dei gauge dei servizi: mappe per salute e mappe da rivedere. */
export interface ServiceGaugesSnapshot {
  health: Record<ServiceHealth, number>
  /** Mappe con `stale = true`: un componente incluso non esiste più nella CMDB. */
  stale:  number
}

/**
 * Gauge `services_health{health}` (mappe per salute, tutte le etichette sempre
 * presenti) e `service_maps_stale` (mappe da rivedere), su tutti i tenant:
 * metriche di processo, riallineate dalla stessa passata periodica in UNA
 * lettura (jobs/serviceImpactWorker.ts, job `services-periodic`).
 */
export async function refreshServiceGauges(): Promise<ServiceGaugesSnapshot> {
  const session = getSession()
  try {
    // tenant-ok: metrica di processo su tutti i tenant (solo conteggi, nessuna scrittura)
    const rows = await runQuery<{ health: string | null; n: unknown; stale: unknown }>(session, `
      MATCH (m:ServiceMap)
      RETURN m.health AS health, count(m) AS n, sum(CASE WHEN m.stale = true THEN 1 ELSE 0 END) AS stale
    `)
    const out = Object.fromEntries(SERVICE_HEALTHS.map((h) => [h, 0])) as Record<ServiceHealth, number>
    let stale = 0
    for (const r of rows) {
      // Le mappe stale si contano anche nella riga `health = null` (mappa mai
      // valutata): il conteggio è per riga, non per salute nota.
      stale += toNumber(r.stale)
      if (r.health == null) continue
      const h = assertEnum<ServiceHealth>(r.health, SERVICE_HEALTHS, 'ServiceMap health')
      out[h] = toNumber(r.n)
    }
    for (const h of SERVICE_HEALTHS) servicesHealth.set({ health: h }, out[h])
    serviceMapsStale.set({}, stale)
    return { health: out, stale }
  } finally { await session.close() }
}
