/**
 * Servizi monitorati — motore di valutazione (coda `services-impact`,
 * jobs/serviceImpactWorker.ts; innesco dal consumer di `ci.health_changed`,
 * consumers/serviceImpactConsumer.ts; rete di sicurezza: passata periodica).
 *
 * `evaluateServiceMap`: UNA query legge la mappa, le INCLUDES con la salute
 * del CI e, per ogni CI, le change collegate in un passo di finestra e le
 * sorgenti in tempesta dei suoi allarmi accesi. Le finestre di change sono la
 * STESSA definizione degli allarmi (revisione 2 · D6.2): il frammento
 * `changeWindowSubqueryCypher` di services/events/suppression.ts, innestato
 * qui per tutti i nodi in una volta e con i salti a monte della policy
 * (`suppress_upstream_hops`) invece dei soli CI diretti. Poi applica le regole
 * (rules.ts); scrive in UNO statement: SET su
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
 * cancellare un CI porta via la relazione) marca la mappa `stale` con
 * `stale_reason = 'missing_ci'` e scrive una voce `map_changed` con gli id
 * mancanti, UNA volta (finché resta stale); la valutazione prosegue sui nodi
 * rimasti: fail-loud, mai un nodo ignorato in silenzio. Uno `stale` scritto
 * dalla sincronizzazione per il tetto dei 500 (`over_limit`) non viene spento da
 * qui: lo spegne solo una sincronizzazione riuscita.
 *
 * Revisione 2 (ondata 3): con `rules.during_storm = 'hold'` (default) e una
 * sorgente degli allarmi dei componenti in tempesta la valutazione è
 * SOSPESA — salute, punteggio e spiegazione restano quelli di prima, nessun
 * incident di servizio viene aperto o chiuso, si scrivono solo `evaluated_at`
 * e la nota (`health_note`, D6.4). La fine della tempesta
 * (`event.storm_ended`) fa rivalutare le mappe coinvolte
 * (consumers/serviceImpactConsumer.ts).
 *
 * Revisione 2: la scrittura ha una **guardia di versione** (E1) — se la
 * composizione è cambiata fra la lettura e la scrittura si rilegge e si
 * ricalcola una volta — e le due manutenzioni sono distinte (R1): un ciclo di
 * vita che il CLIENTE dichiara «in manutenzione» (ondata 7 · C-4,
 * `lib/ciLifecycle.ts`: non più il valore `maintenance` di fabbrica) toglie il
 * nodo dal calcolo, solo una change in finestra su un componente critico rende
 * il servizio `maintenance` (e `health_if_active` dice quale sarebbe la salute
 * senza quella finestra).
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
  NODE_PROPAGATIONS, SERVICE_HEALTHS, SERVICE_MAP_STATUSES, SERVICE_NODE_ROLES,
  SERVICE_STALE_MISSING_CI, SERVICE_STALE_OVER_LIMIT, parseServiceImpactRules,
  type NodePropagation, type ServiceHealth, type ServiceHealthTrigger, type ServiceImpactRules, type ServiceMapStatus, type ServiceNodeRole,
} from '../../lib/serviceVocabularies.js'
import { isRetiredLifecycle, isMaintenanceLifecycle, resolveCILifecycleSemantics, type CILifecycleSemantics } from '../../lib/ciLifecycle.js'
import { MONITORING_ACTOR, monitoringContext, toNumber, toStr, type Props } from '../events/shared.js'
import { getEventPolicy } from '../events/policy.js'
import { changeWindowParams, changeWindowSubqueryCypher, pickChangeWindow, resolveChangeWindowSteps, suppressionRelTypes, type ChangeWindow, type ChangeWindowRow, type ChangeWindowSteps } from '../events/suppression.js'
import { evaluateImpact, serviceHealthNote, type ImpactCause, type ImpactNodeInput, type UpstreamWindowRef } from './rules.js'
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
  /** La change che copre il CI (diretta o a monte); null se non è in finestra. */
  changeWindow: ChangeWindow | null
  /** Sorgenti in tempesta fra quelle degli allarmi accesi su questo CI (nomi, senza doppioni). */
  stormSources: string[]
}

