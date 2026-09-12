/**
 * Servizi monitorati — configurazione della mappa dall'interfaccia (ondata 2).
 *
 * Ondata 1: la mappa nasceva dalla costruzione automatica e restava com'era.
 * Qui l'amministratore cambia le regole d'impatto, le impostazioni dei
 * componenti (`propagate`, `weight`, `critical`) e la composizione (diff con
 * il grafo di adesso: nuovi, spariti, spostati, esclusi), senza toccare il
 * codice.
 *
 * Contratto, uguale per ogni scrittura:
 *   - `expectedVersion` = la `version` letta dal client. Diversa → BAD_USER_INPUT
 *     con la versione attuale (mai una sovrascrittura silenziosa). Il controllo
 *     è nel Cypher (`WHERE version = toInteger($expectedVersion)`) E in
 *     TypeScript prima di lavorare, solo per dare un messaggio utile.
 *   - una transazione sola: lettura di controllo + scrittura; un conteggio che
 *     non torna (un CI sparito fra il diff e la scrittura) fa fallire la
 *     transazione, non scrive metà lavoro.
 *   - `version + 1`, `updated_at`/`updated_by`, UNA voce di cronologia con nota
 *     leggibile scritta NELLO STESSO statement (`rules_changed` per il calcolo,
 *     `map_changed` per la composizione), audit a carico del resolver.
 *   - **rivalutazione immediata** con lo stesso trigger, tranne per le mappe
 *     `paused` (nessuna valutazione automatica: la salute resta l'ultima nota).
 *
 * L'anteprima (`previewServiceImpact`) è calcolo puro sugli allarmi di adesso:
 * carica lo stato reale, applica le sostituzioni e chiama `evaluateImpact`.
 * NON scrive nulla.
 *
 * Progetto: scratchpad service-impact-opengrafo.html, ondata 2.
 */
import { getSession, runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import { ValidationError } from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import {
  NODE_PROPAGATIONS, NODE_WEIGHT_MAX, NODE_WEIGHT_MIN, SERVICE_EXCLUSION_REASON_MANUAL, SERVICE_MAP_MAX_NODES,
  SERVICE_MAP_STATUSES, SERVICE_STALE_MISSING_CI, assertServiceImpactRules, isRetiredLifecycle,
  type DuringStormMode, type NodePropagation, type ServiceHealth, type ServiceImpactRules, type ServiceMapStatus,
  type ServiceOpenIncidentFrom, type UnknownNodesMode,
} from '../../lib/serviceVocabularies.js'
import { toNumber, toStr, type Props } from '../events/shared.js'
import { buildServiceMap, type ProposedNode } from './build.js'
import { evaluateImpact, nodeContributes } from './rules.js'
import { evaluateServiceMap, loadServiceMapState, storedCausesOf, type EvaluateResult, type LoadedNode, type ServiceMapState } from './engine.js'
import { SERVICE_HISTORY_STATE_FROM_MAP, serviceConfigHistoryParams, serviceHistoryWriteCypher, type StoredCause } from './history.js'

const log = logger.child({ module: 'service-impact' })

function toStrOrNull(v: unknown): string | null { return v == null ? null : toStr(v) }

// ── Input (camelCase come lo SDL) ────────────────────────────────────────────

/** `input ServiceImpactRulesInput` dello SDL. */
export interface ServiceImpactRulesInput {
  downSharePct:     number
  degradedSharePct: number
  minNodes:         number
  unknownNodes:     UnknownNodesMode
  openIncidentFrom: ServiceOpenIncidentFrom
  /** Cosa fare mentre una sorgente degli allarmi dei componenti è in tempesta (revisione 2 · D6.4). */
  duringStorm:      DuringStormMode
}

/** `input ServiceMapNodeInput` dello SDL: ciò che l'amministratore può cambiare su un componente (ruolo, livello e via restano della mappa). */
export interface ServiceMapNodeInput {
  ciId:      string
  propagate: NodePropagation
  weight:    number
  critical:  boolean
}

// ── Validazione ──────────────────────────────────────────────────────────────

/** `expectedVersion` intera ≥ 1 (come `setServiceMapStatus`). */
export function assertExpectedVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new ValidationError(`expectedVersion must be an integer >= 1. Got: ${JSON.stringify(value)}`)
  }
  return value as number
}

/** Messaggio unico del conflitto di versione (lo usa anche `setServiceMapStatus`). */
export function serviceMapConflictMessage(mapId: string, expectedVersion: number, currentVersion: number, updatedAt: string | null): string {
  return `ServiceMap ${mapId} was modified by someone else (expected version ${expectedVersion}, current is ${currentVersion}, updated at ${updatedAt ?? 'n/a'}): reload and retry`
}

function assertVersionMatches(props: Props, mapId: string, expectedVersion: number): number {
  const version = toNumber(props['version'])
  if (version !== expectedVersion) {
    throw new ValidationError(serviceMapConflictMessage(mapId, expectedVersion, version, toStrOrNull(props['updated_at'])))
  }
  return version
}

