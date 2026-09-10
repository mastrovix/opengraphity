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
 * amministrative (alias, policy, prova di una sorgente, anteprima) e le query
 * di configurazione (sorgenti complete, chiavi/campione del wizard) sono
 * admin-only in lib/authorization.ts e hanno un requireRole locale come
 * seconda linea. Revisione (ondata 2): guardie di stato su acknowledge/resolve/
 * createIncidentFromEvent (serializzata col lock del gruppo di correlazione),
 * alias mai ri-puntati in silenzio, `Event.source` come riferimento leggero.
 *
 * Revisione (ondata 3 — prestazioni): sorgente, incident e utente della presa
 * in carico sono risolti nella STESSA query della riga (eventRowColumns) e i
 * field resolver di Event sono cortocircuiti (P-1: la console faceva
 * 1 + 1 + 50×3 query per pagina, ora 1); `events` calcola pagina e totale in
 * una query e cerca sull'indice full-text `event_search` (P-4); `eventStats`
 * legge per stato sull'indice (P-3); `ciHealthOverview` è una query con
 * COUNT { } non moltiplicativi (P-2); le liste di Incident/Change sono
 * paginate con un contatore separato (P-5).
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
import { getWorkflowSteps } from '../../lib/workflowHelpers.js'
import { withRedisLock } from '../../lib/redisLock.js'
import { applyEventPolicyInput, toEventPolicyGQL, type EventPolicyInputGQL } from '../../lib/eventPolicy.js'
import { CI_ALIAS_KINDS, CI_HEALTHS, EVENT_SEVERITIES, EVENT_STATUSES, type CIAliasKind, type CIHealth } from '../../lib/eventVocabularies.js'
import {
  getEventPolicy, setEventPolicy, mapEventPayload, recomputeCIHealth,
  assertConnectorKind, listPayloadKeys, sourceConfigOf, normalizeWithConfig, countTransitionsSince, transitionsOf,
  type NormalizedEvent,
} from '../../services/eventService.js'
import { GROUP_LOCK_OPTS, groupIdOf, groupLockKey, openIncidentFromEvent, runEventPipeline } from '../../services/eventCorrelation.js'
import { listStormSources } from '../../services/eventStorm.js'
import { enqueueEvents } from '../../jobs/eventIngestWorker.js'
import { sampleInboundPayload as samplePayloadOf } from '../../lib/eventSamples.js'
import { mapInbound } from './integrations.js'
import { change as loadChange } from './change/queries.js'
import type { CIHealthChangedPayload } from '@opengraphity/types'

type Props = Record<string, unknown>

/**
 * Massimo di un payload incollato nel wizard (payloadKeys, previewInboundEvents).
 * Il limite dichiarato prima (1 MB) era una promessa falsa: il body parser del
 * GraphQL (`express.json()` in server.ts, 100 kB di default) lo respingeva
 * molto prima. 256 kB è realistico per un payload di monitoraggio e va
 * dichiarato anche come `express.json({ limit })` dell'endpoint GraphQL.
 */
export const PAYLOAD_MAX_CHARS = 256 * 1024

/** Stati da cui una risoluzione manuale ha senso: tutto ciò che non è già risolto. */
const RESOLVABLE_STATUSES: readonly string[] = ['firing', 'suppressed', 'flapping']

/**
 * Esiti di un evento `firing` per cui `reevaluateEvent` ha sempre senso: in
 * attesa (`delayed`, `pending`), scartato (`skipped_*`), senza esito (`none`),
 * `suppressed` stantio (firing con esito di soppressione = correlazione
 * fallita dopo la fine finestra), in tempesta senza incident (`storm_no_ci`).
 * Un evento già agganciato (`opened`/`attached`/`reopened`/`storm`) è
 * rivalutabile solo se il suo incident non è più aperto (vedi reevaluateEvent).
 */
const REEVALUABLE_CORRELATIONS = ['delayed', 'pending', 'none', 'skipped_orphan', 'skipped_severity', 'suppressed', 'storm_no_ci'] as const
const CORRELATED_OUTCOMES = ['opened', 'attached', 'reopened', 'storm'] as const

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

/**
 * Colonne risolte insieme alla riga (eventRowColumns): presenti (anche null)
 * quando la riga viene da quel frammento, assenti quando l'evento è stato
 * costruito altrove. I field resolver di Event distinguono i due casi:
 * "chiave presente" = già risolto, niente query.
 */
export interface EventJoins { incident?: Props | null; source?: Props | null; acknowledgedBy?: Props | null }

export function mapEvent(props: Props, ci: CIRefRow & EventJoins) {
  // `correlation` è non-null nel contratto: la migrazione 20260909_1030 lo
  // scrive sugli eventi esistenti e ingestEvent su quelli nuovi. Assente =
  // migrazione non eseguita → errore, non un valore inventato.
  const correlation = props['correlation']
  if (typeof correlation !== 'string' || !correlation) {
    throw new Error(`Event ${toStr(props['id'])} has no correlation field — run the 20260909_1030_event_management_correlation_rules migration`)
  }
  // `labels` è non-null nel contratto: l'ingest lo scrive sempre (almeno "{}").
  // Assente = nodo scritto fuori dalla pipeline → errore, non una stringa inventata.
  const labels = props['labels']
  if (typeof labels !== 'string') {
    throw new Error(`Event ${toStr(props['id'])} has no labels field (expected a JSON string): it was not written by the ingest pipeline`)
  }
  return {
    id:             toStr(props['id']),
    fingerprint:    toStr(props['fingerprint']),
    externalId:     toStrOrNull(props['external_id']),
    resourceExternalId: toStrOrNull(props['resource_external_id']),
    status:         toStr(props['status']),
    severity:       toStr(props['severity']),
    // M9: assente sugli eventi scritti prima del campo → null (nessun valore inventato).
    maxSeverity:    toStrOrNull(props['max_severity']),
    title:          toStr(props['title']),
    description:    toStrOrNull(props['description']),
    resource:       toStr(props['resource']),
    resourceKind:   toStr(props['resource_kind']),
    labels,
    count:          toNumber(props['count']),
    firstSeenAt:    toStr(props['first_seen_at']),
    lastSeenAt:     toStr(props['last_seen_at']),
    resolvedAt:     toStrOrNull(props['resolved_at']),
    acknowledgedAt: toStrOrNull(props['acknowledged_at']),
    correlation,
    correlationAt:  toStrOrNull(props['correlation_at']),
    // A2: assente sugli eventi scritti prima del campo o mai riconosciuti automaticamente → null.
    matchReason:    toStrOrNull(props['match_reason']),
    flappingSince:  toStrOrNull(props['flapping_since']),
    transitions24h: countTransitionsSince(transitionsOf(props), Date.now() - 24 * 3600 * 1000),
    // suppressedBy resta un field resolver (loadChange); gli altri tre sono
    // nella riga quando c'è la chiave (P-1), altrimenti li carica il field resolver.
    acknowledgedById:     toStrOrNull(props['acknowledged_by']),
    sourceId:             toStrOrNull(props['source_id']),
    suppressedByChangeId: toStrOrNull(props['suppressed_by_change_id']),
    ci:             mapCIRef(ci),
    ...('incident'       in ci ? { incident:       ci.incident       ? mapIncident(ci.incident)       : null } : {}),
    ...('source'         in ci ? { source:         ci.source         ? mapSourceRef(ci.source)        : null } : {}),
    ...('acknowledgedBy' in ci ? { acknowledgedBy: ci.acknowledgedBy ? mapUser(ci.acknowledgedBy)    : null } : {}),
  }
}

