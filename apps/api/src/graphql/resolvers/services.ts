/**
 * Servizi monitorati — resolver di `schema-services.ts` (ondata 1: lettura,
 * creazione automatica, rivalutazione, stato, eliminazione).
 *
 * Ogni query è scopata per tenant; ogni mutation scrive l'audit. Le
 * mutation e `serviceMapCandidates` sono admin-only in lib/authorization.ts
 * e hanno un requireRole locale come seconda linea. La lista
 * (`serviceMaps`) calcola contatori, totale filtrato e pagina in UNA query
 * (tre CALL { } senza importazioni, pattern di ciHealthOverview); servizio,
 * owner e conteggio dei nodi sono risolti con la riga (`serviceMapRowColumns`),
 * mentre `nodes`, `edges`, `history` e `historyCount` sono field resolver
 * (il web non li seleziona nella lista). La spiegazione (`explanation`) e le
 * cause delle voci di cronologia sono istantanee JSON scritte dal motore
 * (services/serviceImpact/engine.ts): nessuna query per risolvere i CI.
 */
import { getSession, runQuery, runQueryOne, toNumber } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { requireRole } from '../../lib/requireRole.js'
import { logger } from '../../lib/logger.js'
import { mapTeam } from '../../lib/mappers.js'
import { ciTypeFromLabels } from '../../lib/ciTypeFromLabels.js'
import { getQueue } from '../../lib/bullmq.js'
import {
  SERVICE_HEALTHS, SERVICE_HEALTH_SEVERITY_ORDER, SERVICE_HEALTH_TRIGGERS, SERVICE_HISTORY_MAX, SERVICE_MAP_DEFAULT_DEPTH, SERVICE_MAP_STATUSES,
  SERVICE_RELATIONSHIP_TYPES, parseServiceImpactRules,
  type ServiceHealth, type ServiceHealthTrigger, type ServiceImpactRules, type ServiceMapStatus,
} from '../../lib/serviceVocabularies.js'
import { createServiceMap as createServiceMapService, evaluateServiceMap, loadServiceMapState } from '../../services/serviceImpact/engine.js'
import { nodeContributes } from '../../services/serviceImpact/rules.js'
import type { CauseCIRef, StoredCause } from '../../services/serviceImpact/history.js'
import { SERVICE_IMPACT_QUEUE, serviceMapJobId } from '../../jobs/serviceImpactWorker.js'

type Props = Record<string, unknown>

const log = logger.child({ module: 'service-impact' })

