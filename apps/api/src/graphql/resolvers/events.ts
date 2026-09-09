/**
 * Event Management — resolver di `schema-events.ts` (ondata 1: console,
 * riconoscimento manuale, apertura manuale dell'incident, alias, policy;
 * ondata 2: anteprima della normalizzazione, payload di esempio, chiavi del
 * payload per il mappatore, sorgenti, salute del CI e forzatura manuale).
 *
 * Ondata 3: `reevaluateEvent`, filtri `incidentId`/`suppressedByChangeId`,
 * campi `Event.suppressedBy`/`correlation`, `Incident.correlatedEvents`,
 * `Change.suppressedEvents`; resolveEvent e linkEventToCI rientrano nella
 * pipeline di correlazione (services/eventCorrelation.ts).
 * Ondata 4: `Event.flappingSince`/`transitions24h`, `EventStats.stormSources`
 * (services/eventStorm.ts), nuove chiavi della policy.
 *
 * Ogni query è scopata per tenant; ogni mutation scrive l'audit. Le mutation
 * amministrative (alias, policy) sono in ADMIN_ONLY_MUTATIONS (lib/authorization.ts)
 * e hanno un requireRole locale come seconda linea.
 */
import { v4 as uuidv4 } from 'uuid'
import { getSession, runQuery, runQueryOne, toNumber } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { NotFoundError, ValidationError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { requireRole } from '../../lib/requireRole.js'
import { publishEvent } from '../../lib/publishEvent.js'
import { ciTypeFromLabels } from '../../lib/ciTypeFromLabels.js'
import { TYPE_TO_LABEL } from '../../lib/ciLabels.js'
import { toPascalCase } from '@opengraphity/schema-generator'
import { mapIncident, mapUser } from '../../lib/mappers.js'
import { validateStringLength } from '../../lib/validation.js'
import { applyEventPolicyInput, toEventPolicyGQL, type EventPolicyInputGQL } from '../../lib/eventPolicy.js'
import {
  CI_ALIAS_KINDS, getEventPolicy, setEventPolicy, mapEventPayload, recomputeCIHealth,
  assertConnectorKind, listPayloadKeys, sourceConfigOf, normalizeWithConfig, countTransitionsSince, transitionsOf,
  type CIAliasKind, type NormalizedEvent,
} from '../../services/eventService.js'
import { openIncidentFromEvent, runEventPipeline } from '../../services/eventCorrelation.js'
import { listStormSources } from '../../services/eventStorm.js'
import { enqueueEvents } from '../../jobs/eventIngestWorker.js'
import { sampleInboundPayload as samplePayloadOf } from '../../lib/eventSamples.js'
import { mapInbound } from './integrations.js'
import { change as loadChange } from './change/queries.js'
import type { CIHealth, CIHealthChangedPayload } from '@opengraphity/types'

/** Valori ammessi per la forzatura manuale della salute (setCIHealthOverride). */
const CI_HEALTHS = ['operational', 'degraded', 'down'] as const

type Props = Record<string, unknown>

const EVENT_STATUSES   = ['firing', 'resolved', 'suppressed', 'flapping'] as const
const EVENT_SEVERITIES = ['info', 'warning', 'critical'] as const

/** Stati/esiti per cui `reevaluateEvent` ha senso: il resto è un errore di input, non un no-op. */
const REEVALUABLE_CORRELATIONS = ['delayed', 'skipped_orphan'] as const

// ── Mapper ───────────────────────────────────────────────────────────────────

function toStr(v: unknown): string { return v == null ? '' : typeof v === 'string' ? v : String(v) }
function toStrOrNull(v: unknown): string | null { return v == null ? null : toStr(v) }

export interface CIRefRow { ciId: string | null; ciName: string | null; ciStatus: string | null; ciHealth: string | null; ciLabels: string[] | null }

/** `ConfigurationItemRef` dal frammento CI_REF; null se l'evento è orfano. */
export function mapCIRef(row: CIRefRow) {
  if (!row.ciId) return null
  return {
    id:     row.ciId,
    name:   row.ciName ?? '',
    type:   ciTypeFromLabels(row.ciLabels ?? []),
    status: row.ciStatus ?? null,   // ciclo di vita (active, maintenance, …)
    health: row.ciHealth ?? null,   // salute dal monitoraggio (operational/degraded/down)
  }
}

export function mapEvent(props: Props, ci: CIRefRow) {
  // `correlation` è non-null nel contratto: la migrazione 20260909_1030 lo
  // scrive sugli eventi esistenti e ingestEvent su quelli nuovi. Assente =
  // migrazione non eseguita → errore, non un valore inventato.
  const correlation = props['correlation']
  if (typeof correlation !== 'string' || !correlation) {
    throw new Error(`Event ${toStr(props['id'])} has no correlation field — run the 20260909_1030_event_management_correlation_rules migration`)
  }
  return {
    id:             toStr(props['id']),
    fingerprint:    toStr(props['fingerprint']),
    externalId:     toStrOrNull(props['external_id']),
    status:         toStr(props['status']),
    severity:       toStr(props['severity']),
    title:          toStr(props['title']),
    description:    toStrOrNull(props['description']),
    resource:       toStr(props['resource']),
    resourceKind:   toStr(props['resource_kind']),
    labels:         toStrOrNull(props['labels']),
    count:          toNumber(props['count']),
    firstSeenAt:    toStr(props['first_seen_at']),
    lastSeenAt:     toStr(props['last_seen_at']),
    resolvedAt:     toStrOrNull(props['resolved_at']),
    acknowledgedAt: toStrOrNull(props['acknowledged_at']),
    correlation,
    correlationAt:  toStrOrNull(props['correlation_at']),
    flappingSince:  toStrOrNull(props['flapping_since']),
    transitions24h: countTransitionsSince(transitionsOf(props), Date.now() - 24 * 3600 * 1000),
    // risolti dai field resolver: acknowledgedBy, source, incident, suppressedBy
    acknowledgedById:     toStrOrNull(props['acknowledged_by']),
    sourceId:             toStrOrNull(props['source_id']),
    suppressedByChangeId: toStrOrNull(props['suppressed_by_change_id']),
    ci:             mapCIRef(ci),
  }
}

function mapAlias(props: Props, ci: CIRefRow) {
  const ref = mapCIRef(ci)
  if (!ref) throw new Error(`CIAlias ${toStr(props['id'])} has no ALIAS_OF target`)
  return {
    id:        toStr(props['id']),
    kind:      toStr(props['kind']),
    value:     toStr(props['value']),
    source:    toStr(props['source']),
    createdAt: toStr(props['created_at']),
    ci:        ref,
  }
}

/** OPTIONAL MATCH del CI + colonne per mapCIRef; `e` deve essere in scope. */
const CI_REF = `
  OPTIONAL MATCH (e)-[:RAISED_ON]->(ci:ConfigurationItem {tenant_id: $tenantId})
  RETURN properties(e) AS props, ci.id AS ciId, ci.name AS ciName, ci.status AS ciStatus, ci.health AS ciHealth,
         CASE WHEN ci IS NULL THEN null ELSE [l IN labels(ci) WHERE l <> 'ConfigurationItem'] END AS ciLabels`

type EventRow = { props: Props } & CIRefRow

async function loadEvent(id: string, tenantId: string): Promise<EventRow> {
  const session = getSession()
  try {
    const row = await runQueryOne<EventRow>(session, `
      MATCH (e:Event {id: $id, tenant_id: $tenantId})
      ${CI_REF}
    `, { id, tenantId })
    if (!row) throw new NotFoundError('Event', id)
    return row
  } finally {
    await session.close()
  }
}

// ── Query ────────────────────────────────────────────────────────────────────

interface EventFilter {
  status?: string[] | null
  severity?: string[] | null
  ciId?: string | null
  sourceId?: string | null
  orphan?: boolean | null
  search?: string | null
  since?: string | null
  incidentId?: string | null
  suppressedByChangeId?: string | null
}

async function events(_: unknown, args: { filter?: EventFilter | null; limit?: number | null; offset?: number | null }, ctx: GraphQLContext) {
  const f = args.filter ?? {}
  const limit  = Math.min(Math.max(args.limit ?? 50, 1), 500)
  const offset = Math.max(args.offset ?? 0, 0)
  const conditions: string[] = ['e.tenant_id = $tenantId']
  const params: Props = { tenantId: ctx.tenantId, limit, offset }

  if (f.status?.length) {
    for (const s of f.status) if (!(EVENT_STATUSES as readonly string[]).includes(s)) throw new ValidationError(`Invalid status filter ${JSON.stringify(s)}`)
    conditions.push('e.status IN $status'); params['status'] = f.status
  }
  if (f.severity?.length) {
    for (const s of f.severity) if (!(EVENT_SEVERITIES as readonly string[]).includes(s)) throw new ValidationError(`Invalid severity filter ${JSON.stringify(s)}`)
    conditions.push('e.severity IN $severity'); params['severity'] = f.severity
  }
  if (f.ciId) {
    conditions.push('EXISTS { (e)-[:RAISED_ON]->(:ConfigurationItem {id: $ciId, tenant_id: $tenantId}) }'); params['ciId'] = f.ciId
  }
  if (f.sourceId) { conditions.push('e.source_id = $sourceId'); params['sourceId'] = f.sourceId }
  if (f.incidentId) {
    conditions.push('EXISTS { (e)-[:CORRELATED_INTO]->(:Incident {id: $incidentId, tenant_id: $tenantId}) }'); params['incidentId'] = f.incidentId
  }
  if (f.suppressedByChangeId) {
    conditions.push('EXISTS { (e)-[:SUPPRESSED_BY]->(:Change {id: $suppressedByChangeId, tenant_id: $tenantId}) }'); params['suppressedByChangeId'] = f.suppressedByChangeId
  }
  if (f.orphan === true)  conditions.push('NOT EXISTS { (e)-[:RAISED_ON]->(:ConfigurationItem) }')
  if (f.orphan === false) conditions.push('EXISTS { (e)-[:RAISED_ON]->(:ConfigurationItem) }')
  if (f.search?.trim()) {
    conditions.push('(toLower(e.title) CONTAINS $search OR toLower(e.resource) CONTAINS $search)')
    params['search'] = f.search.trim().toLowerCase()
  }
  if (f.since) {
    if (Number.isNaN(Date.parse(f.since))) throw new ValidationError(`since must be an ISO date, got ${JSON.stringify(f.since)}`)
    conditions.push('e.last_seen_at >= $since'); params['since'] = f.since
  }
  const where = 'WHERE ' + conditions.join(' AND ')

  const session = getSession()
  try {
    const rows = await runQuery<EventRow>(session, `
      MATCH (e:Event)
      ${where}
      WITH e ORDER BY e.last_seen_at DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
      ${CI_REF}
    `, params)
    const count = await runQueryOne<{ total: unknown }>(session, `
      MATCH (e:Event)
      ${where}
      RETURN count(e) AS total
    `, params)
    return { items: rows.map((r) => mapEvent(r.props, r)), total: toNumber(count?.total) }
  } finally {
    await session.close()
  }
}

async function event(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const row = await runQueryOne<EventRow>(session, `
      MATCH (e:Event {id: $id, tenant_id: $tenantId})
      ${CI_REF}
    `, { id: args.id, tenantId: ctx.tenantId })
    return row ? mapEvent(row.props, row) : null
  } finally {
    await session.close()
  }
}