/**
 * Regole dall'interfaccia → regole validate (snake_case, quelle del motore).
 * Oltre ai vocabolari e alle scale di `assertServiceImpactRules`, due limiti di
 * coerenza che solo qui hanno senso:
 *   - `degraded_share_pct` ≤ `down_share_pct`: altrimenti «degradato» non si
 *     raggiunge mai prima di «giù» e la soglia è morta;
 *   - `min_nodes` ≤ numero di componenti della mappa (almeno 1): un minimo più
 *     alto dei componenti significa «mai degradato», quasi sempre un errore di
 *     battitura. Si sceglie il numero di nodi (non un tetto fisso) perché è il
 *     dato che l'amministratore ha davanti.
 */
export function assertServiceImpactRulesInput(input: ServiceImpactRulesInput, nodeCount: number): ServiceImpactRules {
  if (input == null || typeof input !== 'object') throw new ValidationError(`rules must be an object. Got: ${JSON.stringify(input)}`)
  let rules: ServiceImpactRules
  try {
    rules = assertServiceImpactRules({
      version:            1,
      down_share_pct:     input.downSharePct,
      degraded_share_pct: input.degradedSharePct,
      min_nodes:          input.minNodes,
      unknown_nodes:      input.unknownNodes,
      open_incident_from: input.openIncidentFrom,
      during_storm:       input.duringStorm,
    }, 'rules')
  } catch (err) {
    throw new ValidationError(err instanceof Error ? err.message : String(err))
  }
  if (rules.degraded_share_pct > rules.down_share_pct) {
    throw new ValidationError(`rules.degraded_share_pct (${rules.degraded_share_pct}) must be <= rules.down_share_pct (${rules.down_share_pct}): otherwise the service would never be degraded before being down`)
  }
  const maxMinNodes = Math.max(nodeCount, 1)
  if (rules.min_nodes > maxMinNodes) {
    throw new ValidationError(`rules.min_nodes (${rules.min_nodes}) must be <= the number of components of the map (${maxMinNodes}): a higher minimum means the service can never be degraded`)
  }
  return rules
}

/** Impostazioni dei componenti dall'interfaccia: elenco non vuoto, senza doppioni, valori nei vocabolari e peso 1..10. */
export function assertServiceMapNodeInputs(nodes: readonly ServiceMapNodeInput[]): ServiceMapNodeInput[] {
  if (!Array.isArray(nodes) || nodes.length === 0) throw new ValidationError('nodes must not be empty: pass the components you changed')
  const seen = new Set<string>()
  for (const n of nodes) {
    if (n == null || typeof n !== 'object') throw new ValidationError(`nodes: ${JSON.stringify(n)} is not a component`)
    if (typeof n.ciId !== 'string' || n.ciId === '') throw new ValidationError(`nodes: ciId must be a non-empty id. Got: ${JSON.stringify(n.ciId)}`)
    if (seen.has(n.ciId)) throw new ValidationError(`nodes: ${n.ciId} appears twice`)
    seen.add(n.ciId)
    if (!(NODE_PROPAGATIONS as readonly string[]).includes(n.propagate)) {
      throw new ValidationError(`nodes[${n.ciId}].propagate must be one of: ${NODE_PROPAGATIONS.join(', ')}. Got: ${JSON.stringify(n.propagate)}`)
    }
    if (!Number.isInteger(n.weight) || n.weight < NODE_WEIGHT_MIN || n.weight > NODE_WEIGHT_MAX) {
      throw new ValidationError(`nodes[${n.ciId}].weight must be an integer between ${NODE_WEIGHT_MIN} and ${NODE_WEIGHT_MAX}. Got: ${JSON.stringify(n.weight)}`)
    }
    if (typeof n.critical !== 'boolean') throw new ValidationError(`nodes[${n.ciId}].critical must be a boolean. Got: ${JSON.stringify(n.critical)}`)
  }
  return [...nodes]
}

/** Elenco di id: nessun doppione, ogni id appartiene all'insieme ammesso (altrimenti l'id nel messaggio). */
function assertIds(ids: readonly string[], allowed: ReadonlySet<string>, field: string, what: string): string[] {
  const seen = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') throw new ValidationError(`${field}: ${JSON.stringify(id)} is not an id`)
    if (seen.has(id)) throw new ValidationError(`${field}: ${id} appears twice`)
    seen.add(id)
    if (!allowed.has(id)) throw new ValidationError(`${field}: ${id} is not ${what}`)
  }
  return [...ids]
}

// ── Note leggibili per la cronologia ─────────────────────────────────────────

const RULE_LABELS: Readonly<Record<Exclude<keyof ServiceImpactRules, 'version'>, string>> = {
  down_share_pct:     'soglia giù',
  degraded_share_pct: 'soglia degradato',
  min_nodes:          'minimo componenti',
  unknown_nodes:      'componenti senza salute',
  open_incident_from: 'apri incident da',
  during_storm:       'durante una tempesta',
}
const UNKNOWN_NODES_LABELS: Readonly<Record<UnknownNodesMode, string>> = { ignore: 'ignorati', operational: 'operativi' }
const OPEN_INCIDENT_LABELS: Readonly<Record<ServiceOpenIncidentFrom, string>> = { never: 'mai', down: 'giù', degraded: 'degradato' }
const DURING_STORM_LABELS: Readonly<Record<DuringStormMode, string>> = { hold: 'sospendi la valutazione', evaluate: 'valuta comunque' }