function toStr(v: unknown): string { return v == null ? '' : typeof v === 'string' ? v : String(v) }
function toStrOrNull(v: unknown): string | null { return v == null ? null : toStr(v) }

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${what} is ${JSON.stringify(value)}: expected one of ${allowed.join(', ')}`)
  }
  return value as T
}

// ── Mapper ───────────────────────────────────────────────────────────────────

/** `ConfigurationItemRef` da un riferimento salvato nella spiegazione (istantanea: `status` non è conservato). */
function mapCauseRef(r: CauseCIRef) {
  return { id: r.id, name: r.name, type: r.type, status: null, health: r.health ?? null }
}

function mapStoredCause(c: StoredCause) {
  return { ci: mapCauseRef(c.ci), health: c.health, weight: c.weight, critical: c.critical, path: c.path.map(mapCauseRef) }
}

/** JSON delle cause (ServiceMap.explanation / ServiceHealthEntry.cause) → ImpactCause[]. Assente o corrotto = non scritto dal motore: errore. */
export function parseStoredCauses(raw: unknown, what: string): ReturnType<typeof mapStoredCause>[] {
  if (typeof raw !== 'string') throw new Error(`${what} is not a JSON string (got ${typeof raw}): it was not written by the service impact engine`)
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (e) { throw new Error(`${what} is corrupt JSON: ${e instanceof Error ? e.message : String(e)}`) }
  if (!Array.isArray(parsed)) throw new Error(`${what} is not a JSON array`)
  return (parsed as StoredCause[]).map(mapStoredCause)
}

export function toRulesGQL(r: ServiceImpactRules) {
  return { version: r.version, downSharePct: r.down_share_pct, degradedSharePct: r.degraded_share_pct, minNodes: r.min_nodes, unknownNodes: r.unknown_nodes, openIncidentFrom: r.open_incident_from }
}

export interface ServiceMapRow {
  props:     Props
  service:   { id: string; name: string | null; criticality: string | null; owner: Props | null } | null
  nodeCount: unknown
}

export function mapServiceMap(row: ServiceMapRow) {
  const p = row.props
  const id = toStr(p['id'])
  if (!row.service) throw new Error(`ServiceMap ${id} has no BusinessApplication (HAS_SERVICE_MAP): the service was deleted without its map`)
  const relationshipTypes = p['relationship_types']
  if (!Array.isArray(relationshipTypes)) throw new Error(`ServiceMap ${id} has no relationship_types — run the 20260910_1080_service_maps_bootstrap migration`)
  return {
    id,
    name:              toStr(p['name']),
    status:            assertEnum<ServiceMapStatus>(p['status'], SERVICE_MAP_STATUSES, `ServiceMap ${id} status`),
    version:           toNumber(p['version']),
    updatedAt:         toStrOrNull(p['updated_at']),
    maxDepth:          toNumber(p['max_depth']),
    relationshipTypes: relationshipTypes.map(toStr),
    builtFrom:         toStr(p['built_from']),
    stale:             p['stale'] === true,
    rules:             toRulesGQL(parseServiceImpactRules(p['rules'], id)),
    health:            assertEnum<ServiceHealth>(p['health'], SERVICE_HEALTHS, `ServiceMap ${id} health`),
    healthSince:       toStrOrNull(p['health_since']),
    impactScore:       toNumber(p['impact_score']),
    evaluatedAt:       toStrOrNull(p['evaluated_at']),
    explanation:       parseStoredCauses(p['explanation'], `ServiceMap ${id} explanation`),
    service: {
      id:          row.service.id,
      name:        row.service.name ?? '',
      criticality: row.service.criticality ?? null,
      ownerGroup:  row.service.owner ? mapTeam(row.service.owner) : null,
    },
    nodeCount: toNumber(row.nodeCount),
  }
}

export function mapHistoryEntry(props: Props) {
  const id = toStr(props['id'])
  return {
    id,
    at:             toStr(props['at']),
    health:         assertEnum<ServiceHealth>(props['health'], SERVICE_HEALTHS, `ServiceHealthEntry ${id} health`),
    previousHealth: props['previous_health'] == null ? null : assertEnum<ServiceHealth>(props['previous_health'], SERVICE_HEALTHS, `ServiceHealthEntry ${id} previous_health`),
    impactScore:    toNumber(props['impact_score']),
    trigger:        assertEnum<ServiceHealthTrigger>(props['trigger'], SERVICE_HEALTH_TRIGGERS, `ServiceHealthEntry ${id} trigger`),
    causes:         parseStoredCauses(props['cause'], `ServiceHealthEntry ${id} cause`),
    note:           toStrOrNull(props['note']),
  }
}

// ── Frammenti Cypher ─────────────────────────────────────────────────────────

/** Ordine di gravità delle mappe: down, degraded, maintenance, unknown, operational. */
export const SERVICE_SEVERITY_ORDER = `CASE m.health ${SERVICE_HEALTH_SEVERITY_ORDER.map((h, i) => `WHEN '${h}' THEN ${i}`).join(' ')} ELSE ${SERVICE_HEALTH_SEVERITY_ORDER.length} END`
export const SERVICE_MAP_ORDER = `${SERVICE_SEVERITY_ORDER}, m.impact_score DESC, m.name`

/**
 * Le colonne di una mappa per mapServiceMap, con `m` in scope: il servizio
 * (BusinessApplication via HAS_SERVICE_MAP) con criticità e owner
 * (OWNED_BY → Team), e il numero di componenti. Termina con un WITH.
 */
export function serviceMapRowColumns(): string {
  return `
  OPTIONAL MATCH (ba:BusinessApplication {tenant_id: $tenantId})-[:HAS_SERVICE_MAP]->(m)
  WITH m, properties(m) AS props,
       CASE WHEN ba IS NULL THEN null ELSE {id: ba.id, name: ba.name, criticality: ba.criticality,
         owner: head([(ba)-[:OWNED_BY]->(t:Team {tenant_id: $tenantId}) | properties(t)])} END AS service,
       COUNT { (m)-[:INCLUDES]->() } AS nodeCount`
}
export const SERVICE_MAP_ROW_RETURN = 'RETURN props, service, nodeCount'
const SERVICE_MAP_ROW_MAP = '{props: props, service: service, nodeCount: nodeCount}'

async function loadServiceMap(id: string, tenantId: string) {
  const session = getSession()
  try {
    const row = await runQueryOne<ServiceMapRow>(session, `
      MATCH (m:ServiceMap {id: $id, tenant_id: $tenantId})
      ${serviceMapRowColumns()}
      ${SERVICE_MAP_ROW_RETURN}
    `, { id, tenantId })
    return row ? mapServiceMap(row) : null
  } finally { await session.close() }
}

async function requireServiceMap(id: string, tenantId: string) {
  const m = await loadServiceMap(id, tenantId)
  if (!m) throw new NotFoundError('ServiceMap', id)
  return m
}

// ── Query ────────────────────────────────────────────────────────────────────

interface ServiceMapFilter { health?: string[] | null; status?: string | null; search?: string | null }

async function serviceMaps(_: unknown, args: { filter?: ServiceMapFilter | null; limit?: number | null; offset?: number | null }, ctx: GraphQLContext) {
  const f = args.filter ?? {}
  const limit  = Math.min(Math.max(args.limit ?? 50, 1), 500)
  const offset = Math.max(args.offset ?? 0, 0)
  const conditions: string[] = []
  const params: Props = { tenantId: ctx.tenantId, limit, offset }
  if (f.health?.length) {
    for (const h of f.health) if (!(SERVICE_HEALTHS as readonly string[]).includes(h)) throw new ValidationError(`Invalid health filter ${JSON.stringify(h)}: expected one of ${SERVICE_HEALTHS.join(', ')}`)
    conditions.push('m.health IN $health'); params['health'] = f.health
  }
  if (f.status) {
    if (!(SERVICE_MAP_STATUSES as readonly string[]).includes(f.status)) throw new ValidationError(`Invalid status filter ${JSON.stringify(f.status)}: expected one of ${SERVICE_MAP_STATUSES.join(', ')}`)
    conditions.push('m.status = $status'); params['status'] = f.status
  }
  if (f.search?.trim()) { conditions.push('toLower(m.name) CONTAINS $search'); params['search'] = f.search.trim().toLowerCase() }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''

  const session = getSession()
  try {
    const row = await runQueryOne<Record<string, unknown> & { items: ServiceMapRow[] }>(session, `
      CALL {
        MATCH (m:ServiceMap {tenant_id: $tenantId})
        RETURN count(m) AS countTotal,
               ${SERVICE_HEALTHS.map((h) => `count(CASE WHEN m.health = '${h}' THEN 1 END) AS ${h}`).join(',\n               ')}
      }
      CALL {
        MATCH (m:ServiceMap {tenant_id: $tenantId})
        ${where}
        RETURN count(m) AS total
      }
      CALL {
        MATCH (m:ServiceMap {tenant_id: $tenantId})
        ${where}
        WITH m ORDER BY ${SERVICE_MAP_ORDER}
        SKIP toInteger($offset) LIMIT toInteger($limit)
        ${serviceMapRowColumns()}
        RETURN collect(${SERVICE_MAP_ROW_MAP}) AS items
      }
      RETURN countTotal, ${SERVICE_HEALTHS.join(', ')}, total, items
    `, params)
    if (!row) throw new Error('serviceMaps: the page query returned no row (count/collect must always yield one)')
    const n = (k: string) => toNumber(row[k])
    return {
      items:  row.items.map(mapServiceMap),
      total:  n('total'),
      counts: { total: n('countTotal'), operational: n('operational'), degraded: n('degraded'), down: n('down'), maintenance: n('maintenance'), unknown: n('unknown') },
    }
  } finally { await session.close() }
}

async function serviceMap(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return loadServiceMap(args.id, ctx.tenantId)
}

async function servicesImpactedByCI(_: unknown, args: { ciId: string }, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const rows = await runQuery<ServiceMapRow>(session, `
      MATCH (m:ServiceMap {tenant_id: $tenantId})-[:INCLUDES]->(ci {id: $ciId, tenant_id: $tenantId})
      WITH m ORDER BY ${SERVICE_MAP_ORDER}
      ${serviceMapRowColumns()}
      ${SERVICE_MAP_ROW_RETURN}
    `, { ciId: args.ciId, tenantId: ctx.tenantId })
    return rows.map(mapServiceMap)
  } finally { await session.close() }
}

/** BusinessApplication senza mappa: strumento admin della creazione. */
async function serviceMapCandidates(_: unknown, args: { search?: string | null; limit?: number | null }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100)
  const search = args.search?.trim() ? args.search.trim().toLowerCase() : null
  const session = getSession()
  try {
    const rows = await runQuery<{ id: string; name: string | null; criticality: string | null; owner: Props | null }>(session, `
      MATCH (ba:BusinessApplication {tenant_id: $tenantId})
      WHERE NOT EXISTS { (ba)-[:HAS_SERVICE_MAP]->(:ServiceMap {tenant_id: $tenantId}) }
        AND ($search IS NULL OR toLower(ba.name) CONTAINS $search)
      RETURN ba.id AS id, ba.name AS name, ba.criticality AS criticality,
             head([(ba)-[:OWNED_BY]->(t:Team {tenant_id: $tenantId}) | properties(t)]) AS owner
      ORDER BY ba.name LIMIT toInteger($limit)
    `, { tenantId: ctx.tenantId, search, limit })
    return rows.map((r) => ({ id: r.id, name: r.name ?? '', criticality: r.criticality ?? null, ownerGroup: r.owner ? mapTeam(r.owner) : null }))
  } finally { await session.close() }
}

// ── Field resolver di ServiceMap ─────────────────────────────────────────────

/** I componenti con la salute del CI e `contributes` dalle regole della mappa (stessa lettura del motore). */
async function serviceMapNodes(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const state = await loadServiceMapState(session, ctx.tenantId, parent.id, new Date().toISOString())
    return state.nodes
      .slice()
      .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name))
      .map((n) => ({
        ci:            { id: n.ciId, name: n.name, type: ciTypeFromLabels(n.labels), status: n.status, health: n.health },
        level:         n.level,
        role:          n.role,
        propagate:     n.propagate,
        weight:        n.weight,
        critical:      n.critical,
        via:           n.via,
        addedBy:       n.addedBy,
        health:        n.health,
        inMaintenance: n.inMaintenance,
        contributes:   nodeContributes(n, state.rules),
      }))
  } finally { await session.close() }
}

export const SERVICE_MAP_EDGE_LIMIT = 5000

/** Archi vivi fra i componenti inclusi (qualunque tipo di relazione fra CI, come la topologia). */
async function serviceMapEdges(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    return await runQuery<{ source: string; target: string; relType: string }>(session, `
      MATCH (m:ServiceMap {id: $id, tenant_id: $tenantId})-[:INCLUDES]->(a {tenant_id: $tenantId})
      MATCH (a)-[r]->(b {tenant_id: $tenantId})
      WHERE EXISTS { (m)-[:INCLUDES]->(b) }
      RETURN DISTINCT a.id AS source, b.id AS target, type(r) AS relType
      ORDER BY source, target, relType
      LIMIT ${SERVICE_MAP_EDGE_LIMIT}
    `, { id: parent.id, tenantId: ctx.tenantId })
  } finally { await session.close() }
}

/** Ultime `limit` voci (1..SERVICE_HISTORY_MAX, default 100) dalla più recente, sull'indice (tenant_id, map_id, at). */
async function serviceMapHistory(parent: { id: string }, args: { limit?: number | null } | null | undefined, ctx: GraphQLContext) {
  const limit = Math.min(Math.max(args?.limit ?? 100, 1), SERVICE_HISTORY_MAX)
  const session = getSession()
  try {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (h:ServiceHealthEntry {tenant_id: $tenantId, map_id: $id})
      WITH h ORDER BY h.at DESC, h.id DESC LIMIT toInteger($limit)
      RETURN properties(h) AS props
    `, { id: parent.id, tenantId: ctx.tenantId, limit })
    return rows.map((r) => mapHistoryEntry(r.props))
  } finally { await session.close() }
}