async function eventStats(_: unknown, __: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const row = await runQueryOne<Record<string, unknown>>(session, `
      MATCH (e:Event {tenant_id: $tenantId})
      OPTIONAL MATCH (e)-[:RAISED_ON]->(ci:ConfigurationItem {tenant_id: $tenantId})
      WITH e, ci IS NOT NULL AS hasCi
      RETURN
        count(CASE WHEN e.status = 'firing' THEN 1 END) AS firing,
        count(CASE WHEN e.status = 'firing' AND e.severity = 'critical' THEN 1 END) AS critical,
        count(CASE WHEN e.status = 'firing' AND e.severity = 'warning'  THEN 1 END) AS warning,
        count(CASE WHEN e.status = 'firing' AND NOT hasCi THEN 1 END) AS orphan,
        count(CASE WHEN e.status = 'suppressed' THEN 1 END) AS suppressed,
        count(CASE WHEN e.status = 'flapping'   THEN 1 END) AS flapping,
        count(CASE WHEN e.status = 'resolved' AND e.resolved_at >= $since24h THEN 1 END) AS resolved24h
    `, { tenantId: ctx.tenantId, since24h })
    const n = (k: string) => toNumber(row?.[k])
    const stormSources = await listStormSources(ctx.tenantId)
    return { firing: n('firing'), critical: n('critical'), warning: n('warning'), orphan: n('orphan'), suppressed: n('suppressed'), flapping: n('flapping'), resolved24h: n('resolved24h'), stormSources }
  } finally {
    await session.close()
  }
}