function ruleValueLabel(field: Exclude<keyof ServiceImpactRules, 'version'>, rules: ServiceImpactRules): string {
  if (field === 'unknown_nodes') return UNKNOWN_NODES_LABELS[rules.unknown_nodes]
  if (field === 'open_incident_from') return OPEN_INCIDENT_LABELS[rules.open_incident_from]
  if (field === 'during_storm') return DURING_STORM_LABELS[rules.during_storm]
  return String(rules[field])
}

/**
 * «Regole aggiornate: soglia giù 50 → 70, minimo componenti 1 → 2».
 * Nessun campo cambiato → ValidationError: una scrittura che non cambia nulla
 * alzerebbe la versione (facendo fallire i client che l'hanno già letta) e
 * lascerebbe una voce di cronologia senza contenuto.
 */
export function serviceRulesChangeNote(before: ServiceImpactRules, after: ServiceImpactRules): string {
  const parts = (Object.keys(RULE_LABELS) as Exclude<keyof ServiceImpactRules, 'version'>[])
    .filter((f) => before[f] !== after[f])
    .map((f) => `${RULE_LABELS[f]} ${ruleValueLabel(f, before)} → ${ruleValueLabel(f, after)}`)
  if (parts.length === 0) throw new ValidationError('rules are identical to the current ones: nothing to save')
  return `Regole aggiornate: ${parts.join(', ')}`
}

/** «3 componenti aggiornati: APP-003, DB-01, …». */
export function serviceNodesChangeNote(names: readonly string[]): string {
  const shown = names.slice(0, 3)
  const rest = names.length - shown.length
  return `${names.length} ${names.length === 1 ? 'componente aggiornato' : 'componenti aggiornati'}: ${shown.join(', ')}${rest > 0 ? `, e altri ${rest}` : ''}`
}

// ── Esclusioni (EXCLUDES) ────────────────────────────────────────────────────

/** Riferimento a un CI escluso (la forma di `ConfigurationItemRef`, tipo risolto dal resolver). */
export interface ExcludedCIRow { id: string; name: string | null; labels: string[]; status: string | null; health: string | null }

export const SERVICE_MAP_EXCLUSIONS_CYPHER = `
  MATCH (m:ServiceMap {id: $mapId, tenant_id: $tenantId})-[:EXCLUDES]->(ci {tenant_id: $tenantId})
  RETURN ci.id AS id, ci.name AS name, [l IN labels(ci) WHERE l <> 'ConfigurationItem'] AS labels,
         ci.status AS status, ci.health AS health
  ORDER BY ci.name, ci.id`

/** I CI che l'amministratore ha escluso: non vengono più riproposti dal diff. */
export async function loadServiceMapExclusions(session: Queryable, tenantId: string, mapId: string): Promise<ExcludedCIRow[]> {
  return runQuery<ExcludedCIRow>(session, SERVICE_MAP_EXCLUSIONS_CYPHER, { mapId, tenantId })
}

// ── Diff fra la mappa e il grafo di adesso ───────────────────────────────────

export interface MovedNode { node: LoadedNode; proposedLevel: number; proposedVia: string | null }

/**
 * Perché un componente è proposto in rimozione: `unreachable` (non più
 * raggiungibile dal servizio, oppure il CI non esiste più nella CMDB) o
 * `lifecycle` (il CI è dismesso o fuori servizio — revisione 2 · D6.3: non
 * conta più nel calcolo e va tolto, ma lo decide una persona: la
 * sincronizzazione automatica non lo toglie, lo dice soltanto).
 */
export type RemovedReason = 'unreachable' | 'lifecycle'

/** Un componente da togliere: `node` è null quando il CI non esiste più (della mappa resta solo l'id in `node_ids`). */
export interface RemovedNode { ciId: string; node: LoadedNode | null; reason: RemovedReason }

export interface ServiceMapDiff {
  mapId:             string
  version:           number
  status:            ServiceMapStatus
  updatedAt:         string | null
  maxDepth:          number
  relationshipTypes: string[]
  /** Nel grafo, non nella mappa, non esclusi. */
  added:             ProposedNode[]
  /** Nella mappa, non più raggiungibili, oppure spariti dalla CMDB (`node` null). */
  removed:           RemovedNode[]
  /** In entrambi, con livello o via diversi. */
  moved:             MovedNode[]
  excluded:          ExcludedCIRow[]
  /** Nodi che la mappa avrebbe seguendo la proposta (esclusioni tolte): serve al tetto di 500. */
  totalProposed:     number
  /** Interni (non nello SDL): servono ad `applyServiceMapProposal`. */
  proposed:          ProposedNode[]
  currentIds:        string[]
  missing:           string[]
  rules:             ServiceImpactRules
  nodeCount:         number
}