export interface ServiceMapState {
  props:  Props
  rules:  ServiceImpactRules
  nodes:  LoadedNode[]
  /** Id inclusi alla costruzione che non esistono più nel grafo. */
  missing: string[]
  /**
   * `ServiceMap.version` al momento della lettura: la scrittura della
   * valutazione la usa come guardia (E1), così una sincronizzazione che
   * cambia la composizione nel mezzo non si fa sovrascrivere da una salute
   * calcolata sui nodi di prima.
   */
  version: number
}

interface NodeRow {
  ciId: string; name: string | null; labels: string[]; level: unknown; role: string; propagate: string; weight: unknown; critical: unknown; via: string | null; addedBy: string | null
  health: string | null; healthSource: string | null; status: string | null
  changes: ChangeWindowRow[] | null
  stormSources: (string | null)[] | null
}
interface StateRow { props: Props; nodes: NodeRow[] }

/**
 * La mappa, i nodi inclusi con la salute del CI e, per ciascuno:
 *  - le change che lo coprono (diretta o a monte entro `hops` salti), con i
 *    piani di rilascio **del CI toccato** — il frammento condiviso con la
 *    soppressione degli allarmi (services/events/suppression.ts, revisione 2 ·
 *    D6.2): la finestra vera (scopo `implementation` sempre, scopo `scheduled`
 *    solo dentro una finestra del piano) si decide in TypeScript con
 *    `pickChangeWindow`;
 *  - le sorgenti in tempesta dei suoi allarmi accesi (revisione 2 · D6.4),
 *    lette qui e non con un giro in più.
 * `hops` è interpolato nel pattern (intero validato dalla policy): la query è
 * una funzione, non una costante.
 */