async function ciAliases(_: unknown, args: { ciId: string }, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const rows = await runQuery<{ props: Props } & CIRefRow>(session, `
      MATCH (a:CIAlias {tenant_id: $tenantId})-[:ALIAS_OF]->(ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
      RETURN properties(a) AS props, ci.id AS ciId, ci.name AS ciName, ci.status AS ciStatus, ci.health AS ciHealth,
             [l IN labels(ci) WHERE l <> 'ConfigurationItem'] AS ciLabels
      ORDER BY a.kind, a.value
    `, { ciId: args.ciId, tenantId: ctx.tenantId })
    return rows.map((r) => mapAlias(r.props, r))
  } finally {
    await session.close()
  }
}

async function eventPolicy(_: unknown, __: unknown, ctx: GraphQLContext) {
  return toEventPolicyGQL(await getEventPolicy(ctx.tenantId))
}

// ── Ondata 2: configurazione senza codice ────────────────────────────────────

function sampleInboundPayload(_: unknown, args: { connectorKind: string }) {
  return JSON.stringify(samplePayloadOf(args.connectorKind), null, 2)
}

/** JSON incollato dall'amministratore → chiavi con percorso puntato (non valido → ValidationError). */
function payloadKeys(_: unknown, args: { payload: string }) {
  validateStringLength(args.payload, 'payload', 1, 1_000_000)
  let parsed: unknown
  try { parsed = JSON.parse(args.payload) }
  catch (e) { throw new ValidationError(`payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`) }
  return listPayloadKeys(parsed)
}

async function monitoringSources(_: unknown, __: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const rows = await runQuery<{ props: Props }>(session, `
      MATCH (w:InboundWebhook {tenant_id: $tenantId, entity_type: 'event'})
      RETURN properties(w) AS props
      ORDER BY w.name
    `, { tenantId: ctx.tenantId })
    return rows.map((r) => mapInbound(r.props))
  } finally { await session.close() }
}

interface CIHealthRow { ciId: string; health: string | null; healthSource: string | null; lastEventAt: string | null; firingEvents: unknown }

const CI_HEALTH_QUERY = `
  MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
  OPTIONAL MATCH (e:Event {tenant_id: $tenantId, status: 'firing'})-[:RAISED_ON]->(ci)
  RETURN ci.id AS ciId, ci.health AS health, ci.health_source AS healthSource, ci.last_event_at AS lastEventAt, count(e) AS firingEvents`

function mapCIHealth(row: CIHealthRow) {
  return { ciId: row.ciId, health: row.health ?? null, healthSource: row.healthSource ?? null, lastEventAt: toStrOrNull(row.lastEventAt), firingEvents: toNumber(row.firingEvents) }
}