/** Diff nella sessione (o transazione) del chiamante: nessuna scrittura. Mappa assente → NotFoundError. */
export async function computeServiceMapDiff(session: Queryable, tenantId: string, mapId: string, now: string): Promise<ServiceMapDiff> {
  const state = await loadServiceMapState(session, tenantId, mapId, now)
  const props = state.props
  const serviceId = toStr(props['service_id'])
  if (!serviceId) throw new Error(`ServiceMap ${mapId} has no service_id — run the 20260910_1080_service_maps_bootstrap migration`)
  const relationshipTypes = props['relationship_types']
  if (!Array.isArray(relationshipTypes)) throw new Error(`ServiceMap ${mapId} has no relationship_types — run the 20260910_1080_service_maps_bootstrap migration`)
  const maxDepth = toNumber(props['max_depth'])
  const status = assertStatus(props['status'], mapId)

  const proposal = await buildServiceMap(session, tenantId, serviceId, maxDepth, relationshipTypes.map(toStr))
  const excluded = await loadServiceMapExclusions(session, tenantId, mapId)

  const excludedIds = new Set(excluded.map((e) => e.id))
  const current = new Map(state.nodes.map((n) => [n.ciId, n]))
  const reachable = new Map(proposal.nodes.map((n) => [n.ciId, n]))
  // Un CI escluso non viene mai riproposto; resta però nel confronto di
  // raggiungibilità (un nodo incluso ed escluso non è «sparito dal grafo»).
  // Revisione 2 · D6.3: un CI dismesso non si propone come componente nuovo —
  // non conterebbe comunque.
  const proposable = proposal.nodes.filter((n) => !excludedIds.has(n.ciId) && !isRetiredLifecycle(n.status))

  const added = proposable.filter((n) => !current.has(n.ciId))
  const moved: MovedNode[] = []
  for (const node of state.nodes) {
    if (node.lifecycleRetired) continue   // si propone di toglierlo: spostarlo non ha senso
    const p = reachable.get(node.ciId)
    if (!p) continue
    if (p.level !== node.level || (p.via ?? null) !== (node.via ?? null)) {
      moved.push({ node, proposedLevel: p.level, proposedVia: p.via })
    }
  }
  const removed: RemovedNode[] = [
    ...state.nodes.filter((n) => !reachable.has(n.ciId) && !n.lifecycleRetired).map((node) => ({ ciId: node.ciId, node, reason: 'unreachable' as const })),
    // Componenti dismessi: segnalati come da togliere (non contano più nel
    // calcolo), ma li toglie una persona applicando il diff.
    ...state.nodes.filter((n) => n.lifecycleRetired).map((node) => ({ ciId: node.ciId, node, reason: 'lifecycle' as const })),
    ...state.missing.map((ciId) => ({ ciId, node: null, reason: 'unreachable' as const })),
  ]

  return {
    mapId, status, version: toNumber(props['version']), updatedAt: toStrOrNull(props['updated_at']),
    maxDepth: proposal.maxDepth, relationshipTypes: [...proposal.relationshipTypes],
    added, removed, moved, excluded, totalProposed: proposable.length,
    proposed: proposal.nodes, currentIds: [...current.keys()], missing: state.missing,
    rules: state.rules, nodeCount: state.nodes.length,
  }
}

function assertStatus(value: unknown, mapId: string): ServiceMapStatus {
  if (typeof value !== 'string' || !(SERVICE_MAP_STATUSES as readonly string[]).includes(value)) {
    throw new Error(`ServiceMap ${mapId} status is ${JSON.stringify(value)}: expected one of ${SERVICE_MAP_STATUSES.join(', ')}`)
  }
  return value as ServiceMapStatus
}

/** Diff con sessione propria (resolver `serviceMapProposal`). */
export async function serviceMapProposal(tenantId: string, mapId: string, now: string = new Date().toISOString()): Promise<ServiceMapDiff> {
  const session = getSession()
  try {
    return await computeServiceMapDiff(session, tenantId, mapId, now)
  } finally { await session.close() }
}

// ── Anteprima (nessuna scrittura) ────────────────────────────────────────────

export interface ServiceImpactPreview {
  health:            ServiceHealth
  impactScore:       number
  causes:            StoredCause[]
  /** Componenti che pesano nel calcolo con queste impostazioni. */
  contributingCount: number
  nodeCount:         number
}

export interface PreviewInput {
  tenantId: string
  mapId:    string
  rules?:   ServiceImpactRulesInput | null
  nodes?:   readonly ServiceMapNodeInput[] | null
  now?:     string
}

/**
 * «Con queste impostazioni adesso»: stato reale della mappa (allarmi e finestre
 * di change di questo istante) con le sostituzioni passate applicate in
 * memoria. Un `ciId` non nella mappa → ValidationError (mai ignorato).
 */
export async function previewServiceImpact(input: PreviewInput): Promise<ServiceImpactPreview> {
  const now = input.now ?? new Date().toISOString()
  const session = getSession()
  let state: ServiceMapState
  try {
    state = await loadServiceMapState(session, input.tenantId, input.mapId, now)
  } finally { await session.close() }

  const rules = input.rules ? assertServiceImpactRulesInput(input.rules, state.nodes.length) : state.rules
  let nodes = state.nodes
  if (input.nodes?.length) {
    const overrides = new Map(assertServiceMapNodeInputs(input.nodes).map((n) => [n.ciId, n]))
    const known = new Set(state.nodes.map((n) => n.ciId))
    for (const ciId of overrides.keys()) {
      if (!known.has(ciId)) throw new ValidationError(`nodes: ${ciId} is not a component of ServiceMap ${input.mapId}`)
    }
    nodes = state.nodes.map((n) => {
      const o = overrides.get(n.ciId)
      return o ? { ...n, propagate: o.propagate, weight: o.weight, critical: o.critical } : n
    })
  }

  const result = evaluateImpact(nodes, rules)
  return {
    health:            result.health,
    impactScore:       result.impactScore,
    causes:            storedCausesOf(input.tenantId, result.causes, nodes),
    contributingCount: nodes.filter((n) => nodeContributes(n, rules)).length,
    nodeCount:         nodes.length,
  }
}