async function serviceMapHistoryCount(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const row = await runQueryOne<{ n: unknown }>(session, `
      MATCH (h:ServiceHealthEntry {tenant_id: $tenantId, map_id: $id})
      RETURN count(h) AS n
    `, { id: parent.id, tenantId: ctx.tenantId })
    return toNumber(row?.n)
  } finally { await session.close() }
}

// ── Mutation ─────────────────────────────────────────────────────────────────

async function createServiceMap(_: unknown, args: { serviceId: string; maxDepth?: number | null; relationshipTypes?: string[] | null }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const maxDepth = args.maxDepth ?? SERVICE_MAP_DEFAULT_DEPTH
  const relationshipTypes = args.relationshipTypes ?? [...SERVICE_RELATIONSHIP_TYPES]
  const { mapId, proposal, evaluation } = await createServiceMapService({ tenantId: ctx.tenantId, serviceId: args.serviceId, maxDepth, relationshipTypes, actorId: ctx.userId })
  void audit(ctx, 'service_map.created', 'ServiceMap', mapId, {
    serviceId: args.serviceId, serviceName: proposal.serviceName, maxDepth: proposal.maxDepth, relationshipTypes: proposal.relationshipTypes,
    nodes: proposal.nodes.length, health: evaluation.health, impactScore: evaluation.impactScore,
  })
  return requireServiceMap(mapId, ctx.tenantId)
}