async function loadCIHealth(ciId: string, tenantId: string) {
  const session = getSession()
  try {
    const row = await runQueryOne<CIHealthRow>(session, CI_HEALTH_QUERY, { ciId, tenantId })
    if (!row) throw new NotFoundError('ConfigurationItem', ciId)
    return mapCIHealth(row)
  } finally { await session.close() }
}

async function ciHealth(_: unknown, args: { ciId: string }, ctx: GraphQLContext) {
  return loadCIHealth(args.ciId, ctx.tenantId)
}

// ── Pagina "Salute CI" ───────────────────────────────────────────────────────

interface CIHealthFilter {
  health?: string[] | null
  type?: string | null
  environment?: string | null
  team?: string | null
  search?: string | null
}

interface CIHealthOverviewRow {
  id: string; name: string; label: string | null; environment: string | null
  health: string; healthSource: string | null; healthSince: unknown; lastEventAt: unknown
  firingEvents: unknown; dependents: unknown; ownerTeam: string | null
}

/** Ordine di gravità delle righe: prima ciò che è giù, poi degradato, poi operativo. */
export const CI_HEALTH_SEVERITY_ORDER = `CASE ci.health WHEN 'down' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END`

/** Tipo del metamodello → label Neo4j (statici da ciLabels, dinamici per convenzione PascalCase, inversa di ciTypeFromLabels). */
function labelOfType(type: string): string {
  return TYPE_TO_LABEL[type] ?? toPascalCase(type)
}

function mapCIHealthRow(r: CIHealthOverviewRow) {
  if (!r.label) throw new Error(`CI ${r.id} has no type label besides ConfigurationItem`)
  return {
    id:           r.id,
    name:         r.name ?? '',
    type:         ciTypeFromLabels([r.label]),
    environment:  r.environment ?? null,
    health:       r.health,
    healthSource: r.healthSource ?? null,
    healthSince:  toStrOrNull(r.healthSince),
    lastEventAt:  toStrOrNull(r.lastEventAt),
    firingEvents: toNumber(r.firingEvents),
    dependents:   toNumber(r.dependents),
    ownerTeam:    r.ownerTeam ?? null,
  }
}

/**
 * Contatori su tutto il tenant (indipendenti dal filtro; `unmonitored` = CI
 * senza `health`) e righe = CI con salute, filtrate, ordinate per gravità poi
 * per numero di dipendenti (impatto) poi per nome. `dependents` conta i
 * DEPENDS_ON entranti da CI dello stesso tenant; `ownerTeam` è il Team
 * raggiunto da OWNED_BY (stessa relazione di CMDB/ciFieldResolvers).
 */
async function ciHealthOverview(_: unknown, args: { filter?: CIHealthFilter | null; limit?: number | null; offset?: number | null }, ctx: GraphQLContext) {
  const f = args.filter ?? {}
  const limit  = Math.min(Math.max(args.limit ?? 100, 1), 500)
  const offset = Math.max(args.offset ?? 0, 0)
  const conditions: string[] = ['ci.health IS NOT NULL']
  const params: Props = { tenantId: ctx.tenantId, limit, offset }

  if (f.health?.length) {
    for (const h of f.health) if (!(CI_HEALTHS as readonly string[]).includes(h)) throw new ValidationError(`Invalid health filter ${JSON.stringify(h)}: expected one of ${CI_HEALTHS.join(', ')}`)
    conditions.push('ci.health IN $health'); params['health'] = f.health
  }
  if (f.type?.trim())        { conditions.push('$typeLabel IN labels(ci)'); params['typeLabel'] = labelOfType(f.type.trim()) }
  if (f.environment?.trim()) { conditions.push('ci.environment = $environment'); params['environment'] = f.environment.trim() }
  if (f.team?.trim())        { conditions.push('EXISTS { (ci)-[:OWNED_BY]->(:Team {id: $team, tenant_id: $tenantId}) }'); params['team'] = f.team.trim() }
  if (f.search?.trim())      { conditions.push('toLower(ci.name) CONTAINS $search'); params['search'] = f.search.trim().toLowerCase() }
  const where = 'WHERE ' + conditions.join(' AND ')

  const session = getSession()
  try {
    const counts = await runQueryOne<Record<string, unknown>>(session, `
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
      RETURN
        count(CASE WHEN ci.health = 'down'        THEN 1 END) AS down,
        count(CASE WHEN ci.health = 'degraded'    THEN 1 END) AS degraded,
        count(CASE WHEN ci.health = 'operational' THEN 1 END) AS operational,
        count(CASE WHEN ci.health IS NULL         THEN 1 END) AS unmonitored
    `, { tenantId: ctx.tenantId })
    const rows = await runQuery<CIHealthOverviewRow>(session, `
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
      ${where}
      OPTIONAL MATCH (e:Event {tenant_id: $tenantId, status: 'firing'})-[:RAISED_ON]->(ci)
      OPTIONAL MATCH (dep:ConfigurationItem {tenant_id: $tenantId})-[:DEPENDS_ON]->(ci)
      OPTIONAL MATCH (ci)-[:OWNED_BY]->(team:Team {tenant_id: $tenantId})
      WITH ci, count(DISTINCT e) AS firingEvents, count(DISTINCT dep) AS dependents, head(collect(DISTINCT team.name)) AS ownerTeam
      RETURN ci.id AS id, ci.name AS name,
             head([l IN labels(ci) WHERE l <> 'ConfigurationItem']) AS label,
             ci.environment AS environment, ci.health AS health, ci.health_source AS healthSource,
             ci.health_since AS healthSince, ci.last_event_at AS lastEventAt,
             firingEvents, dependents, ownerTeam
      ORDER BY ${CI_HEALTH_SEVERITY_ORDER}, dependents DESC, ci.name
      SKIP toInteger($offset) LIMIT toInteger($limit)
    `, params)
    const count = await runQueryOne<{ total: unknown }>(session, `
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
      ${where}
      RETURN count(ci) AS total
    `, params)
    const n = (k: string) => toNumber(counts?.[k])
    return {
      down: n('down'), degraded: n('degraded'), operational: n('operational'), unmonitored: n('unmonitored'),
      items: rows.map(mapCIHealthRow),
      total: toNumber(count?.total),
    }
  } finally { await session.close() }
}