// ── Scritture ────────────────────────────────────────────────────────────────

export interface ConfigWriteResult {
  mapId:      string
  version:    number
  status:     ServiceMapStatus
  note:       string
  /** Esito della rivalutazione immediata; null per le mappe in pausa (non valutate automaticamente). */
  evaluation: EvaluateResult | null
}

/**
 * Frammento comune: guardia di versione, poi la scrittura del chiamante.
 *
 * Il `SET` viene PRIMA del confronto (revisione 2 · X1): in Neo4j il lock di
 * scrittura sul nodo si prende al `SET`, e un `WHERE` valutato prima legge una
 * versione che un altro scrittore può cambiare nel frattempo (due scritture
 * entrambe «riuscite», `node_ids` incoerente con le INCLUDES). Qui il `SET`
 * prende il lock e il `WHERE` successivo legge il valore vero; nessuna riga →
 * `requireWriteRow` lancia e la transazione — incremento compreso — viene
 * annullata. Dopo la guardia `version` è già la versione NUOVA.
 */
const VERSION_GUARD = `
  MATCH (m:ServiceMap {id: $mapId, tenant_id: $tenantId})
  SET m.version = m.version + 1
  WITH m, m.version AS version
  WHERE version = toInteger($expectedVersion) + 1`

/**
 * Coda comune: istante, autore e la voce di cronologia con la nota (la versione
 * l'ha già alzata la guardia). Il trigger (`rules_changed` / `map_changed`)
 * viaggia come parametro `$hTrigger`: la forma dello statement è la stessa per
 * tutte le scritture.
 */
const CONFIG_WRITE_TAIL = `
  SET m.updated_at = $now, m.updated_by = $actorId
  ${serviceHistoryWriteCypher({ fields: SERVICE_HISTORY_STATE_FROM_MAP })}`

export const UPDATE_RULES_CYPHER = `${VERSION_GUARD}
  SET m.rules = $rules
  ${CONFIG_WRITE_TAIL}
  RETURN m.version AS version, m.status AS status`

export const UPDATE_NODES_CYPHER = `${VERSION_GUARD}
  CALL {
    WITH m
    UNWIND $nodes AS n
    MATCH (m)-[inc:INCLUDES]->(ci {id: n.ciId, tenant_id: $tenantId})
    SET inc.propagate = n.propagate, inc.weight = toInteger(n.weight), inc.critical = n.critical
    RETURN count(inc) AS updated
  }
  ${CONFIG_WRITE_TAIL}
  RETURN m.version AS version, m.status AS status, updated`

/**
 * Applica il diff in uno statement: aggiunge le INCLUDES scelte (con le
 * impostazioni proposte, `added_by: 'manual'`), crea le EXCLUDES, toglie le
 * INCLUDES da rimuovere, ricalcola `node_ids` dalle INCLUDES rimaste più gli
 * id spariti che l'amministratore ha deciso di tenere (`stale` di conseguenza).
 */
export const APPLY_PROPOSAL_CYPHER = `${VERSION_GUARD}
  CALL {
    WITH m
    UNWIND $addNodes AS n
    MATCH (ci {id: n.ciId, tenant_id: $tenantId})
    CREATE (m)-[:INCLUDES {level: toInteger(n.level), role: n.role, propagate: n.propagate, weight: toInteger(n.weight),
                           critical: n.critical, via: n.via, added_by: 'manual', added_at: $now}]->(ci)
    RETURN count(ci) AS added
  }
  CALL {
    WITH m
    UNWIND $excludeIds AS xid
    MATCH (ci {id: xid, tenant_id: $tenantId})
    MERGE (m)-[e:EXCLUDES]->(ci)
      ON CREATE SET e.reason = $excludeReason, e.excluded_by = $actorId, e.at = $now
    RETURN count(ci) AS excluded
  }
  CALL {
    WITH m
    UNWIND $removeIds AS rid
    OPTIONAL MATCH (m)-[inc:INCLUDES]->(ci {id: rid, tenant_id: $tenantId})
    WITH collect(inc) AS incs
    FOREACH (x IN incs | DELETE x)
    RETURN size(incs) AS removed
  }
  WITH m, version, added, excluded, removed, [(m)-[:INCLUDES]->(ci {tenant_id: $tenantId}) | ci.id] AS includedIds
  SET m.node_ids = includedIds + $keepMissing, m.stale = size($keepMissing) > 0,
      m.stale_reason = CASE WHEN size($keepMissing) > 0 THEN '${SERVICE_STALE_MISSING_CI}' ELSE null END
  ${CONFIG_WRITE_TAIL}
  RETURN m.version AS version, m.status AS status, added, excluded, removed, size(includedIds) AS included`