async function reevaluateServiceMap(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const r = await evaluateServiceMap({ tenantId: ctx.tenantId, mapId: args.id, trigger: 'manual', actorId: ctx.userId })
  void audit(ctx, 'service_map.reevaluated', 'ServiceMap', args.id, { previousHealth: r.previousHealth, health: r.health, impactScore: r.impactScore, changed: r.changed, stale: r.stale })
  return requireServiceMap(args.id, ctx.tenantId)
}

/**
 * Stato con controllo di concorrenza: `expectedVersion` = versione letta dal
 * client; diversa → BAD_USER_INPUT (la mappa è stata modificata da un altro
 * amministratore), senza scrivere. Riattivare una mappa in pausa la rivaluta
 * subito (trigger manual): la salute mostrata non deve essere quella di
 * quando è stata messa in pausa.
 */
async function setServiceMapStatus(_: unknown, args: { id: string; expectedVersion: number; status: string }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const status = assertEnumInput(args.status, SERVICE_MAP_STATUSES, 'status')
  if (!Number.isInteger(args.expectedVersion) || args.expectedVersion < 1) throw new ValidationError(`expectedVersion must be an integer >= 1. Got: ${JSON.stringify(args.expectedVersion)}`)
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  let row: { previous: string; version: unknown } | null
  try {
    row = await runQueryOne<{ previous: string; version: unknown }>(session, `
      MATCH (m:ServiceMap {id: $id, tenant_id: $tenantId})
      WITH m, m.status AS previous, m.version AS version
      WHERE version = toInteger($expectedVersion)
      SET m.status = $status, m.version = version + 1, m.updated_at = $now, m.updated_by = $userId
      RETURN previous, m.version AS version
    `, { id: args.id, tenantId: ctx.tenantId, expectedVersion: args.expectedVersion, status, now, userId: ctx.userId })
  } finally { await session.close() }
  if (!row) {
    const current = await requireServiceMap(args.id, ctx.tenantId)   // NotFound se non esiste
    throw new ValidationError(`ServiceMap ${args.id} was modified by someone else (expected version ${args.expectedVersion}, current is ${current.version}, updated at ${current.updatedAt ?? 'n/a'}): reload and retry`)
  }
  void audit(ctx, 'service_map.status_changed', 'ServiceMap', args.id, { previousStatus: row.previous, status, version: toNumber(row.version) })
  if (row.previous === 'paused' && status === 'active') {
    await evaluateServiceMap({ tenantId: ctx.tenantId, mapId: args.id, trigger: 'manual', actorId: ctx.userId })
  }
  return requireServiceMap(args.id, ctx.tenantId)
}