interface PreviewInput { connectorKind: string; payload: string; fieldMapping?: string | null; defaultValues?: string | null; valueMapping?: string | null }

function toPreview(ev: NormalizedEvent) {
  return {
    externalId:   ev.externalId ?? null,
    status:       ev.status,
    severity:     ev.severity,
    title:        ev.title,
    description:  ev.description ?? null,
    resource:     ev.resource,
    resourceKind: ev.resourceKind,
    labels:       JSON.stringify(ev.labels),
  }
}

/** Stessa normalizzazione del webhook, nessuna scrittura: anteprima per il mappatore. */
async function previewInboundEvents(_: unknown, args: { input: PreviewInput }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin', 'operator')
  const { input } = args
  assertConnectorKind(input.connectorKind, 'connectorKind')
  validateStringLength(input.payload, 'payload', 1, 1_000_000)
  let payload: unknown
  try { payload = JSON.parse(input.payload) }
  catch (e) { throw new ValidationError(`payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`) }
  const config = sourceConfigOf({
    connector_kind: input.connectorKind,
    field_mapping:  input.fieldMapping ?? null,
    default_values: input.defaultValues ?? null,
    value_mapping:  input.valueMapping ?? null,
  })
  return normalizeWithConfig(config, payload).map(toPreview)
}

/**
 * Prova end-to-end di una sorgente: il payload di esempio del SUO connettore,
 * normalizzato con la SUA configurazione, accodato come farebbe il webhook.
 * L'eventuale transform_script non si applica (il campione è già nella forma
 * del connettore).
 */