/** Interruttore della mappa viva (ondata 5): solo `auto_sync`, con la stessa coda comune (versione, autore, voce di cronologia). */
export const SET_AUTO_SYNC_CYPHER = `${VERSION_GUARD}
  SET m.auto_sync = $autoSync
  ${CONFIG_WRITE_TAIL}
  RETURN m.version AS version, m.status AS status`

export const REMOVE_EXCLUSION_CYPHER = `${VERSION_GUARD}
  CALL {
    WITH m
    MATCH (m)-[e:EXCLUDES]->(ci {id: $ciId, tenant_id: $tenantId})
    WITH collect(e) AS excludes
    FOREACH (x IN excludes | DELETE x)
    RETURN size(excludes) AS removed
  }
  ${CONFIG_WRITE_TAIL}
  RETURN m.version AS version, m.status AS status, removed`

interface WriteRow { version: unknown; status: string }

/** La riga della scrittura, o l'errore giusto se lo statement non ha scritto (versione cambiata sotto le mani, o mappa sparita). */
function requireWriteRow<T extends WriteRow>(row: T | null, mapId: string, expectedVersion: number): T {
  if (!row) throw new Error(`ServiceMap ${mapId} changed while writing its configuration (expected version ${expectedVersion}): the transaction was rolled back`)
  return row
}

export interface ConfigWriteInput {
  tenantId:        string
  mapId:           string
  expectedVersion: number
  actorId:         string
  now?:            string
}

/** Regole d'impatto (soglie, componenti senza salute, apertura incident). */
export async function updateServiceImpactRules(input: ConfigWriteInput & { rules: ServiceImpactRulesInput }): Promise<ConfigWriteResult> {
  const now = input.now ?? new Date().toISOString()
  assertExpectedVersion(input.expectedVersion)
  const session = getSession(undefined, 'WRITE')
  let written: { version: number; status: ServiceMapStatus; note: string }
  try {
    written = await session.executeWrite(async (tx) => {
      const state = await loadServiceMapState(tx, input.tenantId, input.mapId, now)
      assertVersionMatches(state.props, input.mapId, input.expectedVersion)
      const rules = assertServiceImpactRulesInput(input.rules, state.nodes.length)
      const note = serviceRulesChangeNote(state.rules, rules)
      const row = requireWriteRow(await runQueryOne<WriteRow>(tx, UPDATE_RULES_CYPHER, {
        mapId: input.mapId, tenantId: input.tenantId, expectedVersion: input.expectedVersion,
        rules: JSON.stringify(rules), now, actorId: input.actorId,
        ...serviceConfigHistoryParams('rules_changed', note, now),
      }), input.mapId, input.expectedVersion)
      return { version: toNumber(row.version), status: assertStatus(row.status, input.mapId), note }
    })
  } finally { await session.close() }
  log.info({ tenantId: input.tenantId, mapId: input.mapId, version: written.version, note: written.note }, 'Service impact rules updated')
  return finish(input, written, 'rules_changed')
}

/** Impostazioni dei componenti: SOLO `propagate`, `weight`, `critical` sulle INCLUDES passate (ruolo, livello e via restano della mappa). */
export async function updateServiceMapNodes(input: ConfigWriteInput & { nodes: readonly ServiceMapNodeInput[] }): Promise<ConfigWriteResult> {
  const now = input.now ?? new Date().toISOString()
  assertExpectedVersion(input.expectedVersion)
  const nodes = assertServiceMapNodeInputs(input.nodes)
  const session = getSession(undefined, 'WRITE')
  let written: { version: number; status: ServiceMapStatus; note: string }
  try {
    written = await session.executeWrite(async (tx) => {
      const state = await loadServiceMapState(tx, input.tenantId, input.mapId, now)
      assertVersionMatches(state.props, input.mapId, input.expectedVersion)
      const byId = new Map(state.nodes.map((n) => [n.ciId, n]))
      const unknown = nodes.filter((n) => !byId.has(n.ciId)).map((n) => n.ciId)
      if (unknown.length) throw new ValidationError(`nodes: ${unknown.join(', ')} ${unknown.length === 1 ? 'is not a component' : 'are not components'} of ServiceMap ${input.mapId}`)
      const note = serviceNodesChangeNote(nodes.map((n) => byId.get(n.ciId)!.name || n.ciId))
      const row = requireWriteRow(await runQueryOne<WriteRow & { updated: unknown }>(tx, UPDATE_NODES_CYPHER, {
        mapId: input.mapId, tenantId: input.tenantId, expectedVersion: input.expectedVersion,
        nodes: nodes.map((n) => ({ ciId: n.ciId, propagate: n.propagate, weight: n.weight, critical: n.critical })),
        now, actorId: input.actorId,
        ...serviceConfigHistoryParams('rules_changed', note, now),
      }), input.mapId, input.expectedVersion)
      const updated = toNumber(row.updated)
      if (updated !== nodes.length) {
        throw new Error(`ServiceMap ${input.mapId}: ${updated} of ${nodes.length} components could be updated (a component left the map while writing)`)
      }
      return { version: toNumber(row.version), status: assertStatus(row.status, input.mapId), note }
    })
  } finally { await session.close() }
  log.info({ tenantId: input.tenantId, mapId: input.mapId, version: written.version, nodes: nodes.length }, 'Service map node settings updated')
  return finish(input, written, 'rules_changed')
}