function assertEnumInput<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}. Got: ${JSON.stringify(value)}`)
  }
  return value as T
}

/** Elimina mappa e cronologia (il servizio e i CI restano); un job di valutazione in attesa viene tolto dalla coda (se già in esecuzione fallirà con NOT_FOUND, visibile nel log). */
async function deleteServiceMap(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const session = getSession(undefined, 'WRITE')
  let row: { name: string | null; serviceId: string | null; entries: unknown } | null
  try {
    row = await runQueryOne<{ name: string | null; serviceId: string | null; entries: unknown }>(session, `
      MATCH (m:ServiceMap {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (m)-[:HAS_HEALTH_HISTORY]->(h:ServiceHealthEntry {tenant_id: $tenantId})
      WITH m, m.name AS name, m.service_id AS serviceId, collect(h) AS entries
      FOREACH (x IN entries | DETACH DELETE x)
      DETACH DELETE m
      RETURN name, serviceId, size(entries) AS entries
    `, { id: args.id, tenantId: ctx.tenantId })
  } finally { await session.close() }
  if (!row) throw new NotFoundError('ServiceMap', args.id)
  const jobId = serviceMapJobId(ctx.tenantId, args.id)
  try {
    await getQueue(SERVICE_IMPACT_QUEUE).remove(jobId)
  } catch (err) {
    log.warn({ err, tenantId: ctx.tenantId, mapId: args.id, jobId }, 'Pending evaluation job could not be removed after map deletion (it will fail with NOT_FOUND)')
  }
  void audit(ctx, 'service_map.deleted', 'ServiceMap', args.id, { name: row.name, serviceId: row.serviceId, historyEntries: toNumber(row.entries) })
  return true
}

export const serviceResolvers = {
  Query: { serviceMaps, serviceMap, servicesImpactedByCI, serviceMapCandidates },
  Mutation: { createServiceMap, reevaluateServiceMap, setServiceMapStatus, deleteServiceMap },
  ServiceMap: { nodes: serviceMapNodes, edges: serviceMapEdges, history: serviceMapHistory, historyCount: serviceMapHistoryCount },
}