async function sendSampleEvent(_: unknown, args: { sourceId: string }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (w:InboundWebhook {id: $id, tenant_id: $tenantId})
      RETURN properties(w) AS props
    `, { id: args.sourceId, tenantId: ctx.tenantId })
    if (!row) throw new NotFoundError('InboundWebhook', args.sourceId)
    const wh = row.props
    if (wh['entity_type'] !== 'event') {
      throw new ValidationError(`Inbound webhook ${args.sourceId} is not a monitoring source (entityType ${JSON.stringify(wh['entity_type'])})`)
    }
    const config = sourceConfigOf(wh)
    const events = normalizeWithConfig(config, samplePayloadOf(config.connectorKind))
    const receivedAt = new Date().toISOString()
    const accepted = await enqueueEvents(ctx.tenantId, args.sourceId, events, receivedAt)
    await runQuery(session, `
      MATCH (w:InboundWebhook {id: $id, tenant_id: $tenantId})
      SET w.receive_count = coalesce(w.receive_count, 0) + $n,
          w.last_received_at = $now,
          w.last_error = null
    `, { id: args.sourceId, tenantId: ctx.tenantId, n: accepted, now: receivedAt })
    void audit(ctx, 'event_source.sample_sent', 'InboundWebhook', args.sourceId, { connectorKind: config.connectorKind, accepted })
    return accepted
  } finally { await session.close() }
}

/**
 * Forzatura manuale della salute: `health` ∈ operational|degraded|down scrive
 * `health` + `health_source = 'manual'` (il monitoraggio non la tocca più) e,
 * se la salute cambia, `health_since = now` (altrimenti resta com'è);
 * null toglie la forzatura e ricalcola dagli eventi firing.
 */
async function setCIHealthOverride(_: unknown, args: { ciId: string; health?: string | null }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin', 'operator')
  const now = new Date().toISOString()
  if (args.health != null) {
    if (!(CI_HEALTHS as readonly string[]).includes(args.health)) {
      throw new ValidationError(`health must be one of: ${CI_HEALTHS.join(', ')} (or null to clear the override). Got: ${JSON.stringify(args.health)}`)
    }
    const health = args.health as CIHealth
    const session = getSession(undefined, 'WRITE')
    let previous: string | null
    try {
      const row = await runQueryOne<{ previous: string | null }>(session, `
        MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
        WITH ci, ci.health AS previous
        SET ci.health = $health, ci.health_source = 'manual', ci.updated_at = $now,
            ci.health_since = CASE WHEN previous IS NULL OR previous <> $health THEN $now ELSE ci.health_since END
        RETURN previous
      `, { ciId: args.ciId, tenantId: ctx.tenantId, health, now })
      if (!row) throw new NotFoundError('ConfigurationItem', args.ciId)
      previous = row.previous ?? null
    } finally { await session.close() }
    if (previous !== health) {
      const payload: CIHealthChangedPayload = { id: args.ciId, ci_id: args.ciId, previous_health: (previous as CIHealth | null) ?? null, new_health: health }
      await publishEvent('ci.health_changed', ctx.tenantId, ctx.userId, payload, now)
    }
    void audit(ctx, 'ci.health_override_set', 'ConfigurationItem', args.ciId, { health, previous })
  } else {
    const session = getSession(undefined, 'WRITE')
    try {
      const row = await runQueryOne<{ id: string }>(session, `
        MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
        REMOVE ci.health_source
        SET ci.updated_at = $now
        RETURN ci.id AS id
      `, { ciId: args.ciId, tenantId: ctx.tenantId, now })
      if (!row) throw new NotFoundError('ConfigurationItem', args.ciId)
    } finally { await session.close() }
    // Ricalcolo dal monitoraggio: scrive health_source = 'monitoring' e
    // pubblica ci.health_changed se la salute cambia.
    await recomputeCIHealth(ctx.tenantId, args.ciId, ctx.userId)
    void audit(ctx, 'ci.health_override_cleared', 'ConfigurationItem', args.ciId)
  }
  return loadCIHealth(args.ciId, ctx.tenantId)
}

// ── Mutation ─────────────────────────────────────────────────────────────────

async function acknowledgeEvent(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<EventRow>(session, `
      MATCH (e:Event {id: $id, tenant_id: $tenantId})
      SET e.acknowledged_by = $userId, e.acknowledged_at = $now, e.updated_at = $now
      WITH e
      ${CI_REF}
    `, { id: args.id, tenantId: ctx.tenantId, userId: ctx.userId, now })
    if (!row) throw new NotFoundError('Event', args.id)
    void audit(ctx, 'event.acknowledged', 'Event', args.id)
    return mapEvent(row.props, row)
  } finally {
    await session.close()
  }
}

async function resolveEvent(_: unknown, args: { id: string; note?: string | null }, ctx: GraphQLContext) {
  validateStringLength(args.note ?? undefined, 'note', 0, 10000)
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  let row: EventRow | null
  try {
    row = await runQueryOne<EventRow>(session, `
      MATCH (e:Event {id: $id, tenant_id: $tenantId})
      SET e.status = 'resolved', e.resolved_at = $now, e.resolved_by = $userId,
          e.resolution_note = $note, e.updated_at = $now
      WITH e
      ${CI_REF}
    `, { id: args.id, tenantId: ctx.tenantId, userId: ctx.userId, note: args.note ?? null, now })
  } finally {
    await session.close()
  }
  if (!row) throw new NotFoundError('Event', args.id)
  // Salute del CI + chiusura automatica dell'incident correlato (se tutti gli allarmi sono rientrati).
  await runEventPipeline({ tenantId: ctx.tenantId, eventId: args.id, actorId: ctx.userId, now, mode: 'reevaluate' })
  await publishEvent('event.resolved', ctx.tenantId, ctx.userId, mapEventPayload(row.props, row.ciId), now)
  void audit(ctx, 'event.resolved', 'Event', args.id, { note: args.note ?? null })
  return mapEvent(row.props, row)
}

async function linkEventToCI(_: unknown, args: { eventId: string; ciId: string; createAlias?: boolean | null }, ctx: GraphQLContext) {
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  let previousCiId: string | null = null
  let row: EventRow | null
  let aliasCreated = false
  try {
    const current = await runQueryOne<EventRow>(session, `
      MATCH (e:Event {id: $id, tenant_id: $tenantId})
      ${CI_REF}
    `, { id: args.eventId, tenantId: ctx.tenantId })
    if (!current) throw new NotFoundError('Event', args.eventId)
    previousCiId = current.ciId

    // Un evento è sollevato su UN CI: il collegamento precedente viene sostituito.
    row = await runQueryOne<EventRow>(session, `
      MATCH (e:Event {id: $id, tenant_id: $tenantId})
      MATCH (target:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
      OPTIONAL MATCH (e)-[old:RAISED_ON]->(other:ConfigurationItem) WHERE other.id <> $ciId
      DELETE old
      MERGE (e)-[:RAISED_ON]->(target)
      SET e.updated_at = $now
      WITH e
      ${CI_REF}
    `, { id: args.eventId, ciId: args.ciId, tenantId: ctx.tenantId, now })
    if (!row) throw new NotFoundError('ConfigurationItem', args.ciId)

    const kind = toStr(current.props['resource_kind'])
    if (args.createAlias && (CI_ALIAS_KINDS as readonly string[]).includes(kind)) {
      const value = aliasValue(kind as CIAliasKind, toStr(current.props['resource']))
      await runQuery(session, `
        MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
        MERGE (a:CIAlias {tenant_id: $tenantId, kind: $kind, value: $value})
        ON CREATE SET a.id = $aliasId, a.source = 'manual', a.created_by = $userId, a.created_at = $now
        WITH a, ci
        OPTIONAL MATCH (a)-[old:ALIAS_OF]->(other:ConfigurationItem) WHERE other.id <> $ciId
        DELETE old
        MERGE (a)-[:ALIAS_OF]->(ci)
      `, { ciId: args.ciId, tenantId: ctx.tenantId, kind, value, aliasId: uuidv4(), userId: ctx.userId, now })
      aliasCreated = true
    }
  } finally {
    await session.close()
  }

  if (previousCiId && previousCiId !== args.ciId) await recomputeCIHealth(ctx.tenantId, previousCiId, ctx.userId)
  // Con il CI agganciato l'evento viene rivalutato per intero (finestra di
  // change, salute del nuovo CI, correlazione): è il reevaluateEvent implicito.
  const pipeline = await runEventPipeline({ tenantId: ctx.tenantId, eventId: args.eventId, actorId: ctx.userId, now, mode: 'reevaluate' })
  void audit(ctx, 'event.linked', 'Event', args.eventId, { ciId: args.ciId, previousCiId, aliasCreated, correlation: pipeline.outcome })
  return loadEvent(args.eventId, ctx.tenantId).then((r) => mapEvent(r.props, r))
}

/**
 * Rivalutazione esplicita (admin/operator) di un evento silenziato, in attesa
 * del ritardo o orfano: rilancia soppressione, salute e correlazione senza
 * ritardo. Su un evento firing "normale" o risolto è un errore di input.
 */
async function reevaluateEvent(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin', 'operator')
  const current = await loadEvent(args.id, ctx.tenantId)
  const status = toStr(current.props['status'])
  const correlation = toStr(current.props['correlation'])
  if (status !== 'suppressed' && !(REEVALUABLE_CORRELATIONS as readonly string[]).includes(correlation)) {
    throw new ValidationError(`Event ${args.id} is ${status} with correlation "${correlation}": only suppressed, delayed or skipped_orphan events can be re-evaluated`)
  }
  const pipeline = await runEventPipeline({ tenantId: ctx.tenantId, eventId: args.id, actorId: ctx.userId, mode: 'reevaluate' })
  void audit(ctx, 'event.reevaluated', 'Event', args.id, { previousStatus: status, previousCorrelation: correlation, outcome: pipeline.outcome, incidentId: pipeline.incidentId })
  const row = await loadEvent(args.id, ctx.tenantId)
  return mapEvent(row.props, row)
}

/** hostname/ip/fqdn si confrontano in minuscolo; external_id è esatto. */
function aliasValue(kind: CIAliasKind, value: string): string {
  const v = value.trim()
  return kind === 'external_id' ? v : v.toLowerCase()
}

async function createIncidentFromEvent(_: unknown, args: { eventId: string }, ctx: GraphQLContext) {
  const row = await loadEvent(args.eventId, ctx.tenantId)
  const p = row.props

  const s = getSession()
  let existingIncidentId: string | null = null
  try {
    const linked = await runQueryOne<{ incidentId: string }>(s, `
      MATCH (e:Event {id: $id, tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId})
      RETURN i.id AS incidentId LIMIT 1
    `, { id: args.eventId, tenantId: ctx.tenantId })
    existingIncidentId = linked?.incidentId ?? null
  } finally { await s.close() }
  if (existingIncidentId) {
    throw new ValidationError(`Event ${args.eventId} is already correlated into incident ${existingIncidentId}`)
  }
  // Stessa apertura della correlazione automatica (services/eventCorrelation.ts):
  // priorità/impatto/urgenza dalla policy, CI impattato, CORRELATED_INTO manual.
  const incident = await openIncidentFromEvent({ tenantId: ctx.tenantId, props: p, ciId: row.ciId, actorId: ctx.userId, manual: true })
  void audit(ctx, 'event.incident_created', 'Event', args.eventId, { incidentId: incident.id })
  return incident
}

async function createCIAlias(_: unknown, args: { ciId: string; kind: string; value: string }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  if (!(CI_ALIAS_KINDS as readonly string[]).includes(args.kind)) {
    throw new ValidationError(`kind must be one of: ${CI_ALIAS_KINDS.join(', ')}. Got: ${JSON.stringify(args.kind)}`)
  }
  validateStringLength(args.value, 'value', 1, 500)
  const value = aliasValue(args.kind as CIAliasKind, args.value)
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    const dup = await runQueryOne<{ ciId: string; ciName: string }>(session, `
      MATCH (a:CIAlias {tenant_id: $tenantId, kind: $kind, value: $value})-[:ALIAS_OF]->(ci:ConfigurationItem {tenant_id: $tenantId})
      RETURN ci.id AS ciId, ci.name AS ciName
    `, { tenantId: ctx.tenantId, kind: args.kind, value })
    if (dup) throw new ValidationError(`Alias ${args.kind}=${value} already points to CI "${dup.ciName}" (${dup.ciId})`)

    const row = await runQueryOne<{ props: Props } & CIRefRow>(session, `
      MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
      CREATE (a:CIAlias {id: $id, tenant_id: $tenantId, kind: $kind, value: $value, source: 'manual', created_by: $userId, created_at: $now})
      CREATE (a)-[:ALIAS_OF]->(ci)
      RETURN properties(a) AS props, ci.id AS ciId, ci.name AS ciName, ci.status AS ciStatus, ci.health AS ciHealth,
             [l IN labels(ci) WHERE l <> 'ConfigurationItem'] AS ciLabels
    `, { ciId: args.ciId, tenantId: ctx.tenantId, id: uuidv4(), kind: args.kind, value, userId: ctx.userId, now })
    if (!row) throw new NotFoundError('ConfigurationItem', args.ciId)
    void audit(ctx, 'ci_alias.created', 'CIAlias', toStr(row.props['id']), { ciId: args.ciId, kind: args.kind, value })
    return mapAlias(row.props, row)
  } finally {
    await session.close()
  }
}

async function deleteCIAlias(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ deleted: unknown }>(session, `
      MATCH (a:CIAlias {id: $id, tenant_id: $tenantId})
      WITH a, a.id AS id
      DETACH DELETE a
      RETURN id AS deleted
    `, { id: args.id, tenantId: ctx.tenantId })
    if (!row) throw new NotFoundError('CIAlias', args.id)
    void audit(ctx, 'ci_alias.deleted', 'CIAlias', args.id)
    return true
  } finally {
    await session.close()
  }
}

async function updateEventPolicy(_: unknown, args: { input: EventPolicyInputGQL }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const current = await getEventPolicy(ctx.tenantId)
  const next = applyEventPolicyInput(current, args.input ?? {})
  await setEventPolicy(ctx.tenantId, next)
  void audit(ctx, 'event_policy.updated', 'Tenant', ctx.tenantId, { input: args.input })
  return toEventPolicyGQL(next)
}

// ── Campi di Event ───────────────────────────────────────────────────────────

interface EventParent { id: string; acknowledgedById: string | null; sourceId: string | null; suppressedByChangeId: string | null }

async function eventAcknowledgedBy(parent: EventParent, _: unknown, ctx: GraphQLContext) {
  if (!parent.acknowledgedById) return null
  const session = getSession()
  try {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (u:User {id: $id, tenant_id: $tenantId})
      RETURN properties(u) AS props
    `, { id: parent.acknowledgedById, tenantId: ctx.tenantId })
    return row ? mapUser(row.props) : null
  } finally { await session.close() }
}