export interface ApplyProposalInput extends ConfigWriteInput {
  /** CI della proposta da includere (con le impostazioni proposte). */
  add:     readonly string[]
  /** CI da non riproporre mai più (e da togliere, se erano inclusi). */
  exclude: readonly string[]
  /** CI attualmente inclusi (o spariti dal grafo) da togliere. */
  remove:  readonly string[]
}

/** Applica le scelte fatte sul diff: aggiunte, esclusioni e rimozioni in una transazione. */
export async function applyServiceMapProposal(input: ApplyProposalInput): Promise<ConfigWriteResult> {
  const now = input.now ?? new Date().toISOString()
  assertExpectedVersion(input.expectedVersion)
  const session = getSession(undefined, 'WRITE')
  let written: { version: number; status: ServiceMapStatus; note: string }
  try {
    written = await session.executeWrite(async (tx) => {
      const diff = await computeServiceMapDiff(tx, input.tenantId, input.mapId, now)
      assertVersionMatches({ version: diff.version, updated_at: diff.updatedAt }, input.mapId, input.expectedVersion)

      const currentIds = new Set(diff.currentIds)
      const addable = new Map(diff.added.map((n) => [n.ciId, n]))
      const excludable = new Set([...diff.proposed.map((n) => n.ciId), ...currentIds])
      const removable = new Set([...currentIds, ...diff.missing])
      const add     = assertIds(input.add,     new Set(addable.keys()), 'add',     'a component of the proposal (added)')
      const exclude = assertIds(input.exclude, excludable,              'exclude', 'a component of the proposal or of the map')
      const remove  = assertIds(input.remove,  removable,               'remove',  'a component of the map')
      if (add.length + exclude.length + remove.length === 0) throw new ValidationError('add, exclude and remove are all empty: nothing to apply')
      const overlap = [...add, ...exclude, ...remove].filter((id, i, all) => all.indexOf(id) !== i)
      if (overlap.length) throw new ValidationError(`add, exclude and remove must be disjoint: ${[...new Set(overlap)].join(', ')} appears in more than one list`)

      // Escludere un CI incluso lo toglie anche dalla mappa: una sola lista di rimozione.
      const removeFromMap = [...new Set([...remove, ...exclude].filter((id) => currentIds.has(id)))]
      const keepMissing = diff.missing.filter((id) => !remove.includes(id))
      const finalCount = currentIds.size + add.length - removeFromMap.length
      if (finalCount > SERVICE_MAP_MAX_NODES) {
        throw new ValidationError(`Applying the proposal would bring ServiceMap ${input.mapId} to ${finalCount} components, over the ${SERVICE_MAP_MAX_NODES} cap: exclude or remove some first`)
      }
      const note = `Mappa aggiornata: +${add.length}, −${removeFromMap.length}, esclusi ${exclude.length}`

      const row = requireWriteRow(await runQueryOne<WriteRow & { added: unknown; excluded: unknown; removed: unknown; included: unknown }>(tx, APPLY_PROPOSAL_CYPHER, {
        mapId: input.mapId, tenantId: input.tenantId, expectedVersion: input.expectedVersion, now, actorId: input.actorId,
        addNodes: add.map((id) => {
          const n = addable.get(id)!
          return { ciId: n.ciId, level: n.level, role: n.role, propagate: n.propagate, weight: n.weight, critical: n.critical, via: n.via }
        }),
        excludeIds: exclude, removeIds: removeFromMap, keepMissing, excludeReason: SERVICE_EXCLUSION_REASON_MANUAL,
        ...serviceConfigHistoryParams('map_changed', note, now),
      }), input.mapId, input.expectedVersion)

      const counts = { added: toNumber(row.added), excluded: toNumber(row.excluded), removed: toNumber(row.removed) }
      if (counts.added !== add.length || counts.excluded !== exclude.length || counts.removed !== removeFromMap.length) {
        throw new Error(`ServiceMap ${input.mapId}: applied ${counts.added}/${add.length} additions, ${counts.excluded}/${exclude.length} exclusions, ${counts.removed}/${removeFromMap.length} removals (a CI vanished while writing): the transaction was rolled back`)
      }
      return { version: toNumber(row.version), status: assertStatus(row.status, input.mapId), note }
    })
  } finally { await session.close() }
  log.info({ tenantId: input.tenantId, mapId: input.mapId, version: written.version, note: written.note }, 'Service map proposal applied')
  return finish(input, written, 'map_changed')
}

/**
 * Mappa viva o congelata (ondata 5): `auto_sync = true` (default) = i
 * componenti si aggiornano da soli quando cambia la CMDB;
 * `false` = comportamento delle ondate 1–4 (diff proposto e applicato a mano).
 * In entrambe le modalità le esclusioni e i componenti aggiunti a mano restano.
 *
 * Non rivaluta la mappa: cambiare modalità non cambia né i componenti né la
 * loro salute (`evaluation` resta null). Scrivere lo stesso valore è un errore
 * come per le regole: alzerebbe la versione e lascerebbe una voce di
 * cronologia senza contenuto.
 */