/**
 * `MonitoringSourceRef`: i soli campi di un InboundWebhook che la console può
 * vedere (A-2). Mappature, script e ultimo errore (che può contenere il
 * payload) restano in `InboundWebhook`, admin-only.
 */
export function mapSourceRef(p: Props) {
  return {
    id:            toStr(p['id']),
    name:          toStr(p['name']),
    connectorKind: toStrOrNull(p['connector_kind']),
    enabled:       p['enabled'] === true,
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

/** Colonne prodotte da eventRowColumns, nell'ordine del RETURN. */
export const EVENT_ROW_KEYS = ['props', 'ciId', 'ciName', 'ciStatus', 'ciHealth', 'ciLabels', 'incident', 'source', 'acknowledgedBy'] as const

/**
 * Le colonne di un evento per mapEvent, con `e` in scope: CI (RAISED_ON),
 * incident più recente (CORRELATED_INTO), sorgente (solo i campi di
 * MonitoringSourceRef: mai script, mappature o ultimo errore — A-2) e utente
 * della presa in carico, tutti nella stessa query (P-1). Nessuna aggregazione
 * né ORDER BY: l'incident più recente è scelto con `reduce` sulla list
 * comprehension, così l'ordine delle righe in ingresso (la pagina già
 * ordinata e tagliata) resta quello. Termina con un WITH: chi lo usa aggiunge
 * `EVENT_ROW_RETURN` o un `collect`. `carry` = variabili da portare oltre.
 */
export function eventRowColumns(carry: readonly string[] = []): string {
  const keep = ['e', ...carry].join(', ')
  return `
  OPTIONAL MATCH (e)-[:RAISED_ON]->(ci:ConfigurationItem {tenant_id: $tenantId})
  WITH ${keep}, ci, [(e)-[:CORRELATED_INTO]->(inc:Incident {tenant_id: $tenantId}) | inc] AS incs
  WITH ${keep}, ci, reduce(best = null, i IN incs | CASE WHEN best IS NULL OR i.created_at > best.created_at THEN i ELSE best END) AS inc
  OPTIONAL MATCH (src:InboundWebhook {id: e.source_id, tenant_id: $tenantId})
  OPTIONAL MATCH (ack:User {id: e.acknowledged_by, tenant_id: $tenantId})
  WITH ${keep}, properties(e) AS props, ci.id AS ciId, ci.name AS ciName, ci.status AS ciStatus, ci.health AS ciHealth,
       CASE WHEN ci IS NULL THEN null ELSE [l IN labels(ci) WHERE l <> 'ConfigurationItem'] END AS ciLabels,
       CASE WHEN inc IS NULL THEN null ELSE properties(inc) END AS incident,
       CASE WHEN src IS NULL THEN null ELSE {id: src.id, name: src.name, connector_kind: src.connector_kind, enabled: src.enabled} END AS source,
       CASE WHEN ack IS NULL THEN null ELSE properties(ack) END AS acknowledgedBy`
}

export const EVENT_ROW_RETURN = `RETURN ${EVENT_ROW_KEYS.join(', ')}`
/** La riga come mappa, per `collect` dentro un CALL { }. */
const EVENT_ROW_MAP = `{${EVENT_ROW_KEYS.map((k) => `${k}: ${k}`).join(', ')}}`

type EventRow = { props: Props } & CIRefRow & EventJoins

async function loadEvent(id: string, tenantId: string): Promise<EventRow> {
  const session = getSession()
  try {
    const row = await runQueryOne<EventRow>(session, `
      MATCH (e:Event {id: $id, tenant_id: $tenantId})
      ${eventRowColumns()}
      ${EVENT_ROW_RETURN}
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

/**
 * Query Lucene per l'indice full-text `event_search` (Event.title, resource):
 * ogni run di lettere/cifre del testo diventa `*run*` (minuscolo), i run in AND.
 * Perché la wildcard anche in testa e non il solo prefisso `run*`:
 * l'analizzatore standard dell'indice tiene `example.local` come UN token
 * (verificato su Neo4j 5.26: `local*` non trova `api-03.example.local`,
 * `*local*` sì) e la console cercava per sottostringa (CONTAINS): `*run*`
 * conserva quella semantica per token e resta sull'indice (scansione del
 * dizionario dei termini, non dei nodi). I run sono solo lettere e cifre:
 * nessun carattere speciale Lucene (`+ - && || ! ( ) { } [ ] ^ " ~ * ? : \\ /`)
 * arriva al parser, quindi niente iniezione di sintassi e niente escape da
 * mantenere. Senza alcun run (es. "---") → null: nessun token può combaciare.
 */
export function eventSearchLucene(raw: string): string | null {
  const runs = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu)
  if (!runs?.length) return null
  return runs.map((r) => `*${r}*`).join(' AND ')
}

export const EMPTY_EVENT_PAGE = Object.freeze({ items: [] as ReturnType<typeof mapEvent>[], total: 0 })

async function events(_: unknown, args: { filter?: EventFilter | null; limit?: number | null; offset?: number | null }, ctx: GraphQLContext) {
  const f = args.filter ?? {}
  const limit  = Math.min(Math.max(args.limit ?? 50, 1), 500)
  const offset = Math.max(args.offset ?? 0, 0)
  const conditions: string[] = ['e.tenant_id = $tenantId']
  const params: Props = { tenantId: ctx.tenantId, limit, offset }
  let lucene: string | null = null

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
  if (f.orphan === true)  conditions.push('NOT EXISTS { (e)-[:RAISED_ON]->(:ConfigurationItem {tenant_id: $tenantId}) }')
  if (f.orphan === false) conditions.push('EXISTS { (e)-[:RAISED_ON]->(:ConfigurationItem {tenant_id: $tenantId}) }')
  if (f.search?.trim()) {
    // P-4: sull'indice full-text, non CONTAINS (scansione di tutti gli eventi
    // del tenant). Testo senza lettere né cifre: nessun token può combaciare →
    // pagina vuota senza query (è la risposta esatta, non un fallback).
    lucene = eventSearchLucene(f.search)
    if (lucene === null) return EMPTY_EVENT_PAGE
    params['search'] = lucene
  }
  if (f.since) {
    // `last_seen_at` è ISO e il confronto in Cypher è lessicografico: una data
    // parsabile ma non ISO ("9/9/2026") passerebbe la validazione e darebbe un
    // risultato arbitrario senza errore (I-5). Si normalizza sempre a ISO UTC.
    const ms = Date.parse(f.since)
    if (Number.isNaN(ms)) throw new ValidationError(`since must be an ISO date, got ${JSON.stringify(f.since)}`)
    conditions.push('e.last_seen_at >= $since'); params['since'] = new Date(ms).toISOString()
  }
  const where = 'WHERE ' + conditions.join(' AND ')
  // Con `search` la sorgente delle righe è l'indice full-text (P-4), poi lo
  // stesso WHERE (tenant per primo); senza, il MATCH sull'indice
  // (tenant_id, status, last_seen_at) o (tenant_id, last_seen_at).
  const source = lucene === null
    ? `MATCH (e:Event)\n      ${where}`
    : `CALL db.index.fulltext.queryNodes('event_search', $search) YIELD node AS e\n      ${where}`

  const session = getSession()
  try {
    // Una sola query (P-1, P-4): il totale in un CALL { } senza importazioni
    // (eseguito una volta), la pagina ordinata e tagliata PRIMA di risolvere
    // CI/incident/sorgente/utente, raccolta con collect così la riga di
    // risposta c'è anche a pagina vuota (un CALL senza righe la eliminerebbe).
    const row = await runQueryOne<{ total: unknown; items: EventRow[] }>(session, `
      CALL {
        ${source}
        RETURN count(e) AS total
      }
      CALL {
        ${source}
        WITH e ORDER BY e.last_seen_at DESC
        SKIP toInteger($offset) LIMIT toInteger($limit)
        ${eventRowColumns()}
        RETURN collect(${EVENT_ROW_MAP}) AS items
      }
      RETURN total, items
    `, params)
    if (!row) throw new Error('events: the page query returned no row (count/collect must always yield one)')
    return { items: row.items.map((r) => mapEvent(r.props, r)), total: toNumber(row.total) }
  } finally {
    await session.close()
  }
}

async function event(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const row = await runQueryOne<EventRow>(session, `
      MATCH (e:Event {id: $id, tenant_id: $tenantId})
      ${eventRowColumns()}
      ${EVENT_ROW_RETURN}
    `, { id: args.id, tenantId: ctx.tenantId })
    return row ? mapEvent(row.props, row) : null
  } finally {
    await session.close()
  }
}

/**
 * Contatori per stato, ciascuno sull'indice (tenant_id, status, last_seen_at)
 * (P-3): prima era una scansione di TUTTI gli eventi conservati (con
 * retention 90 giorni quasi tutti risolti) con un OPTIONAL MATCH del CI per
 * ognuno, solo per contare gli orfani fra i firing. `orphan` si calcola solo
 * sui firing con NOT EXISTS; i risolti sono limitati alle 24 ore
 * (indice (tenant_id, resolved_at)).
 */
async function eventStats(_: unknown, __: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const since24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const row = await runQueryOne<Record<string, unknown>>(session, `
      CALL {
        MATCH (e:Event {tenant_id: $tenantId, status: 'firing'})
        RETURN count(e) AS firing,
               count(CASE WHEN e.severity = 'critical' THEN 1 END) AS critical,
               count(CASE WHEN e.severity = 'warning'  THEN 1 END) AS warning,
               count(CASE WHEN NOT EXISTS { (e)-[:RAISED_ON]->(:ConfigurationItem {tenant_id: $tenantId}) } THEN 1 END) AS orphan
      }
      CALL {
        MATCH (e:Event {tenant_id: $tenantId, status: 'suppressed'})
        RETURN count(e) AS suppressed
      }
      CALL {
        MATCH (e:Event {tenant_id: $tenantId, status: 'flapping'})
        RETURN count(e) AS flapping
      }
      CALL {
        MATCH (e:Event {tenant_id: $tenantId, status: 'resolved'})
        WHERE e.resolved_at >= $since24h
        RETURN count(e) AS resolved24h
      }
      RETURN firing, critical, warning, orphan, suppressed, flapping, resolved24h
    `, { tenantId: ctx.tenantId, since24h })
    if (!row) throw new Error('eventStats: the counters query returned no row (count must always yield one)')
    const n = (k: string) => toNumber(row[k])
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

/** Strumento del wizard delle sorgenti: admin-only (policy centrale + seconda linea qui). */
function sampleInboundPayload(_: unknown, args: { connectorKind: string }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  return JSON.stringify(samplePayloadOf(args.connectorKind), null, 2)
}

/** JSON incollato dall'amministratore → chiavi con percorso puntato (non valido, troppo grande o troppo profondo → ValidationError). */
function payloadKeys(_: unknown, args: { payload: string }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  validateStringLength(args.payload, 'payload', 1, PAYLOAD_MAX_CHARS)
  let parsed: unknown
  try { parsed = JSON.parse(args.payload) }
  catch (e) { throw new ValidationError(`payload is not valid JSON: ${e instanceof Error ? e.message : String(e)}`) }
  return listPayloadKeys(parsed)
}

const MONITORING_SOURCES_QUERY = `
  MATCH (w:InboundWebhook {tenant_id: $tenantId, entity_type: 'event'})
  RETURN properties(w) AS props
  ORDER BY w.name`

/** Sorgenti con la configurazione completa (pagina Sorgenti): admin-only. */
async function monitoringSources(_: unknown, __: unknown, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const session = getSession()
  try {
    const rows = await runQuery<{ props: Props }>(session, MONITORING_SOURCES_QUERY, { tenantId: ctx.tenantId })
    return rows.map((r) => mapInbound(r.props))
  } finally { await session.close() }
}

/** Le stesse sorgenti come riferimenti leggeri (filtro della console, banner "nessuna sorgente"): ruoli predefiniti. */
async function monitoringSourceRefs(_: unknown, __: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const rows = await runQuery<{ props: Props }>(session, MONITORING_SOURCES_QUERY, { tenantId: ctx.tenantId })
    return rows.map((r) => mapSourceRef(r.props))
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
 *
 * `downDependents`/`degradedDependents` (D·2.6) sono la somma dei dipendenti
 * dei CI giù/degradati di TUTTO il tenant, come i contatori: prima la pagina
 * sommava le righe della pagina corrente e il numero cambiava sfogliando.
 * Sono un sum(CASE … COUNT { }) nello stesso CALL dei contatori: il COUNT
 * gira solo per i CI non operativi (i rami del CASE sono pigri) e non
 * moltiplica righe.
 *
 * Una sola query (P-2), tre CALL { } senza importazioni: contatori, totale
 * filtrato, pagina. Niente OPTIONAL MATCH in sequenza (prima erano tre:
 * firing × dipendenti × team righe intermedie per CI, poi count DISTINCT):
 * `dependents` è un COUNT { } (grado della relazione, serve all'ORDER BY
 * quindi si calcola per ogni CI filtrato), `firingEvents` e `ownerTeam` si
 * calcolano solo sulle righe della pagina, dopo SKIP/LIMIT. La pagina è un
 * collect così la riga c'è anche quando è vuota.
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
    const row = await runQueryOne<Record<string, unknown> & { items: CIHealthOverviewRow[] }>(session, `
      CALL {
        MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
        RETURN
          count(CASE WHEN ci.health = 'down'        THEN 1 END) AS down,
          count(CASE WHEN ci.health = 'degraded'    THEN 1 END) AS degraded,
          count(CASE WHEN ci.health = 'operational' THEN 1 END) AS operational,
          count(CASE WHEN ci.health IS NULL         THEN 1 END) AS unmonitored,
          sum(CASE WHEN ci.health = 'down'     THEN COUNT { (:ConfigurationItem {tenant_id: $tenantId})-[:DEPENDS_ON]->(ci) } ELSE 0 END) AS downDependents,
          sum(CASE WHEN ci.health = 'degraded' THEN COUNT { (:ConfigurationItem {tenant_id: $tenantId})-[:DEPENDS_ON]->(ci) } ELSE 0 END) AS degradedDependents
      }
      CALL {
        MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
        ${where}
        RETURN count(ci) AS total
      }
      CALL {
        MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
        ${where}
        WITH ci, COUNT { (:ConfigurationItem {tenant_id: $tenantId})-[:DEPENDS_ON]->(ci) } AS dependents
        ORDER BY ${CI_HEALTH_SEVERITY_ORDER}, dependents DESC, ci.name
        SKIP toInteger($offset) LIMIT toInteger($limit)
        RETURN collect({
          id: ci.id, name: ci.name,
          label: head([l IN labels(ci) WHERE l <> 'ConfigurationItem']),
          environment: ci.environment, health: ci.health, healthSource: ci.health_source,
          healthSince: ci.health_since, lastEventAt: ci.last_event_at,
          firingEvents: COUNT { (:Event {tenant_id: $tenantId, status: 'firing'})-[:RAISED_ON]->(ci) },
          dependents: dependents,
          ownerTeam: head([(ci)-[:OWNED_BY]->(t:Team {tenant_id: $tenantId}) | t.name])
        }) AS items
      }
      RETURN down, degraded, operational, unmonitored, downDependents, degradedDependents, total, items
    `, params)
    if (!row) throw new Error('ciHealthOverview: the overview query returned no row (count/collect must always yield one)')
    const n = (k: string) => toNumber(row[k])
    return {
      down: n('down'), degraded: n('degraded'), operational: n('operational'), unmonitored: n('unmonitored'),
      downDependents: n('downDependents'), degradedDependents: n('degradedDependents'),
      items: row.items.map(mapCIHealthRow),
      total: n('total'),
    }
  } finally { await session.close() }
}

interface PreviewInput { connectorKind: string; payload: string; fieldMapping?: string | null; defaultValues?: string | null; valueMapping?: string | null }

function toPreview(ev: NormalizedEvent) {
  return {
    externalId:   ev.externalId ?? null,
    resourceExternalId: ev.resourceExternalId ?? null,
    status:       ev.status,
    severity:     ev.severity,
    title:        ev.title,
    description:  ev.description ?? null,
    resource:     ev.resource,
    resourceKind: ev.resourceKind,
    labels:       JSON.stringify(ev.labels),
  }
}

/** Stessa normalizzazione del webhook, nessuna scrittura: anteprima per il mappatore (strumento del wizard: admin-only). */
async function previewInboundEvents(_: unknown, args: { input: PreviewInput }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const { input } = args
  assertConnectorKind(input.connectorKind, 'connectorKind')
  validateStringLength(input.payload, 'payload', 1, PAYLOAD_MAX_CHARS)
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

/** Etichetta che marca un evento di prova (sendSampleEvent) nei `labels`; l'ingest conserva i labels tali e quali (JSON su Event.labels). */
export const SAMPLE_LABEL = 'sample'

/**
 * Prova end-to-end di una sorgente: il payload di esempio del SUO connettore,
 * normalizzato con la SUA configurazione, accodato come farebbe il webhook.
 * L'eventuale transform_script non si applica (il campione è già nella forma
 * del connettore). Il campione è marcato con `labels.sample = "true"` (I-6):
 * passa dalla pipeline reale ed è indistinguibile da un allarme vero per il
 * resto (può riconoscere un CI omonimo e aprire un incident: lo dice l'SDL).
 * `last_error` NON viene azzerato: è la diagnosi dell'ultimo payload reale
 * rifiutato, e una prova riuscita non la smentisce. La sessione Neo4j viene
 * chiusa prima dell'I/O su Redis (P-6) e riaperta per le statistiche.
 * Il fuso del tenant viaggia con la normalizzazione come nel webhook
 * (rest/webhooks-inbound.ts): il campione Zabbix ha `event_date`/`event_time`
 * in ora locale e senza fuso `startsAt` resterebbe vuoto.
 */
async function sendSampleEvent(_: unknown, args: { sourceId: string }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  let wh: Props
  let timezone: string | null
  const read = getSession()
  try {
    const row = await runQueryOne<{ props: Props; timezone: unknown }>(read, `
      MATCH (w:InboundWebhook {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (t:Tenant {id: $tenantId})
      RETURN properties(w) AS props, t.timezone AS timezone
    `, { id: args.sourceId, tenantId: ctx.tenantId })
    if (!row) throw new NotFoundError('InboundWebhook', args.sourceId)
    wh = row.props
    timezone = typeof row.timezone === 'string' && row.timezone.trim() ? row.timezone : null
  } finally { await read.close() }
  if (wh['entity_type'] !== 'event') {
    throw new ValidationError(`Inbound webhook ${args.sourceId} is not a monitoring source (entityType ${JSON.stringify(wh['entity_type'])})`)
  }
  const config = sourceConfigOf(wh)
  const events: NormalizedEvent[] = normalizeWithConfig(config, samplePayloadOf(config.connectorKind), { timezone })
    .map((ev) => ({ ...ev, labels: { ...ev.labels, [SAMPLE_LABEL]: 'true' } }))
  const receivedAt = new Date().toISOString()
  const accepted = await enqueueEvents(ctx.tenantId, args.sourceId, events, receivedAt)

  const write = getSession(undefined, 'WRITE')
  try {
    await runQuery(write, `
      MATCH (w:InboundWebhook {id: $id, tenant_id: $tenantId})
      SET w.receive_count = coalesce(w.receive_count, 0) + $n,
          w.last_received_at = $now
    `, { id: args.sourceId, tenantId: ctx.tenantId, n: accepted, now: receivedAt })
  } finally { await write.close() }
  void audit(ctx, 'event_source.sample_sent', 'InboundWebhook', args.sourceId, { connectorKind: config.connectorKind, accepted })
  return accepted
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

/** Nome dell'utente del tenant per i messaggi d'errore (id se non trovato). */
async function userLabel(userId: string, tenantId: string): Promise<string> {
  const session = getSession()
  try {
    const row = await runQueryOne<{ name: string | null }>(session, `
      MATCH (u:User {id: $id, tenant_id: $tenantId})
      RETURN u.name AS name
    `, { id: userId, tenantId })
    return row?.name ? `${row.name} (${userId})` : userId
  } finally { await session.close() }
}

/**
 * Presa in carico. La guardia è nel WHERE (I-3): non un evento risolto, non
 * uno già preso in carico da un altro utente (lo stesso utente può ripetere:
 * aggiorna l'istante). Se il WHERE non passa, l'evento viene riletto per
 * distinguere "non esiste" (NotFound) dal motivo del rifiuto (Validation).
 */
async function acknowledgeEvent(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  let row: (EventRow & { previous: string | null }) | null
  try {
    row = await runQueryOne<EventRow & { previous: string | null }>(session, `
      MATCH (e:Event {id: $id, tenant_id: $tenantId})
      WHERE e.status <> 'resolved' AND (e.acknowledged_by IS NULL OR e.acknowledged_by = $userId)
      WITH e, e.acknowledged_by AS previous
      SET e.acknowledged_by = $userId, e.acknowledged_at = $now, e.updated_at = $now
      WITH e, previous
      ${eventRowColumns(['previous'])}
      ${EVENT_ROW_RETURN}, previous
    `, { id: args.id, tenantId: ctx.tenantId, userId: ctx.userId, now })
  } finally {
    await session.close()
  }
  if (!row) {
    const current = await loadEvent(args.id, ctx.tenantId)   // NotFound se non esiste
    const status = toStr(current.props['status'])
    if (status === 'resolved') throw new ValidationError(`Event ${args.id} is already resolved: nothing to acknowledge`)
    const by = toStr(current.props['acknowledged_by'])
    throw new ValidationError(`Event ${args.id} is already acknowledged by ${await userLabel(by, ctx.tenantId)} since ${toStr(current.props['acknowledged_at'])}`)
  }
  void audit(ctx, 'event.acknowledged', 'Event', args.id, { previousAcknowledgedBy: row.previous ?? null })
  return mapEvent(row.props, row)
}

/**
 * Risoluzione manuale. Solo da firing/suppressed/flapping (I-1): la doppia
 * risoluzione riscriverebbe `resolved_at` (contatore resolved24h gonfiato,
 * conservazione che slitta) e ripubblicherebbe `event.resolved`. Azzera i
 * residui `suppressed_by_change_id` e `flapping_since` come fanno la fine
 * finestra e l'uscita dallo sfarfallio: un evento risolto non è più "silenziato
 * da" né "sfarfalla da". Già risolto → ValidationError, non NotFound.
 */
async function resolveEvent(_: unknown, args: { id: string; note?: string | null }, ctx: GraphQLContext) {
  validateStringLength(args.note ?? undefined, 'note', 0, 10000)
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  let row: EventRow | null
  try {
    row = await runQueryOne<EventRow>(session, `
      MATCH (e:Event {id: $id, tenant_id: $tenantId})
      WHERE e.status IN $resolvable
      SET e.status = 'resolved', e.resolved_at = $now, e.resolved_by = $userId,
          e.resolution_note = $note, e.suppressed_by_change_id = null, e.flapping_since = null, e.updated_at = $now
      WITH e
      ${eventRowColumns()}
      ${EVENT_ROW_RETURN}
    `, { id: args.id, tenantId: ctx.tenantId, userId: ctx.userId, note: args.note ?? null, now, resolvable: RESOLVABLE_STATUSES })
  } finally {
    await session.close()
  }
  if (!row) {
    const current = await loadEvent(args.id, ctx.tenantId)   // NotFound se non esiste
    throw new ValidationError(`Event ${args.id} is already ${toStr(current.props['status'])} (since ${toStr(current.props['resolved_at'])}): only ${RESOLVABLE_STATUSES.join('/')} events can be resolved`)
  }
  // Salute del CI + chiusura automatica dell'incident correlato (se tutti gli allarmi sono rientrati).
  await runEventPipeline({ tenantId: ctx.tenantId, eventId: args.id, actorId: ctx.userId, now, mode: 'reevaluate' })
  await publishEvent('event.resolved', ctx.tenantId, ctx.userId, mapEventPayload(row.props, row.ciId), now)
  void audit(ctx, 'event.resolved', 'Event', args.id, { note: args.note ?? null })
  return mapEvent(row.props, row)
}

/**
 * Alias già esistente per (kind, value) e CI a cui punta: la regola "un alias
 * non viene mai ri-puntato in silenzio" (A-4) è la stessa di createCIAlias.
 */
async function findAliasOwner(session: Parameters<typeof runQueryOne>[0], tenantId: string, kind: string, value: string) {
  return runQueryOne<{ ciId: string; ciName: string }>(session, `
    MATCH (a:CIAlias {tenant_id: $tenantId, kind: $kind, value: $value})-[:ALIAS_OF]->(ci:ConfigurationItem {tenant_id: $tenantId})
    RETURN ci.id AS ciId, ci.name AS ciName
  `, { tenantId, kind, value })
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
      ${eventRowColumns()}
      ${EVENT_ROW_RETURN}
    `, { id: args.eventId, tenantId: ctx.tenantId })
    if (!current) throw new NotFoundError('Event', args.eventId)
    previousCiId = current.ciId

    // L'alias viene validato PRIMA di toccare il collegamento: se è rifiutato
    // la mutation non lascia effetti parziali. Stessa validazione del valore
    // di createCIAlias (I-8): una risorsa vuota non diventa un alias vuoto.
    const kind = toStr(current.props['resource_kind'])
    const wantsAlias = Boolean(args.createAlias) && (CI_ALIAS_KINDS as readonly string[]).includes(kind)
    let aliasVal: string | null = null
    if (wantsAlias) {
      aliasVal = aliasValue(kind as CIAliasKind, toStr(current.props['resource']))
      validateStringLength(aliasVal, `alias value (event resource, ${kind})`, 1, 500)
      const owner = await findAliasOwner(session, ctx.tenantId, kind, aliasVal)
      if (owner && owner.ciId !== args.ciId) {
        throw new ValidationError(`Alias ${kind}=${aliasVal} already points to CI "${owner.ciName}" (${owner.ciId}): link without createAlias, or delete that alias first`)
      }
    }

    // Un evento è sollevato su UN CI: il collegamento precedente viene sostituito.
    // `match_reason = 'manual'` (D·API): chi legge l'evento vede che il CI è
    // stato scelto da un operatore, non dal riconoscimento (che con il CI già
    // agganciato non gira e non sovrascrive il valore).
    row = await runQueryOne<EventRow>(session, `
      MATCH (e:Event {id: $id, tenant_id: $tenantId})
      MATCH (target:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
      OPTIONAL MATCH (e)-[old:RAISED_ON]->(other:ConfigurationItem) WHERE other.id <> $ciId
      DELETE old
      MERGE (e)-[:RAISED_ON]->(target)
      SET e.updated_at = $now, e.match_reason = 'manual'
      WITH e
      ${eventRowColumns()}
      ${EVENT_ROW_RETURN}
    `, { id: args.eventId, ciId: args.ciId, tenantId: ctx.tenantId, now })
    if (!row) throw new NotFoundError('ConfigurationItem', args.ciId)

    if (wantsAlias && aliasVal !== null) {
      // L'alias, se esiste, punta già a questo CI (verificato sopra): il MERGE
      // dell'ALIAS_OF è idempotente e ON MATCH registra chi lo ha "toccato"
      // (un alias di discovery confermato a mano lo dichiara).
      await runQuery(session, `
        MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
        MERGE (a:CIAlias {tenant_id: $tenantId, kind: $kind, value: $value})
        ON CREATE SET a.id = $aliasId, a.source = 'manual', a.created_by = $userId, a.created_at = $now
        ON MATCH SET a.updated_by = $userId, a.updated_at = $now
        MERGE (a)-[:ALIAS_OF]->(ci)
      `, { ciId: args.ciId, tenantId: ctx.tenantId, kind, value: aliasVal, aliasId: uuidv4(), userId: ctx.userId, now })
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

/** Incident non terminale a cui l'evento è correlato (CORRELATED_INTO), se esiste. */
async function openIncidentOfEvent(eventId: string, tenantId: string): Promise<{ incidentId: string; number: string | null; step: string } | null> {
  const session = getSession()
  try {
    const terminalSteps = (await getWorkflowSteps(session, tenantId, 'incident')).filter((s) => s.isTerminal).map((s) => s.name)
    return await runQueryOne<{ incidentId: string; number: string | null; step: string }>(session, `
      MATCH (e:Event {id: $id, tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId})
      MATCH (i)-[:HAS_WORKFLOW]->(wi:WorkflowInstance {tenant_id: $tenantId})
      WHERE NOT wi.current_step IN $terminalSteps
      RETURN i.id AS incidentId, i.number AS number, wi.current_step AS step
      ORDER BY i.created_at DESC LIMIT 1
    `, { id: eventId, tenantId, terminalSteps })
  } finally { await session.close() }
}

/**
 * Rivalutazione esplicita (admin/operator) di un evento: rilancia soppressione,
 * salute e correlazione senza ritardo. Accetta gli eventi silenziati e i
 * firing senza incident (in attesa, scartati, `pending`/`none`, `suppressed`
 * stantio, `storm_no_ci`) e i firing già correlati il cui incident è stato
 * chiuso. Rifiuta con un messaggio esplicito (nessun no-op silenzioso) un
 * evento risolto, in sfarfallio, o già agganciato a un incident ancora aperto.
 */
async function reevaluateEvent(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin', 'operator')
  const current = await loadEvent(args.id, ctx.tenantId)
  const status = toStr(current.props['status'])
  const correlation = toStr(current.props['correlation'])
  if (status !== 'suppressed') {
    if (status !== 'firing') {
      throw new ValidationError(`Event ${args.id} is ${status} with correlation "${correlation}": only suppressed or firing events can be re-evaluated`)
    }
    if ((CORRELATED_OUTCOMES as readonly string[]).includes(correlation)) {
      const open = await openIncidentOfEvent(args.id, ctx.tenantId)
      if (open) {
        throw new ValidationError(`Event ${args.id} is already correlated into open incident ${open.number ?? open.incidentId} (step "${open.step}"): nothing to re-evaluate`)
      }
    } else if (!(REEVALUABLE_CORRELATIONS as readonly string[]).includes(correlation)) {
      throw new ValidationError(`Event ${args.id} is ${status} with correlation "${correlation}": not re-evaluable`)
    }
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

/** Incident a cui l'evento è già correlato (CORRELATED_INTO), se esiste. */
async function correlatedIncidentId(eventId: string, tenantId: string): Promise<string | null> {
  const s = getSession()
  try {
    const linked = await runQueryOne<{ incidentId: string }>(s, `
      MATCH (e:Event {id: $id, tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {tenant_id: $tenantId})
      RETURN i.id AS incidentId LIMIT 1
    `, { id: eventId, tenantId })
    return linked?.incidentId ?? null
  } finally { await s.close() }
}

/**
 * Apertura manuale (I-2). Solo un evento `firing`: da uno risolto l'incident
 * nascerebbe morto, da uno silenziato contraddirebbe la finestra di change, da
 * uno in sfarfallio la sospensione della correlazione. Serializzata con
 * `withRedisLock` sulla STESSA chiave di gruppo della correlazione automatica
 * (services/eventCorrelation.ts: `groupLockKey(tenant, group_by, groupIdOf)`):
 * lettura, controllo "già correlato" e apertura stanno dentro il lock, così
 * due click ravvicinati — o un click e l'apertura automatica sullo stesso
 * gruppo — non producono due incident. Scelto il lock esistente e non un SET
 * condizionale su `correlation`, perché il conflitto da evitare è con la
 * pipeline, che usa già quel lock.
 */
async function createIncidentFromEvent(_: unknown, args: { eventId: string }, ctx: GraphQLContext) {
  const first = await loadEvent(args.eventId, ctx.tenantId)
  const policy = await getEventPolicy(ctx.tenantId)
  const lockKey = groupLockKey(ctx.tenantId, policy.group_by, groupIdOf(policy, { ciId: first.ciId, props: first.props }))
  const incident = await withRedisLock(lockKey, GROUP_LOCK_OPTS, async () => {
    // Riletto sotto il lock: lo stato può essere cambiato nell'attesa.
    const row = await loadEvent(args.eventId, ctx.tenantId)
    const status = toStr(row.props['status'])
    if (status !== 'firing') {
      throw new ValidationError(`Event ${args.eventId} is ${status}: only a firing event can open an incident`)
    }
    const existingIncidentId = await correlatedIncidentId(args.eventId, ctx.tenantId)
    if (existingIncidentId) {
      throw new ValidationError(`Event ${args.eventId} is already correlated into incident ${existingIncidentId}`)
    }
    // Stessa apertura della correlazione automatica (services/eventCorrelation.ts):
    // priorità/impatto/urgenza dalla policy, CI impattato, CORRELATED_INTO manual.
    return openIncidentFromEvent({ tenantId: ctx.tenantId, props: row.props, ciId: row.ciId, actorId: ctx.userId, manual: true })
  }, undefined, 'manual incident creation still pending')
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

/**
 * Merge dell'input sulla policy attuale con validazione (massimi, coerenza),
 * `version` + 1 e `updated_at`; `expectedVersion` diverso dall'attuale →
 * ValidationError (modifica concorrente di un altro amministratore).
 */
async function updateEventPolicy(_: unknown, args: { input: EventPolicyInputGQL }, ctx: GraphQLContext) {
  requireRole(ctx, 'admin')
  const current = await getEventPolicy(ctx.tenantId)
  const next = applyEventPolicyInput(current, args.input ?? {})
  await setEventPolicy(ctx.tenantId, next)
  void audit(ctx, 'event_policy.updated', 'Tenant', ctx.tenantId, { input: args.input, version: next.version, previousVersion: current.version })
  return toEventPolicyGQL(next)
}

// ── Campi di Event ───────────────────────────────────────────────────────────

/**
 * Il parent è l'output di mapEvent: quando viene da eventRowColumns porta già
 * `incident`/`source`/`acknowledgedBy` (anche null) e i field resolver li
 * restituiscono senza query (P-1). Le query qui sotto restano per un parent
 * costruito senza il frammento.
 */
interface EventParent {
  id: string; correlation?: string
  acknowledgedById: string | null; sourceId: string | null; suppressedByChangeId: string | null
  incident?: ReturnType<typeof mapIncident> | null
  source?: ReturnType<typeof mapSourceRef> | null
  acknowledgedBy?: ReturnType<typeof mapUser> | null
}

async function eventAcknowledgedBy(parent: EventParent, _: unknown, ctx: GraphQLContext) {
  if (parent.acknowledgedBy !== undefined) return parent.acknowledgedBy
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

/** `Event.source` come MonitoringSourceRef: mai la configurazione completa (A-2). */
async function eventSource(parent: EventParent, _: unknown, ctx: GraphQLContext) {
  if (parent.source !== undefined) return parent.source
  if (!parent.sourceId) return null
  const session = getSession()
  try {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (w:InboundWebhook {id: $id, tenant_id: $tenantId})
      RETURN properties(w) AS props
    `, { id: parent.sourceId, tenantId: ctx.tenantId })
    return row ? mapSourceRef(row.props) : null
  } finally { await session.close() }
}

/**
 * Esiti di correlazione che garantiscono l'assenza di CORRELATED_INTO:
 * `delayed` viene scritto solo su un evento MAI correlato (eventCorrelation.ts,
 * passo 5: count(CORRELATED_INTO) = 0) e ogni aggancio successivo cambia
 * l'esito. Gli altri esiti "senza incident" (none, skipped_*, pending,
 * suppressed, flapping, storm_no_ci) NON lo garantiscono: la relazione non
 * viene mai cancellata (un allarme rientrato e riacceso, o uscito dallo
 * sfarfallio, resta collegato all'incident storico) e il contratto dice
 * "incident a cui l'evento è correlato, se esiste": per quelli si interroga.
 */
export const CORRELATIONS_WITHOUT_INCIDENT: readonly string[] = ['delayed']

async function eventIncident(parent: EventParent, _: unknown, ctx: GraphQLContext) {
  if (parent.incident !== undefined) return parent.incident
  if (parent.correlation !== undefined && CORRELATIONS_WITHOUT_INCIDENT.includes(parent.correlation)) return null
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

/** Pagina delle liste di allarmi di Incident/Change (P-5): default 100, cap 500. */
export const LINKED_EVENTS_DEFAULT_LIMIT = 100
export const LINKED_EVENTS_MAX_LIMIT = 500

interface PageArgs { limit?: number | null; offset?: number | null }
function pageOf(args: PageArgs | null | undefined) {
  return {
    limit:  Math.min(Math.max(args?.limit ?? LINKED_EVENTS_DEFAULT_LIMIT, 1), LINKED_EVENTS_MAX_LIMIT),
    offset: Math.max(args?.offset ?? 0, 0),
  }
}

/**
 * Allarmi correlati all'incident (CORRELATED_INTO), dal più recente, paginati
 * (P-5: un incident di tempesta ne aggrega migliaia). Il totale è
 * `correlatedEventCount`, separato, così la lista non lo ripete a ogni riga.
 */
async function incidentCorrelatedEvents(parent: { id: string }, args: PageArgs, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const rows = await runQuery<EventRow>(session, `
      MATCH (e:Event {tenant_id: $tenantId})-[:CORRELATED_INTO]->(i:Incident {id: $id, tenant_id: $tenantId})
      WITH e ORDER BY e.last_seen_at DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
      ${eventRowColumns()}
      ${EVENT_ROW_RETURN}
    `, { id: parent.id, tenantId: ctx.tenantId, ...pageOf(args) })
    return rows.map((r) => mapEvent(r.props, r))
  } finally { await session.close() }
}

async function incidentCorrelatedEventCount(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const row = await runQueryOne<{ n: unknown }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      RETURN COUNT { (:Event {tenant_id: $tenantId})-[:CORRELATED_INTO]->(i) } AS n
    `, { id: parent.id, tenantId: ctx.tenantId })
    if (!row) throw new NotFoundError('Incident', parent.id)
    return toNumber(row.n)
  } finally { await session.close() }
}

/** Allarmi correlati eliminati dalla conservazione dopo la chiusura (riepilogo scritto da purge_events; revisione 2.2). */
async function incidentCorrelatedEventsPurged(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const row = await runQueryOne<{ n: unknown }>(session, `
      MATCH (i:Incident {id: $id, tenant_id: $tenantId})
      RETURN coalesce(i.correlated_events_purged, 0) AS n
    `, { id: parent.id, tenantId: ctx.tenantId })
    if (!row) throw new NotFoundError('Incident', parent.id)
    return toNumber(row.n)
  } finally { await session.close() }
}

/** Eventi silenziati dalla finestra della change (SUPPRESSED_BY, anche storici), dal più recente, paginati (P-5). */
async function changeSuppressedEvents(parent: { id: string }, args: PageArgs, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const rows = await runQuery<EventRow>(session, `
      MATCH (e:Event {tenant_id: $tenantId})-[:SUPPRESSED_BY]->(c:Change {id: $id, tenant_id: $tenantId})
      WITH e ORDER BY e.last_seen_at DESC
      SKIP toInteger($offset) LIMIT toInteger($limit)
      ${eventRowColumns()}
      ${EVENT_ROW_RETURN}
    `, { id: parent.id, tenantId: ctx.tenantId, ...pageOf(args) })
    return rows.map((r) => mapEvent(r.props, r))
  } finally { await session.close() }
}

async function changeSuppressedEventCount(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const row = await runQueryOne<{ n: unknown }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      RETURN COUNT { (:Event {tenant_id: $tenantId})-[:SUPPRESSED_BY]->(c) } AS n
    `, { id: parent.id, tenantId: ctx.tenantId })
    if (!row) throw new NotFoundError('Change', parent.id)
    return toNumber(row.n)
  } finally { await session.close() }
}

/** Eventi silenziati eliminati dalla conservazione dopo la chiusura della change (revisione 2.2). */
async function changeSuppressedEventsPurged(parent: { id: string }, _: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const row = await runQueryOne<{ n: unknown }>(session, `
      MATCH (c:Change {id: $id, tenant_id: $tenantId})
      RETURN coalesce(c.suppressed_events_purged, 0) AS n
    `, { id: parent.id, tenantId: ctx.tenantId })
    if (!row) throw new NotFoundError('Change', parent.id)
    return toNumber(row.n)
  } finally { await session.close() }
}

export const eventResolvers = {
  Query:    { events, event, eventStats, ciAliases, eventPolicy, sampleInboundPayload, payloadKeys, monitoringSources, monitoringSourceRefs, ciHealth, ciHealthOverview },
  Mutation: {
    acknowledgeEvent, resolveEvent, linkEventToCI, createIncidentFromEvent, reevaluateEvent, createCIAlias, deleteCIAlias, updateEventPolicy,
    previewInboundEvents, sendSampleEvent, setCIHealthOverride,
  },
  Event:    { acknowledgedBy: eventAcknowledgedBy, source: eventSource, incident: eventIncident, suppressedBy: eventSuppressedBy },
  Incident: { correlatedEvents: incidentCorrelatedEvents, correlatedEventCount: incidentCorrelatedEventCount, correlatedEventsPurged: incidentCorrelatedEventsPurged },
  Change:   { suppressedEvents: changeSuppressedEvents, suppressedEventCount: changeSuppressedEventCount, suppressedEventsPurged: changeSuppressedEventsPurged },
}