async function eventSource(parent: EventParent, _: unknown, ctx: GraphQLContext) {
  if (!parent.sourceId) return null
  const session = getSession()
  try {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (w:InboundWebhook {id: $id, tenant_id: $tenantId})
      RETURN properties(w) AS props
    `, { id: parent.sourceId, tenantId: ctx.tenantId })
    return row ? mapInbound(row.props) : null
  } finally { await session.close() }
}

async function eventIncident(parent: EventParent, _: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (e:Event {id: $id, tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId})
      RETURN properties(i) AS props
      ORDER BY i.created_at DESC LIMIT 1
    `, { id: parent.id, tenantId: ctx.tenantId })
    return row ? mapIncident(row.props) : null
  } finally { await session.close() }
}

/** La change che silenzia l'evento (solo finché `suppressed_by_change_id` è valorizzato). */
async function eventSuppressedBy(parent: EventParent, _: unknown, ctx: GraphQLContext) {
  if (!parent.suppressedByChangeId) return null
  return loadChange(null, { id: parent.suppressedByChangeId }, ctx)
}

// ── Campi di Incident / Change ───────────────────────────────────────────────

/** Allarmi correlati all'incident (CORRELATED_INTO), dal più recente. */
async function incidentCorrelatedEvents(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const rows = await runQuery<EventRow>(session, `
      MATCH (e:Event {tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {id: $id, tenant_id: $tenantId})
      WITH e ORDER BY e.last_seen_at DESC
      ${CI_REF}
    `, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => mapEvent(r.props, r))
  } finally { await session.close() }
}