export async function setServiceMapAutoSync(input: ConfigWriteInput & { autoSync: boolean }): Promise<ConfigWriteResult> {
  const now = input.now ?? new Date().toISOString()
  assertExpectedVersion(input.expectedVersion)
  if (typeof input.autoSync !== 'boolean') throw new ValidationError(`autoSync must be a boolean. Got: ${JSON.stringify(input.autoSync)}`)
  const session = getSession(undefined, 'WRITE')
  let written: { version: number; status: ServiceMapStatus; note: string }
  try {
    written = await session.executeWrite(async (tx) => {
      const state = await loadServiceMapState(tx, input.tenantId, input.mapId, now)
      assertVersionMatches(state.props, input.mapId, input.expectedVersion)
      const current = assertAutoSync(state.props['auto_sync'], input.mapId)
      if (current === input.autoSync) {
        throw new ValidationError(`ServiceMap ${input.mapId} already has autoSync ${input.autoSync}: nothing to save`)
      }
      const note = input.autoSync ? 'Aggiornamento automatico attivato' : 'Aggiornamento automatico disattivato'
      const row = requireWriteRow(await runQueryOne<WriteRow>(tx, SET_AUTO_SYNC_CYPHER, {
        mapId: input.mapId, tenantId: input.tenantId, expectedVersion: input.expectedVersion,
        autoSync: input.autoSync, now, actorId: input.actorId,
        ...serviceConfigHistoryParams('map_changed', note, now),
      }), input.mapId, input.expectedVersion)
      return { version: toNumber(row.version), status: assertStatus(row.status, input.mapId), note }
    })
  } finally { await session.close() }
  log.info({ tenantId: input.tenantId, mapId: input.mapId, version: written.version, autoSync: input.autoSync }, 'Service map auto sync changed')
  return { mapId: input.mapId, version: written.version, status: written.status, note: written.note, evaluation: null }
}

/**
 * `auto_sync` della mappa. Assente = mappa creata prima dell'ondata 5: errore
 * che nomina la migrazione, mai un default a runtime (una mappa che si crede
 * congelata mentre si aggiorna da sola, o viceversa, è il peggio che possa
 * capitare qui).
 */
export function assertAutoSync(value: unknown, mapId: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`ServiceMap ${mapId} has no auto_sync (got ${JSON.stringify(value)}) — run the 20260910_1110_service_map_auto_sync migration`)
  }
  return value
}

/** Riammette un CI escluso: tornerà nella prossima proposta. */
export async function removeServiceMapExclusion(input: ConfigWriteInput & { ciId: string }): Promise<ConfigWriteResult> {
  const now = input.now ?? new Date().toISOString()
  assertExpectedVersion(input.expectedVersion)
  if (typeof input.ciId !== 'string' || input.ciId === '') throw new ValidationError(`ciId must be a non-empty id. Got: ${JSON.stringify(input.ciId)}`)
  const session = getSession(undefined, 'WRITE')
  let written: { version: number; status: ServiceMapStatus; note: string }
  try {
    written = await session.executeWrite(async (tx) => {
      const state = await loadServiceMapState(tx, input.tenantId, input.mapId, now)
      assertVersionMatches(state.props, input.mapId, input.expectedVersion)
      const exclusions = await loadServiceMapExclusions(tx, input.tenantId, input.mapId)
      const excluded = exclusions.find((e) => e.id === input.ciId)
      if (!excluded) throw new ValidationError(`ciId: ${input.ciId} is not excluded from ServiceMap ${input.mapId}`)
      const note = `Esclusione rimossa: ${excluded.name || excluded.id}`
      const row = requireWriteRow(await runQueryOne<WriteRow & { removed: unknown }>(tx, REMOVE_EXCLUSION_CYPHER, {
        mapId: input.mapId, tenantId: input.tenantId, expectedVersion: input.expectedVersion, ciId: input.ciId,
        now, actorId: input.actorId, ...serviceConfigHistoryParams('map_changed', note, now),
      }), input.mapId, input.expectedVersion)
      if (toNumber(row.removed) !== 1) throw new Error(`ServiceMap ${input.mapId}: exclusion of ${input.ciId} was not removed (${toNumber(row.removed)} relationships deleted)`)
      return { version: toNumber(row.version), status: assertStatus(row.status, input.mapId), note }
    })
  } finally { await session.close() }
  log.info({ tenantId: input.tenantId, mapId: input.mapId, version: written.version, ciId: input.ciId }, 'Service map exclusion removed')
  return finish(input, written, 'map_changed')
}

/**
 * Rivalutazione immediata dopo una scrittura riuscita, con lo stesso trigger
 * della voce di cronologia. Le mappe in pausa non vengono valutate: la salute
 * mostrata resta l'ultima nota (e lo dice la pagina), mai un valore calcolato
 * di nascosto su una mappa che l'amministratore ha fermato.
 */
async function finish(input: ConfigWriteInput, written: { version: number; status: ServiceMapStatus; note: string }, trigger: 'rules_changed' | 'map_changed'): Promise<ConfigWriteResult> {
  const evaluation = written.status === 'paused'
    ? null
    : await evaluateServiceMap({ tenantId: input.tenantId, mapId: input.mapId, trigger, actorId: input.actorId })
  return { mapId: input.mapId, version: written.version, status: written.status, note: written.note, evaluation }
}