export function loadServiceMapCypher(hops: number, relTypes: string): string {
  return `
  MATCH (m:ServiceMap {id: $mapId, tenant_id: $tenantId})
  OPTIONAL MATCH (m)-[inc:INCLUDES]->(ci {tenant_id: $tenantId})
  ${changeWindowSubqueryCypher(hops, relTypes)}
  WITH m, inc, ci, changes,
       CASE WHEN ci IS NULL THEN [] ELSE
         [(e:Event {tenant_id: $tenantId, status: 'firing'})-[:RAISED_ON]->(ci)
          | head([(e)-[:FROM_SOURCE]->(w:InboundWebhook {tenant_id: $tenantId}) WHERE w.storm_since IS NOT NULL | coalesce(w.name, w.id)])]
       END AS stormSources
  WITH m, collect(CASE WHEN ci IS NULL THEN null ELSE {
         ciId: ci.id, name: ci.name, labels: [l IN labels(ci) WHERE l <> 'ConfigurationItem'],
         level: inc.level, role: inc.role, propagate: inc.propagate, weight: inc.weight, critical: inc.critical, via: inc.via, addedBy: inc.added_by,
         health: ci.health, healthSource: ci.health_source, status: ci.status, changes: changes, stormSources: stormSources
       } END) AS nodes
  RETURN properties(m) AS props, [n IN nodes WHERE n IS NOT NULL] AS nodes`
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${what} is ${JSON.stringify(value)}: expected one of ${allowed.join(', ')}`)
  }
  return value as T
}

function mapNode(row: NodeRow, mapId: string, nowMs: number, windowSteps: ChangeWindowSteps, semantics: CILifecycleSemantics): LoadedNode {
  const where = `ServiceMap ${mapId} node ${row.ciId}`
  const health = row.health == null ? null : assertEnum<CIHealth>(row.health, ['operational', 'degraded', 'down'], `${where} health`)
  // Stessa scelta della soppressione degli allarmi: la prima change davvero in
  // finestra fra le candidate (prima la diretta, poi quelle a monte).
  const changeWindow = pickChangeWindow(row.changes, nowMs, windowSteps)
  const stormSources = [...new Set((row.stormSources ?? []).filter((x): x is string => typeof x === 'string' && x !== ''))]
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
    // Le due manutenzioni restano distinte fin da qui (revisione 2 · R1): la
    // finestra di change può rendere il SERVIZIO `maintenance`, il ciclo di vita
    // del CI no — toglie il nodo dal calcolo e basta (l'Event Management non ne
    // aggiorna la salute, ciHealth.ts: contarlo come «sano» sarebbe un fallback
    // silenzioso, contarlo come manutenzione del servizio spegnerebbe il servizio
    // per sempre).
    inChangeWindow:       changeWindow !== null,
    changeWindowUpstream: changeWindow?.upstream === true,
    // Ondata 7 · C-4: «in manutenzione» è la semantica DEL CLIENTE
    // (lib/ciLifecycle.ts), non il letterale 'maintenance' — un cliente che
    // rinominava lo stato si ritrovava i CI in manutenzione dentro al calcolo.
    lifecycleMaintenance: isMaintenanceLifecycle(row.status, semantics),
    // Dismesso o fuori servizio (revisione 2 · D6.3): fuori dal calcolo come
    // `propagate: never`, e senza portare il servizio in manutenzione.
    lifecycleRetired:     isRetiredLifecycle(row.status, semantics),
    changeWindow,
    stormSources,
  }
}

/**
 * Legge lo stato della mappa nella sessione del chiamante. Mappa assente →
 * NotFoundError.
 *
 * I salti a monte delle finestre di change vengono dalla policy degli allarmi
 * (`suppress_upstream_hops`, revisione 2 · D6.2: una definizione sola per i
 * due sottosistemi). La policy si legge dalla cache in memoria
 * (lib/eventPolicy.ts, TTL 30 s): non è un giro in più per valutazione, e la
 * mappa resta UNA query.
 */
export async function loadServiceMapState(session: Queryable, tenantId: string, mapId: string, now: string): Promise<ServiceMapState> {
  const nowMs = Date.parse(now)
  if (Number.isNaN(nowMs)) throw new Error(`loadServiceMapState: "${now}" is not an ISO date`)
  const hops = (await getEventPolicy(tenantId)).suppress_upstream_hops
  // I passi della finestra di change vengono dallo SCOPO dei passi del tenant
  // (ondata 4 · A4-1), non dai nomi di fabbrica. Si riusa la sessione del
  // chiamante quando sa leggere; dentro una transazione altrui la risoluzione
  // apre la propria lettura (a cache calda non è nemmeno una query).
  const windowSteps = await resolveChangeWindowSteps(tenantId, session)
  const row = await runQueryOne<StateRow>(session, loadServiceMapCypher(hops, await suppressionRelTypes(tenantId)), { mapId, tenantId, ...changeWindowParams(windowSteps) })
  if (!row) throw new NotFoundError('ServiceMap', mapId)
  const semantics = await resolveCILifecycleSemantics(tenantId)
  const nodes = row.nodes.map((n) => mapNode(n, mapId, nowMs, windowSteps, semantics))
  const nodeIds = row.props['node_ids']
  if (!Array.isArray(nodeIds)) throw new Error(`ServiceMap ${mapId} has no node_ids — run the 20260910_1080_service_maps_bootstrap migration`)
  const present = new Set(nodes.map((n) => n.ciId))
  const missing = (nodeIds as unknown[]).map(toStr).filter((id) => !present.has(id))
  const version = toNumber(row.props['version'])
  if (!Number.isInteger(version) || version < 1) {
    throw new Error(`ServiceMap ${mapId} has no version (got ${JSON.stringify(row.props['version'])}) — run the 20260910_1080_service_maps_bootstrap migration`)
  }
  return { props: row.props, rules: parseServiceImpactRules(row.props['rules'], mapId), nodes, missing, version }
}

/** Riferimento a un CI per la spiegazione (istantanea): dai nodi caricati; un `via` non più nella mappa resta solo con l'id. */
function causeRef(tenantId: string, id: string, byId: ReadonlyMap<string, LoadedNode>): StoredCause['ci'] {
  const n = byId.get(id)
  if (!n) return { id, name: id, type: 'unknown', health: null }
  return { id, name: n.name, type: ciTypeFromLabels(tenantId, n.labels), health: n.health }
}

/**
 * Cause con i riferimenti ai CI risolti dai nodi caricati (istantanea):
 * la usano la valutazione (che le persiste) e l'anteprima dell'ondata 2 (che
 * non scrive nulla), così la spiegazione ha la stessa forma in entrambe.
 */
export function storedCausesOf(tenantId: string, causes: readonly ImpactCause[], nodes: readonly LoadedNode[]): StoredCause[] {
  const byId = new Map(nodes.map((n) => [n.ciId, n]))
  return causes.map((c) => ({ ...c, ci: causeRef(tenantId, c.ciId, byId), path: c.path.map((id) => causeRef(tenantId, id, byId)) }))
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
  /** Salute senza le finestre di change in corso; valorizzata solo con `health = maintenance`. */
  healthIfActive: ServiceHealth | null
  causes:         StoredCause[]
  /** Esito della riconciliazione dell'incident del servizio; null se la valutazione non era rilevante (salute e cause invariate) o se è stata sospesa. */
  incident:       ServiceIncidentResult | null
  /**
   * Valutazione SOSPESA (revisione 2 · D6.4): una sorgente degli allarmi dei
   * componenti è in tempesta e la mappa ha `during_storm = 'hold'`. Salute,
   * punteggio e spiegazione restano quelli di prima; `healthNote` dice perché.
   */
  held:           boolean
  /** Perché la salute è questa, quando le cause non bastano (tempesta, change a monte); null se non c'è nulla da spiegare. */
  healthNote:     string | null
}

interface WriteRow { id: string; previous: string | null; previousExplanation: unknown; changed: boolean; wasStale: boolean; serviceId: string; name: string; criticality: string | null }

/**
 * Scrittura della valutazione: stato + voce (se la salute cambia) + voce
 * `map_changed` (se la mappa diventa stale) + cap, in uno statement.
 *
 * **Guardia di versione** (revisione 2 · E1): `WHERE m.version = toInteger($version)`,
 * con `$version` letta da `loadServiceMapState`. Se nel frattempo qualcuno ha
 * cambiato la composizione (sincronizzazione, applicazione del diff) la riga non
 * torna e il chiamante ricarica e ricalcola: mai una salute scritta sui nodi di
 * prima. La valutazione NON alza la versione (non è una modifica della
 * configurazione).
 *
 * **`stale` e `stale_reason`**: la valutazione conosce solo i componenti spariti
 * (`missing_ci`). Uno `stale` scritto dalla sincronizzazione perché la proposta
 * supera il tetto (`over_limit`) resta finché la sincronizzazione non riesce:
 * spegnerlo qui nasconderebbe una mappa che nessuno ha ancora sistemato.
 *
 * La riga porta anche la spiegazione PRECEDENTE (letta prima del SET) e la
 * criticità del servizio: servono all'incident del servizio (incident.ts) —
 * la prima per sapere se l'insieme delle cause è cambiato, la seconda per
 * l'impatto dell'incident — senza una lettura in più.
 */
export function evaluationWriteCypher(): string {
  return `
      MATCH (m:ServiceMap {id: $mapId, tenant_id: $tenantId})
      WHERE m.version = toInteger($version)
      WITH m, m.health AS previous, m.explanation AS previousExplanation, coalesce(m.stale, false) AS wasStale,
           coalesce(m.stale_reason = '${SERVICE_STALE_OVER_LIMIT}', false) AS overLimit
      WITH m, previous, previousExplanation, wasStale, overLimit,
           ($stale OR overLimit) AS stale,
           CASE WHEN overLimit THEN '${SERVICE_STALE_OVER_LIMIT}' WHEN $stale THEN '${SERVICE_STALE_MISSING_CI}' ELSE null END AS staleReason
      WITH m, previous, previousExplanation, wasStale, stale, staleReason,
           (previous IS NULL OR previous <> $health) AS changed, (stale AND NOT wasStale) AS becameStale
      SET m.health = $health, m.impact_score = toInteger($impactScore), m.explanation = $explanation, m.evaluated_at = $now,
          m.stale = stale, m.stale_reason = staleReason, m.health_if_active = $healthIfActive, m.health_note = $healthNote,
          m.health_since = CASE WHEN changed THEN $now ELSE m.health_since END
      ${serviceHistoryWriteCypher({ when: 'changed', prefix: 'h', fields: { previousHealth: 'previous' }, cap: false })}
      ${serviceHistoryWriteCypher({ when: 'becameStale', prefix: 'st', fields: { previousHealth: 'previous' }, imports: ['previous', 'wasStale', 'changed', 'becameStale'], capWhen: 'changed OR becameStale' })}
      RETURN m.id AS id, previous, previousExplanation, changed, wasStale, m.service_id AS serviceId, m.name AS name,
             head([(ba:BusinessApplication {tenant_id: $tenantId})-[:HAS_SERVICE_MAP]->(m) | ba.criticality]) AS criticality`
}

/**
 * Valutazione SOSPESA dalla tempesta (revisione 2 · D6.4,
 * `rules.during_storm = 'hold'`): si scrivono SOLO l'istante della
 * valutazione e la nota. Salute, punteggio, spiegazione, `health_since` e
 * `stale` restano quelli di prima — nessuna voce di cronologia, nessun
 * `service.health_changed`, nessun incident aperto o chiuso: 60 allarmi da
 * una sorgente impazzita non sono 60 guasti veri. Stessa guardia di versione
 * della scrittura normale.
 */
export function evaluationHoldWriteCypher(): string {
  return `
      MATCH (m:ServiceMap {id: $mapId, tenant_id: $tenantId})
      WHERE m.version = toInteger($version)
      SET m.evaluated_at = $now, m.health_note = $healthNote
      RETURN m.id AS id, m.health AS health, m.impact_score AS impactScore`
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

/** Quante volte si rilegge e ricalcola quando la versione è cambiata sotto le mani (E1): una gara è normale, due di fila no. */
export const EVALUATION_VERSION_RETRIES = 1

/** Etichetta della metrica `service_evaluations_total` per una valutazione sospesa dalla tempesta (D6.4). */
export const SERVICE_EVALUATION_HELD = 'hold'

/** Le sorgenti in tempesta degli allarmi accesi sui componenti (senza doppioni, in ordine): la causa di una sospensione. */
export function stormingSourcesOf(nodes: readonly LoadedNode[]): string[] {
  return [...new Set(nodes.flatMap((n) => n.stormSources))].sort()
}

/** I componenti coperti da una change su un CI a MONTE, per la nota della mappa (D6.2). */
export function upstreamWindowsOf(nodes: readonly LoadedNode[]): UpstreamWindowRef[] {
  return nodes
    .filter((n) => n.changeWindow?.upstream === true)
    .map((n) => ({ name: n.name || n.ciId, changeCode: n.changeWindow!.code, viaName: n.changeWindow!.viaCiName }))
}

interface HeldEvaluation { health: ServiceHealth; impactScore: number; stormSources: string[] }
interface HoldInput { tenantId: string; mapId: string; now: string; version: number; healthNote: string | null; stormSources: string[]; logCtx: Record<string, unknown> }

/**
 * Scrive la sospensione (nota + `evaluated_at`) e restituisce la salute
 * INVARIATA della mappa; `null` se la guardia di versione non ha scritto (il
 * chiamante rilegge e riprova, come per la scrittura normale).
 */
async function holdEvaluation(session: Queryable, input: HoldInput): Promise<HeldEvaluation | null> {
  const row = await runQueryOne<{ id: string; health: string | null; impactScore: unknown }>(session, evaluationHoldWriteCypher(), {
    mapId: input.mapId, tenantId: input.tenantId, now: input.now, version: input.version, healthNote: input.healthNote,
  })
  if (!row) return null
  return {
    health: assertEnum<ServiceHealth>(row.health, SERVICE_HEALTHS, `ServiceMap ${input.mapId} health`),
    impactScore: toNumber(row.impactScore),
    stormSources: input.stormSources,
  }
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
    // `!`: il ciclo qui sotto gira sempre almeno una volta (o lancia), ma il
    // compilatore non lo sa.
    let state!: ServiceMapState
    let row: WriteRow | null = null
    let causes: StoredCause[] = []
    let result!: ReturnType<typeof evaluateImpact>
    let healthNote: string | null = null
    let held: HeldEvaluation | null = null
    try {
      // Gara con una scrittura di configurazione (E1): la guardia di versione
      // non fa scrivere nulla, si rilegge lo stato di adesso e si ricalcola.
      // UNA volta: due versioni diverse di fila su una mappa sola non è una
      // gara, è qualcosa che non torna e deve emergere.
      for (let attempt = 0; ; attempt++) {
        state = await loadServiceMapState(session, tenantId, mapId, now)
        result = evaluateImpact(state.nodes, state.rules)
        causes = storedCausesOf(tenantId, result.causes, state.nodes)
        const stormSources = stormingSourcesOf(state.nodes)
        // D6.4: sorgente in tempesta e regola `hold` → la valutazione è
        // sospesa. Si scrive solo la nota (e `evaluated_at`, così la passata
        // periodica non ci ritorna sopra ogni minuto).
        healthNote = serviceHealthNote({ held: state.rules.during_storm === 'hold' && stormSources.length > 0, stormSources, upstreamWindows: upstreamWindowsOf(state.nodes) })
        if (state.rules.during_storm === 'hold' && stormSources.length > 0) {
          held = await holdEvaluation(session, { tenantId, mapId, now, version: state.version, healthNote, stormSources, logCtx })
          if (held) break
          if (attempt >= EVALUATION_VERSION_RETRIES) {
            throw new Error(`ServiceMap ${mapId} changed while suspending its evaluation (expected version ${state.version}, ${attempt + 1} attempts): nothing was written (tenant ${tenantId})`)
          }
          log.info({ ...logCtx, version: state.version }, 'Service map changed while evaluating: reloading and recomputing once')
          continue
        }
        const stale = state.missing.length > 0
        const staleNote = stale ? `Componenti non più presenti nella CMDB: ${state.missing.join(', ')}` : null
        const explanation = JSON.stringify(causes)
        row = await runQueryOne<WriteRow>(session, evaluationWriteCypher(), {
          mapId, tenantId, now, stale, version: state.version, healthNote,
          health: result.health, healthIfActive: result.healthIfActive, impactScore: result.impactScore, explanation,
          ...serviceHistoryParams({ trigger, health: result.health, previousHealth: null, impactScore: result.impactScore, causes }, now, 'h'),
          ...serviceHistoryParams({ trigger: 'map_changed', health: result.health, previousHealth: null, impactScore: result.impactScore, causes, note: staleNote }, now, 'st'),
        })
        if (row) break
        if (attempt >= EVALUATION_VERSION_RETRIES) {
          throw new Error(`ServiceMap ${mapId} changed while writing its evaluation (expected version ${state.version}, ${attempt + 1} attempts): nothing was written (tenant ${tenantId})`)
        }
        log.info({ ...logCtx, version: state.version }, 'Service map changed while evaluating: reloading and recomputing once')
      }
    } finally {
      await session.close()
    }
    // Valutazione sospesa: la salute resta quella scritta, nessun evento di
    // dominio, nessun incident. La rivalutazione arriva alla fine della
    // tempesta (consumers/serviceImpactConsumer.ts) o dalla passata periodica.
    if (held) {
      serviceEvaluationsTotal.inc({ result: SERVICE_EVALUATION_HELD })
      log.warn({ ...logCtx, stormSources: held.stormSources, health: held.health }, 'Service map evaluation suspended: an alert source of its components is storming')
      return {
        mapId, health: held.health, previousHealth: held.health, impactScore: held.impactScore,
        changed: false, stale: state.missing.length > 0, healthIfActive: null, causes: [], incident: null,
        held: true, healthNote,
      }
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
    return { mapId, health: result.health, previousHealth: previous, impactScore: result.impactScore, changed, stale, healthIfActive: result.healthIfActive, causes, incident, held: false, healthNote }
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
  /** Mappa viva (default true, ondata 5) o congelata: `false` = solo diff applicato a mano. */
  autoSync?:         boolean
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
  const autoSync = input.autoSync ?? true
  if (typeof autoSync !== 'boolean') throw new ValidationError(`autoSync must be a boolean. Got: ${JSON.stringify(input.autoSync)}`)
  const mapId = uuidv4()
  const session = getSession(undefined, 'WRITE')
  let proposal: ServiceMapProposal
  try {
    await assertServiceMapPlanLimit(session, input.tenantId)
    proposal = await buildServiceMap(session, input.tenantId, input.serviceId, input.maxDepth, input.relationshipTypes)
    await session.executeWrite((tx) => createServiceMapNode(tx, { tenantId: input.tenantId, serviceId: input.serviceId, mapId, status, autoSync, proposal, actorId: input.actorId, now }))
  } finally {
    await session.close()
  }
  log.info({ tenantId: input.tenantId, serviceId: input.serviceId, mapId, nodes: proposal.nodes.length, maxDepth: proposal.maxDepth, relationshipTypes: proposal.relationshipTypes, autoSync, actorId: input.actorId }, 'Service map created')
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
    const rows = await runQuery<{ health: string | null; n: unknown; stale: unknown }>(session, `
      // tenant-ok: metrica di processo su tutti i tenant (solo conteggi, nessuna scrittura)
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