/** Eventi silenziati dalla finestra della change (SUPPRESSED_BY, anche storici), dal più recente. */
async function changeSuppressedEvents(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const rows = await runQuery<EventRow>(session, `
      MATCH (e:Event {tenant_id: $tenantId})-[:SUPPRESSED_BY]->(c:Change {id: $id, tenant_id: $tenantId})
      WITH e ORDER BY e.last_seen_at DESC
      ${CI_REF}
    `, { id: parent.id, tenantId: ctx.tenantId })
    return rows.map((r) => mapEvent(r.props, r))
  } finally { await session.close() }
}

export const eventResolvers = {
  Query:    { events, event, eventStats, ciAliases, eventPolicy, sampleInboundPayload, payloadKeys, monitoringSources, ciHealth, ciHealthOverview },
  Mutation: {
    acknowledgeEvent, resolveEvent, linkEventToCI, createIncidentFromEvent, reevaluateEvent, createCIAlias, deleteCIAlias, updateEventPolicy,
    previewInboundEvents, sendSampleEvent, setCIHealthOverride,
  },
  Event:    { acknowledgedBy: eventAcknowledgedBy, source: eventSource, incident: eventIncident, suppressedBy: eventSuppressedBy },
  Incident: { correlatedEvents: incidentCorrelatedEvents },
  Change:   { suppressedEvents: changeSuppressedEvents },
}
