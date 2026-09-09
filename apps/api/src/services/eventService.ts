/**
 * Event Management — dagli allarmi del monitoraggio alla salute del CI.
 *
 * Pipeline: webhook in ingresso → `sourceConfigOf` (config del webhook) →
 * `normalizePayload` (per connettore: generic, alertmanager, grafana, zabbix,
 * datadog, dynatrace) → coda `events-ingest` → `ingestEvent` (MERGE per impronta,
 * deduplica) → `matchCI` (alias, poi nome) → `runEventPipeline`
 * (services/eventCorrelation.ts: soppressione in finestra di change →
 * `recomputeCIHealth` → correlazione in incident / chiusura automatica).
 * `previewInboundEvents` e `sendSampleEvent` usano la stessa normalizzazione.
 *
 * Ondata 4: ogni passaggio firing↔resolved del payload viene registrato in
 * `Event.transitions` (ultimi MAX_TRANSITIONS istanti ISO) insieme a
 * `last_payload_status`; la pipeline decide lo sfarfallio (`flapping`) e le
 * tempeste per sorgente (services/eventStorm.ts). Un evento `flapping` pesa
 * come `degraded` sulla salute del CI (instabilità, non guasto pieno).
 *
 * Il monitoraggio scrive SOLO `ci.health` (operational/degraded/down),
 * `ci.health_source` e `ci.last_event_at`; non tocca mai `ci.status`, che è
 * il ciclo di vita del CI (active/inactive/maintenance/decommissioned).
 *
 * Le funzioni pure (`normalizePayload`, `fingerprintOf`, `nextEventState`,
 * `countTransitionsSince`, `deriveCIHealth`) non toccano il grafo e sono
 * testate da sole; quelle di accesso al grafo usano `@opengraphity/neo4j`
 * come gli altri servizi.
 *
 * Niente fallback silenziosi: payload malformato → ValidationError (→ 400 dal
 * webhook), policy del tenant mancante/corrotta → errore (lib/eventPolicy.ts).
 */
import { createHash } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { getSession, runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { CIHealth, CIHealthChangedPayload, MonitoringEventPayload } from '@opengraphity/types'
import { ValidationError, NotFoundError } from '../lib/errors.js'
import { publishEvent } from '../lib/publishEvent.js'
import { logger } from '../lib/logger.js'
import { parseEventPolicy, type EventPolicy } from '../lib/eventPolicy.js'
import { eventsDeduplicatedTotal, eventsOrphanTotal, eventsReceivedTotal } from '../middleware/metrics.js'
import { runEventPipeline } from './eventCorrelation.js'

const log = logger.child({ module: 'event-service' })

// ── Tipi ─────────────────────────────────────────────────────────────────────

/**
 * Connettori preset (ondata 2: tutto configurabile da interfaccia, senza
 * codice). `generic` è il mappatore visuale (field_mapping con percorsi
 * puntati + value_mapping); gli altri conoscono già la forma del webhook
 * dello strumento.
 */
export const CONNECTOR_KINDS = ['generic', 'alertmanager', 'grafana', 'zabbix', 'datadog', 'dynatrace'] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

export const EVENT_STATUSES_INPUT = ['firing', 'resolved'] as const
export const EVENT_SEVERITIES     = ['info', 'warning', 'critical'] as const
export const RESOURCE_KINDS       = ['hostname', 'ip', 'fqdn', 'external_id', 'name'] as const
/** I kind di `CIAlias` (schema-events.ts): `name` non è un alias, è il nome del CI stesso. */
export const CI_ALIAS_KINDS       = ['hostname', 'ip', 'fqdn', 'external_id'] as const

export type EventInputStatus = (typeof EVENT_STATUSES_INPUT)[number]
export type EventSeverity    = (typeof EVENT_SEVERITIES)[number]
export type ResourceKind     = (typeof RESOURCE_KINDS)[number]
export type CIAliasKind      = (typeof CI_ALIAS_KINDS)[number]

export type NormalizedEvent = {
  externalId?: string
  status: EventInputStatus
  severity: EventSeverity
  title: string
  description?: string
  resource: string
  resourceKind: ResourceKind
  labels: Record<string, string>
  startsAt?: string
  endsAt?: string
}

/** Massimo allarmi per richiesta al webhook (oltre → 400). */
export const MAX_EVENTS_PER_REQUEST = 500

const SEVERITY_RANK: Record<EventSeverity, number> = { info: 0, warning: 1, critical: 2 }

type Props = Record<string, unknown>

// ── Helper puri ──────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${what} must be one of: ${allowed.join(', ')}. Got: ${JSON.stringify(value)}`)
  }
  return value as T
}

function nonEmptyString(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${what} is missing or empty`)
  }
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  if (value == null || value === '') return undefined
  return typeof value === 'string' ? value : String(value)
}

/** Etichette della sorgente → mappa di stringhe (i valori non stringa vengono serializzati). */
function stringLabels(value: unknown, what: string): Record<string, string> {
  if (value == null) return {}
  if (!isRecord(value)) throw new ValidationError(`${what} must be an object of labels`)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (v == null) continue
    out[k] = typeof v === 'string' ? v : JSON.stringify(v)
  }
  return out
}

/** `host:9100` → `host`; `[::1]:9100` → `[::1]`. */
export function stripPort(instance: string): string {
  const m = /^(.*):\d+$/.exec(instance)
  return m ? m[1]! : instance
}

export function assertConnectorKind(value: unknown, what = 'connector_kind'): ConnectorKind {
  return oneOf(value, CONNECTOR_KINDS, what)
}

// ── Percorsi puntati (generic + payloadKeys) ─────────────────────────────────

/**
 * Valore a un percorso puntato (`alert.name`, `alerts.0.labels.instance`):
 * ogni segmento è una chiave d'oggetto o un indice di array. `undefined` se
 * un segmento non esiste. Puro, senza fallback: un percorso vuoto è un errore
 * di configurazione.
 */
export function getPath(payload: unknown, path: string, what = 'path'): unknown {
  const p = path.trim()
  if (!p) throw new ValidationError(`${what} is empty`)
  let cur: unknown = payload
  for (const seg of p.split('.')) {
    if (cur == null) return undefined
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined
      cur = cur[Number(seg)]
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg]
    } else {
      return undefined
    }
  }
  return cur
}

export const PAYLOAD_KEYS_MAX    = 300
export const PAYLOAD_SAMPLE_CHARS = 60

export interface PayloadKey { path: string; sample: string }

/**
 * Tutti i percorsi puntati foglia di un payload (array espansi con indice),
 * con un valore d'esempio troncato: alimenta il mappatore visuale. Al massimo
 * `PAYLOAD_KEYS_MAX` chiavi, in ordine di visita (profondità).
 */
export function listPayloadKeys(payload: unknown): PayloadKey[] {
  const out: PayloadKey[] = []
  const visit = (value: unknown, prefix: string) => {
    if (out.length >= PAYLOAD_KEYS_MAX) return
    if (Array.isArray(value)) {
      if (value.length === 0) { out.push({ path: prefix, sample: '[]' }); return }
      value.forEach((v, i) => visit(v, prefix ? `${prefix}.${i}` : String(i)))
      return
    }
    if (isRecord(value)) {
      const keys = Object.keys(value)
      if (keys.length === 0) { out.push({ path: prefix, sample: '{}' }); return }
      for (const k of keys) visit(value[k], prefix ? `${prefix}.${k}` : k)
      return
    }
    if (!prefix) return   // payload scalare alla radice: nessuna chiave
    const raw = value === null ? 'null' : typeof value === 'string' ? value : JSON.stringify(value)
    out.push({ path: prefix, sample: raw.length > PAYLOAD_SAMPLE_CHARS ? `${raw.slice(0, PAYLOAD_SAMPLE_CHARS)}…` : raw })
  }
  visit(payload, '')
  return out.slice(0, PAYLOAD_KEYS_MAX)
}

// ── normalizePayload ─────────────────────────────────────────────────────────

/**
 * Alertmanager e Grafana condividono la forma `{ alerts: [...] }`. Grafana
 * (unified alerting) non ha sempre `labels.instance`: in sua assenza vale
 * `labels.host`.
 */
function normalizeAlertsArray(kind: 'alertmanager' | 'grafana', payload: unknown, defaults: Record<string, unknown>): NormalizedEvent[] {
  const name = kind === 'grafana' ? 'Grafana' : 'Alertmanager'
  if (!isRecord(payload)) throw new ValidationError(`${name} payload must be a JSON object with an \`alerts\` array`)
  const alerts = payload['alerts']
  if (!Array.isArray(alerts)) throw new ValidationError(`${name} payload has no \`alerts\` array`)
  if (alerts.length > MAX_EVENTS_PER_REQUEST) {
    throw new ValidationError(`Too many alerts in one request: ${alerts.length} (max ${MAX_EVENTS_PER_REQUEST})`)
  }
  return alerts.map((alert, i) => {
    const at = `alerts[${i}]`
    if (!isRecord(alert)) throw new ValidationError(`${at} is not an object`)
    const labels = alert['labels']
    if (!isRecord(labels)) throw new ValidationError(`${at}.labels is missing or not an object`)
    const annotations = isRecord(alert['annotations']) ? alert['annotations'] : {}

    const title    = nonEmptyString(labels['alertname'], `${at}.labels.alertname`)
    const severity = oneOf(labels['severity'] ?? defaults['severity'], EVENT_SEVERITIES, `${at}.labels.severity`)
    const status   = oneOf(alert['status'], EVENT_STATUSES_INPUT, `${at}.status`)
    let resource: string
    if (kind === 'grafana' && (labels['instance'] == null || labels['instance'] === '')) {
      resource = nonEmptyString(labels['host'], `${at}.labels.instance (or labels.host)`)
    } else {
      resource = stripPort(nonEmptyString(labels['instance'], `${at}.labels.instance`))
    }
    const summary  = optionalString(annotations['summary'])
    const detail   = optionalString(annotations['description'])
    const description = [summary, detail].filter((s): s is string => !!s && s.trim() !== '').join('\n') || undefined

    const ev: NormalizedEvent = {
      status, severity, title,
      resource,
      resourceKind: 'hostname',
      labels:       stringLabels(labels, `${at}.labels`),
    }
    const externalId = optionalString(alert['fingerprint'])
    if (externalId) ev.externalId = externalId
    if (description) ev.description = description
    const startsAt = optionalString(alert['startsAt']); if (startsAt) ev.startsAt = startsAt
    const endsAt   = optionalString(alert['endsAt']);   if (endsAt && !endsAt.startsWith('0001-')) ev.endsAt = endsAt
    return ev
  })
}

/** Severità di Zabbix (media type webhook, `{EVENT.SEVERITY}`) → vocabolario interno. */
export const ZABBIX_SEVERITY: Readonly<Record<string, EventSeverity>> = {
  'not classified': 'info',
  'information':    'info',
  'warning':        'warning',
  'average':        'warning',
  'high':           'critical',
  'disaster':       'critical',
}

/**
 * Zabbix: un oggetto per chiamata (media type "webhook" con parametri
 * event_id, event_name/trigger_name, event_severity, event_value, host_name,
 * host_ip, trigger_description, event_opdata).
 */
function normalizeZabbix(payload: unknown, defaults: Record<string, unknown>): NormalizedEvent[] {
  if (!isRecord(payload)) throw new ValidationError('Zabbix payload must be a JSON object (one event per request)')
  const externalId = optionalString(payload['event_id'])
  if (!externalId) throw new ValidationError('event_id is missing or empty')
  const title = nonEmptyString(payload['event_name'] ?? payload['trigger_name'], 'event_name (or trigger_name)')

  const rawSeverity = optionalString(payload['event_severity'] ?? defaults['severity'])
  if (!rawSeverity) throw new ValidationError('event_severity is missing (Not classified | Information | Warning | Average | High | Disaster)')
  const severity = ZABBIX_SEVERITY[rawSeverity.trim().toLowerCase()]
  if (!severity) throw new ValidationError(`event_severity must be one of: Not classified, Information, Warning, Average, High, Disaster. Got: ${JSON.stringify(rawSeverity)}`)

  const rawValue = optionalString(payload['event_value'])
  if (rawValue !== '0' && rawValue !== '1') throw new ValidationError(`event_value must be "1" (problem) or "0" (recovery). Got: ${JSON.stringify(payload['event_value'] ?? null)}`)
  const status: EventInputStatus = rawValue === '1' ? 'firing' : 'resolved'

  const hostName = optionalString(payload['host_name'])
  const hostIp   = optionalString(payload['host_ip'])
  let resource: string
  let resourceKind: ResourceKind
  if (hostName && hostName.trim()) { resource = hostName.trim(); resourceKind = 'hostname' }
  else if (hostIp && hostIp.trim()) { resource = hostIp.trim(); resourceKind = 'ip' }
  else throw new ValidationError('host_name (or host_ip) is missing or empty')

  const parts = [optionalString(payload['trigger_description']), optionalString(payload['event_opdata'])]
    .filter((s): s is string => !!s && s.trim() !== '')
  const labels: Record<string, string> = {}
  for (const k of ['host_name', 'host_ip', 'event_severity', 'trigger_id', 'event_tags', 'event_nseverity'] as const) {
    const v = optionalString(payload[k]); if (v) labels[k] = v
  }

  const ev: NormalizedEvent = { externalId, status, severity, title, resource, resourceKind, labels }
  if (parts.length) ev.description = parts.join('\n')
  const startsAt = optionalString(payload['event_date'] && payload['event_time'] ? `${String(payload['event_date'])} ${String(payload['event_time'])}` : undefined)
  if (startsAt) ev.startsAt = startsAt
  return [ev]
}

/** Transizioni di Datadog (`$ALERT_TRANSITION`) → stato dell'evento. */
export const DATADOG_TRANSITION: Readonly<Record<string, EventInputStatus>> = {
  'triggered':    'firing',
  're-triggered': 'firing',
  'warn':         'firing',
  'no data':      'firing',
  'recovered':    'resolved',
}

/** Etichette di Datadog: lista di `chiave:valore`, stringa separata da virgole o oggetto. */
function datadogTags(raw: unknown): Record<string, string> {
  if (raw == null || raw === '') return {}
  if (isRecord(raw)) return stringLabels(raw, 'tags')
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null
  if (!items) throw new ValidationError('tags must be a list of "key:value" strings, a comma-separated string or an object')
  const out: Record<string, string> = {}
  for (const item of items) {
    const s = typeof item === 'string' ? item.trim() : JSON.stringify(item)
    if (!s) continue
    const idx = s.indexOf(':')
    if (idx > 0) out[s.slice(0, idx)] = s.slice(idx + 1)
    else out[s] = 'true'
  }
  return out
}

/**
 * Datadog: un oggetto per chiamata (webhook integration con variabili
 * $ALERT_ID, $ALERT_TRANSITION, $ALERT_TYPE, $EVENT_TITLE, $EVENT_MSG/$TEXT_ONLY_MSG,
 * $HOSTNAME, $TAGS).
 */
function normalizeDatadog(payload: unknown, defaults: Record<string, unknown>): NormalizedEvent[] {
  if (!isRecord(payload)) throw new ValidationError('Datadog payload must be a JSON object (one alert per request)')
  const externalId = optionalString(payload['alert_id'])
  if (!externalId) throw new ValidationError('alert_id is missing or empty')
  const title = nonEmptyString(payload['title'], 'title')

  const rawTransition = optionalString(payload['alert_transition'])
  if (!rawTransition) throw new ValidationError('alert_transition is missing (Triggered | Re-Triggered | Warn | No Data | Recovered)')
  const status = DATADOG_TRANSITION[rawTransition.trim().toLowerCase()]
  if (!status) throw new ValidationError(`alert_transition must be one of: Triggered, Re-Triggered, Warn, No Data, Recovered. Got: ${JSON.stringify(rawTransition)}`)

  const rawType = optionalString(payload['alert_type'] ?? defaults['severity'])
  if (!rawType) throw new ValidationError('alert_type is missing (error | warning | info | success)')
  const t = rawType.trim().toLowerCase()
  const severity: EventSeverity = t === 'error' ? 'critical' : t === 'warning' ? 'warning' : 'info'

  const resource = nonEmptyString(payload['hostname'], 'hostname')
  const body = optionalString(payload['body']) ?? optionalString(payload['text'])

  const ev: NormalizedEvent = {
    externalId, status, severity, title,
    resource: stripPort(resource), resourceKind: 'hostname',
    labels: datadogTags(payload['tags']),
  }
  if (body && body.trim()) ev.description = body
  const date = payload['date']
  if (typeof date === 'number' && Number.isFinite(date)) ev.startsAt = new Date(date < 1e12 ? date * 1000 : date).toISOString()
  else { const s = optionalString(date); if (s) ev.startsAt = s }
  return [ev]
}

/** Stato del problema di Dynatrace (`{State}`) → stato dell'evento. */
export const DYNATRACE_STATE: Readonly<Record<string, EventInputStatus>> = {
  'open':     'firing',
  'resolved': 'resolved',
}

/** Severità del problema di Dynatrace (`{ProblemSeverity}`) → vocabolario interno. */
export const DYNATRACE_SEVERITY: Readonly<Record<string, EventSeverity>> = {
  'availability':           'critical',
  'error':                  'critical',
  'performance':            'warning',
  'resource_contention':    'warning',
  'custom_alert':           'warning',
  'monitoring_unavailable': 'info',
}

/**
 * Dynatrace: un problema per chiamata (Problem notifications → Custom
 * integration con payload personalizzato: {State}, {ProblemID}, {PID},
 * {ProblemTitle}, {ProblemSeverity}, {ProblemImpact}, {ImpactedEntity},
 * {ImpactedEntities}, {ProblemDetailsText}, {ProblemURL}, {Tags}).
 * La risorsa è il `name` del primo elemento di `ImpactedEntities` (hostname);
 * senza elementi si usa la stringa `ImpactedEntity` (name).
 */
function normalizeDynatrace(payload: unknown, defaults: Record<string, unknown>): NormalizedEvent[] {
  if (!isRecord(payload)) throw new ValidationError('Dynatrace payload must be a JSON object (one problem per request)')
  const externalId = optionalString(payload['PID']) ?? optionalString(payload['ProblemID'])
  if (!externalId || !externalId.trim()) throw new ValidationError('PID (or ProblemID) is missing or empty')
  const title = nonEmptyString(payload['ProblemTitle'], 'ProblemTitle')

  const rawState = optionalString(payload['State'])
  if (!rawState) throw new ValidationError('State is missing (OPEN | RESOLVED)')
  const status = DYNATRACE_STATE[rawState.trim().toLowerCase()]
  if (!status) throw new ValidationError(`State must be one of: OPEN, RESOLVED. Got: ${JSON.stringify(rawState)}`)

  const rawSeverity = optionalString(payload['ProblemSeverity'] ?? defaults['severity'])
  if (!rawSeverity) throw new ValidationError('ProblemSeverity is missing (AVAILABILITY | ERROR | PERFORMANCE | RESOURCE_CONTENTION | CUSTOM_ALERT | MONITORING_UNAVAILABLE)')
  const severity = DYNATRACE_SEVERITY[rawSeverity.trim().toLowerCase()]
  if (!severity) throw new ValidationError(`ProblemSeverity must be one of: AVAILABILITY, ERROR, PERFORMANCE, RESOURCE_CONTENTION, CUSTOM_ALERT, MONITORING_UNAVAILABLE. Got: ${JSON.stringify(rawSeverity)}`)

  const entities = payload['ImpactedEntities']
  if (entities != null && !Array.isArray(entities)) throw new ValidationError('ImpactedEntities must be a list of { type, name, entity } (paste the {ImpactedEntities} placeholder without quotes)')
  const first: unknown = Array.isArray(entities) ? entities[0] : undefined
  let resource: string
  let resourceKind: ResourceKind
  let entityId: string | undefined
  if (first !== undefined) {
    if (!isRecord(first)) throw new ValidationError('ImpactedEntities[0] must be an object { type, name, entity }')
    resource = nonEmptyString(first['name'], 'ImpactedEntities[0].name')
    resourceKind = 'hostname'
    entityId = optionalString(first['entity'])
  } else {
    const impacted = optionalString(payload['ImpactedEntity'])
    if (!impacted || !impacted.trim()) throw new ValidationError('ImpactedEntities is empty and ImpactedEntity is missing or empty')
    resource = impacted.trim()
    resourceKind = 'name'
  }

  const labels: Record<string, string> = {}
  for (const k of ['ProblemImpact', 'ProblemURL', 'ProblemID', 'Tags'] as const) {
    const v = optionalString(payload[k]); if (v && v.trim()) labels[k] = v
  }
  if (entityId && entityId.trim()) labels['dynatrace_entity'] = entityId.trim()

  const ev: NormalizedEvent = { externalId: externalId.trim(), status, severity, title, resource, resourceKind, labels }
  const description = optionalString(payload['ProblemDetailsText'])
  if (description && description.trim()) ev.description = description
  return [ev]
}

// ── generic: mappatore senza codice ──────────────────────────────────────────

/** Campi normalizzati che il connettore generic sa leggere dal payload (chiavi di field_mapping). */
export const GENERIC_FIELDS = ['title', 'severity', 'status', 'resource', 'resourceKind', 'externalId', 'description', 'labels', 'startsAt', 'endsAt'] as const
export type GenericField = (typeof GENERIC_FIELDS)[number]

/** Campi a cui si applica value_mapping, con il vocabolario di destinazione. */
export const VALUE_MAPPED_FIELDS: Readonly<Record<'severity' | 'status', readonly string[]>> = {
  severity: EVENT_SEVERITIES,
  status:   EVENT_STATUSES_INPUT,
}

export type ValueMapping = Partial<Record<'severity' | 'status', Record<string, string>>>

/**
 * field_mapping del connettore generic: `{ campoNormalizzato: "percorso.puntato" }`.
 * Chiave sconosciuta o percorso non stringa → ValidationError (configurazione
 * rotta, deve emergere subito).
 */
export function parseFieldMapping(raw: unknown): Partial<Record<GenericField, string>> {
  if (raw == null) return {}
  if (!isRecord(raw)) throw new ValidationError('field_mapping must be a JSON object { normalizedField: "dotted.path" }')
  const out: Partial<Record<GenericField, string>> = {}
  for (const [field, path] of Object.entries(raw)) {
    if (!(GENERIC_FIELDS as readonly string[]).includes(field)) {
      throw new ValidationError(`field_mapping.${field} is not a normalized field (allowed: ${GENERIC_FIELDS.join(', ')})`)
    }
    if (typeof path !== 'string' || !path.trim()) throw new ValidationError(`field_mapping.${field} must be a non-empty dotted path`)
    out[field as GenericField] = path.trim()
  }
  return out
}

/**
 * value_mapping: `{ severity: { valoreSorgente: info|warning|critical }, status: { valoreSorgente: firing|resolved } }`.
 * Le chiavi sorgente si confrontano senza distinguere maiuscole; i valori di
 * destinazione devono stare nel vocabolario.
 */
export function parseValueMapping(raw: unknown): ValueMapping {
  if (raw == null) return {}
  if (!isRecord(raw)) throw new ValidationError('value_mapping must be a JSON object { severity: {...}, status: {...} }')
  const out: ValueMapping = {}
  for (const [field, map] of Object.entries(raw)) {
    const vocab = (VALUE_MAPPED_FIELDS as Record<string, readonly string[] | undefined>)[field]
    if (!vocab) throw new ValidationError(`value_mapping.${field} is not supported (allowed: ${Object.keys(VALUE_MAPPED_FIELDS).join(', ')})`)
    if (!isRecord(map)) throw new ValidationError(`value_mapping.${field} must be an object { sourceValue: targetValue }`)
    const table: Record<string, string> = {}
    for (const [source, target] of Object.entries(map)) {
      if (typeof target !== 'string' || !vocab.includes(target)) {
        throw new ValidationError(`value_mapping.${field}.${source} must be one of: ${vocab.join(', ')}. Got: ${JSON.stringify(target)}`)
      }
      table[source.trim().toLowerCase()] = target
    }
    out[field as keyof ValueMapping] = table
  }
  return out
}

/** Applica value_mapping a un valore grezzo; non mappato e fuori vocabolario → ValidationError con il valore ricevuto. */
function mapValue(field: 'severity' | 'status', raw: unknown, mapping: ValueMapping): string {
  const s = typeof raw === 'string' ? raw : String(raw)
  const table = mapping[field]
  const mapped = table?.[s.trim().toLowerCase()]
  if (mapped) return mapped
  const vocab = VALUE_MAPPED_FIELDS[field]
  if (vocab.includes(s)) return s
  if (vocab.includes(s.trim().toLowerCase())) return s.trim().toLowerCase()
  throw new ValidationError(`${field} value ${JSON.stringify(s)} is not mapped (value_mapping.${field}) and is not one of: ${vocab.join(', ')}`)
}

/**
 * Connettore generic: ogni campo normalizzato si legge al percorso puntato di
 * field_mapping (campo non mappato → chiave omonima alla radice del payload),
 * poi default_values riempie i campi ancora assenti, poi value_mapping
 * traduce severity/status. `resourceKind` viene dal payload (se mappato) o da
 * default_values.resourceKind: l'interfaccia lo scrive sempre (hostname
 * predefinito), il codice non lo inventa.
 */
function normalizeGeneric(payload: unknown, fieldMapping: Record<string, string>, defaults: Record<string, unknown>, valueMapping: ValueMapping): NormalizedEvent[] {
  if (!isRecord(payload)) throw new ValidationError('Event payload must be a JSON object')
  const mapping = parseFieldMapping(fieldMapping)
  const read = (field: GenericField): unknown => {
    const path = mapping[field] ?? field
    const v = getPath(payload, path, `field_mapping.${field}`)
    if (v !== undefined && v !== null && v !== '') return v
    const d = defaults[field]
    return d === undefined || d === null || d === '' ? undefined : d
  }
  const where = (field: GenericField) => `${field} (field_mapping.${field} = ${JSON.stringify(mapping[field] ?? field)}${defaults[field] === undefined ? ', no default_values.' + field : ''})`

  const title    = nonEmptyString(read('title'), where('title'))
  const resource = nonEmptyString(read('resource'), where('resource'))
  const rawSeverity = read('severity')
  if (rawSeverity === undefined) throw new ValidationError(`${where('severity')} is missing`)
  const severity = mapValue('severity', rawSeverity, valueMapping) as EventSeverity
  const rawStatus = read('status')
  const status = (rawStatus === undefined ? 'firing' : mapValue('status', rawStatus, valueMapping)) as EventInputStatus
  const rawKind = read('resourceKind')
  if (rawKind === undefined) throw new ValidationError('resourceKind is missing: set default_values.resourceKind (hostname | ip | fqdn | external_id | name) or map it in field_mapping')
  const resourceKind = oneOf(rawKind, RESOURCE_KINDS, 'resourceKind')

  const ev: NormalizedEvent = {
    status, severity, title, resourceKind,
    resource: resourceKind === 'hostname' ? stripPort(resource) : resource,
    labels:   stringLabels(read('labels'), 'labels'),
  }
  const externalId  = optionalString(read('externalId'));  if (externalId)  ev.externalId  = externalId
  const description = optionalString(read('description')); if (description) ev.description = description
  const startsAt    = optionalString(read('startsAt'));    if (startsAt)    ev.startsAt    = startsAt
  const endsAt      = optionalString(read('endsAt'));      if (endsAt)      ev.endsAt      = endsAt
  return [ev]
}

/**
 * Payload grezzo del webhook → eventi normalizzati.
 * `alertmanager`/`grafana`: uno per elemento di `alerts`. `zabbix`/`datadog`/
 * `dynatrace`: un oggetto per chiamata. `generic`: un solo evento, con field_mapping /
 * default_values / value_mapping del webhook. Ogni difetto → ValidationError
 * con il percorso del campo.
 */
export function normalizePayload(
  connectorKind: ConnectorKind,
  payload: unknown,
  fieldMapping: Record<string, string>,
  defaults: Record<string, unknown>,
  valueMapping: ValueMapping = {},
): NormalizedEvent[] {
  switch (connectorKind) {
    case 'alertmanager': return normalizeAlertsArray('alertmanager', payload, defaults)
    case 'grafana':      return normalizeAlertsArray('grafana', payload, defaults)
    case 'zabbix':       return normalizeZabbix(payload, defaults)
    case 'datadog':      return normalizeDatadog(payload, defaults)
    case 'dynatrace':    return normalizeDynatrace(payload, defaults)
    case 'generic':      return normalizeGeneric(payload, fieldMapping, defaults, valueMapping)
    default: {
      const never: never = connectorKind
      throw new ValidationError(`Unknown connector_kind ${JSON.stringify(never)}`)
    }
  }
}

/**
 * Configurazione di normalizzazione salvata sul webhook (JSON serializzati):
 * decodifica con errori espliciti. Usata dal webhook in ingresso, da
 * previewInboundEvents e da sendSampleEvent, così la pipeline è una sola.
 */
export interface SourceConfig {
  connectorKind: ConnectorKind
  fieldMapping:  Record<string, string>
  defaults:      Record<string, unknown>
  valueMapping:  ValueMapping
}

export function parseConfigJSON<T>(raw: unknown, what: string): T {
  if (raw == null || raw === '') return {} as T
  if (typeof raw !== 'string') throw new ValidationError(`${what} must be a JSON string`)
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (e) { throw new ValidationError(`Corrupt ${what} JSON: ${e instanceof Error ? e.message : String(e)}`) }
  if (!isRecord(parsed)) throw new ValidationError(`${what} must be a JSON object`)
  return parsed as T
}

/** Da un nodo InboundWebhook (o dall'input di anteprima) alla configurazione tipizzata. */
export function sourceConfigOf(props: { connector_kind?: unknown; field_mapping?: unknown; default_values?: unknown; value_mapping?: unknown }): SourceConfig {
  // `connector_kind` assente = webhook creato prima dell'Event Management → generic.
  // Presente ma sconosciuto = configurazione rotta → ValidationError.
  const connectorKind = props.connector_kind == null ? 'generic' : assertConnectorKind(props.connector_kind)
  const fieldMapping  = parseConfigJSON<Record<string, string>>(props.field_mapping, 'field_mapping')
  const defaults      = parseConfigJSON<Record<string, unknown>>(props.default_values, 'default_values')
  const valueMapping  = parseValueMapping(parseConfigJSON<Record<string, unknown>>(props.value_mapping, 'value_mapping'))
  if (connectorKind === 'generic') parseFieldMapping(fieldMapping)
  return { connectorKind, fieldMapping, defaults, valueMapping }
}

export function normalizeWithConfig(config: SourceConfig, payload: unknown): NormalizedEvent[] {
  return normalizePayload(config.connectorKind, payload, config.fieldMapping, config.defaults, config.valueMapping)
}

// ── Impronta ─────────────────────────────────────────────────────────────────

/**
 * sha256 stabile dell'identità dell'allarme. Con `externalId` (es. fingerprint
 * di Alertmanager) basta quello; altrimenti titolo + risorsa + etichette
 * ordinate per chiave. La descrizione non entra mai: cambia a ogni ripetizione.
 */
export function fingerprintOf(sourceId: string, ev: Pick<NormalizedEvent, 'externalId' | 'title' | 'resource' | 'labels'>): string {
  const h = createHash('sha256')
  if (ev.externalId) {
    h.update(`${sourceId}:${ev.externalId}`)
  } else {
    const labels = Object.keys(ev.labels).sort().map((k) => `${k}=${ev.labels[k]}`).join(',')
    h.update(`${sourceId}:${ev.title}:${ev.resource}:${labels}`)
  }
  return h.digest('hex')
}

// ── Stato dell'evento (puro) ─────────────────────────────────────────────────

/** Quanti istanti di passaggio firing↔resolved si conservano su `Event.transitions`. */
export const MAX_TRANSITIONS = 50

/**
 * Stato dell'ULTIMO payload ricevuto (firing|resolved): `last_payload_status`
 * se presente; per gli eventi scritti prima dell'ondata 4 si deduce dallo
 * status (resolved → resolved; firing/suppressed/flapping → firing).
 */
export function payloadStatusOf(existing: Props): EventInputStatus {
  const lp = existing['last_payload_status']
  if (lp === 'firing' || lp === 'resolved') return lp
  return existing['status'] === 'resolved' ? 'resolved' : 'firing'
}

/** `Event.transitions` come lista di stringhe ISO (assente → vuota: la migrazione 1040 la scrive, ma un evento appena creato la ha già). */
export function transitionsOf(existing: Props): string[] {
  const t = existing['transitions']
  return Array.isArray(t) ? t.filter((x): x is string => typeof x === 'string') : []
}

/** Passaggi registrati a partire da `sinceMs` (incluso). */
export function countTransitionsSince(transitions: readonly string[], sinceMs: number): number {
  let n = 0
  for (const t of transitions) if (Date.parse(t) >= sinceMs) n++
  return n
}

export interface EventPatch {
  status: 'firing' | 'resolved' | string
  severity: EventSeverity
  count: number
  first_seen_at: string
  last_seen_at: string
  resolved_at: string | null
  /** Istanti ISO dei passaggi firing↔resolved (gli ultimi MAX_TRANSITIONS), aggiornati con questo payload. */
  transitions: string[]
  last_payload_status: EventInputStatus
}

/**
 * Stato successivo di un Event esistente all'arrivo di un nuovo payload.
 * - firing su evento risolto → nuovo ciclo: count 1, first_seen = ora, severità del payload
 * - firing su evento aperto  → count+1, severità = la più alta, status invariato
 *   (suppressed resta tale: è la pipeline a toglierlo)
 * - resolved                 → status resolved, resolved_at = ora, count invariato
 * - evento `flapping`        → lo stato NON cambia (lo stabilizza il job periodico);
 *   si aggiornano lista dei passaggi, last_payload_status, last_seen_at, count
 *   (firing) e resolved_at (ora su resolved, null su firing)
 * Un passaggio è un payload con status diverso dall'ultimo ricevuto: viene
 * appeso a `transitions` (lista troncata agli ultimi MAX_TRANSITIONS).
 */
export function nextEventState(existing: Props, ev: NormalizedEvent, now: string): EventPatch {
  const prevStatus   = String(existing['status'])
  const prevSeverity = String(existing['severity']) as EventSeverity
  const prevCount    = Number(existing['count'] ?? 0)
  const firstSeen    = String(existing['first_seen_at'] ?? now)
  const previous     = transitionsOf(existing)
  const transitions  = ev.status !== payloadStatusOf(existing) ? [...previous, now].slice(-MAX_TRANSITIONS) : previous
  const base = { first_seen_at: firstSeen, last_seen_at: now, transitions, last_payload_status: ev.status }
  const higher = (SEVERITY_RANK[ev.severity] ?? -1) > (SEVERITY_RANK[prevSeverity] ?? -1) ? ev.severity : prevSeverity

  if (prevStatus === 'flapping') {
    if (ev.status === 'resolved') return { ...base, status: 'flapping', severity: prevSeverity, count: prevCount, resolved_at: now }
    return { ...base, status: 'flapping', severity: higher, count: prevCount + 1, resolved_at: null }
  }
  if (ev.status === 'resolved') {
    return { ...base, status: 'resolved', severity: prevSeverity, count: prevCount, resolved_at: now }
  }
  if (prevStatus === 'resolved') {
    return { ...base, status: 'firing', severity: ev.severity, count: 1, first_seen_at: now, resolved_at: null }
  }
  return { ...base, status: prevStatus, severity: higher, count: prevCount + 1, resolved_at: (existing['resolved_at'] as string | null) ?? null }
}

/**
 * Salute del CI dalle severità degli eventi `firing` che lo riguardano; un
 * evento `flapping` (qualunque severità) vale `degraded`: è instabilità, non
 * un guasto pieno.
 */
export function deriveCIHealth(firingSeverities: readonly string[], flapping = false): CIHealth {
  if (firingSeverities.includes('critical')) return 'down'
  if (firingSeverities.includes('warning') || flapping) return 'degraded'
  return 'operational'
}

// ── Policy ───────────────────────────────────────────────────────────────────

export async function getEventPolicy(tenantId: string): Promise<EventPolicy> {
  const session = getSession()
  try {
    const row = await runQueryOne<{ raw: unknown }>(session, `
      MATCH (t:Tenant {id: $tenantId})
      RETURN t.event_policy AS raw
    `, { tenantId })
    if (!row) throw new NotFoundError('Tenant', tenantId)
    return parseEventPolicy(row.raw, tenantId)
  } finally {
    await session.close()
  }
}

export async function setEventPolicy(tenantId: string, policy: EventPolicy): Promise<void> {
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (t:Tenant {id: $tenantId})
      SET t.event_policy = $policy, t.updated_at = $now
      RETURN t.id AS id
    `, { tenantId, policy: JSON.stringify(policy), now: new Date().toISOString() })
    if (!row) throw new NotFoundError('Tenant', tenantId)
  } finally {
    await session.close()
  }
}

// ── Riconoscimento del CI ────────────────────────────────────────────────────

/**
 * CI riconosciuto per l'evento, nell'ordine: alias (external_id) → alias
 * (kind = resourceKind, valore minuscolo) → CI con lo stesso nome. Null = orfano.
 */
export async function matchCI(tenantId: string, ev: Pick<NormalizedEvent, 'externalId' | 'resource' | 'resourceKind'>): Promise<string | null> {
  const session = getSession()
  try {
    if (ev.externalId) {
      const byExt = await runQueryOne<{ ciId: string }>(session, `
        MATCH (a:CIAlias {tenant_id: $tenantId, kind: 'external_id', value: $value})-[:ALIAS_OF]->(ci:ConfigurationItem {tenant_id: $tenantId})
        RETURN ci.id AS ciId LIMIT 1
      `, { tenantId, value: ev.externalId })
      if (byExt) return byExt.ciId
    }
    if (ev.resourceKind !== 'name') {
      const byKind = await runQueryOne<{ ciId: string }>(session, `
        MATCH (a:CIAlias {tenant_id: $tenantId, kind: $kind, value: $value})-[:ALIAS_OF]->(ci:ConfigurationItem {tenant_id: $tenantId})
        RETURN ci.id AS ciId LIMIT 1
      `, { tenantId, kind: ev.resourceKind, value: ev.resourceKind === 'external_id' ? ev.resource : ev.resource.toLowerCase() })
      if (byKind) return byKind.ciId
    }
    const byName = await runQueryOne<{ ciId: string }>(session, `
      MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
      WHERE toLower(ci.name) = toLower($resource)
      RETURN ci.id AS ciId ORDER BY ci.created_at LIMIT 1
    `, { tenantId, resource: ev.resource })
    return byName?.ciId ?? null
  } finally {
    await session.close()
  }
}

// ── Salute del CI ────────────────────────────────────────────────────────────

/**
 * Ricalcola `health` del CI dagli eventi firing. Non tocca un CI con
 * `health_source = 'manual'` né uno con `status = 'maintenance'` (ciclo di
 * vita). Scrive `health_source = 'monitoring'` e `last_event_at`; se la
 * salute cambia scrive `health_since = now` e pubblica `ci.health_changed`.
 * Non scrive mai `ci.status`.
 * Restituisce la salute finale (null = CI inesistente).
 */
export async function recomputeCIHealth(tenantId: string, ciId: string, actorId: string): Promise<string | null> {
  const now = new Date().toISOString()
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ status: string | null; health: string | null; healthSource: string | null; severities: string[]; flapping: unknown }>(session, `
      MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
      OPTIONAL MATCH (e:Event {tenant_id: $tenantId, status: 'firing'})-[:RAISED_ON]->(ci)
      WITH ci, collect(DISTINCT e.severity) AS severities
      OPTIONAL MATCH (f:Event {tenant_id: $tenantId, status: 'flapping'})-[:RAISED_ON]->(ci)
      RETURN ci.status AS status, ci.health AS health, ci.health_source AS healthSource, severities, count(f) AS flapping
    `, { tenantId, ciId })
    if (!row) return null
    if (row.healthSource === 'manual' || row.status === 'maintenance') return row.health

    const next = deriveCIHealth(row.severities ?? [], Number(row.flapping ?? 0) > 0)
    const changed = row.health !== next
    // health_since: da quando la salute attuale è in vigore. Si sposta SOLO
    // quando la salute cambia; a salute invariata non va toccata.
    await runQuery(session, `
      MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
      SET ci.health = $health, ci.health_source = 'monitoring', ci.last_event_at = $now, ci.updated_at = $now,
          ci.health_since = CASE WHEN $changed THEN $now ELSE ci.health_since END
    `, { tenantId, ciId, health: next, now, changed })

    if (changed) {
      const payload: CIHealthChangedPayload = {
        id: ciId, ci_id: ciId,
        previous_health: (row.health as CIHealth | null) ?? null,
        new_health: next,
      }
      await publishEvent('ci.health_changed', tenantId, actorId, payload, now)
    }
    return next
  } finally {
    await session.close()
  }
}

// ── Ingest ───────────────────────────────────────────────────────────────────

export interface IngestInput {
  tenantId: string
  sourceId: string
  ev: NormalizedEvent
  /** ISO; default ora. Usato come last_seen_at (e first_seen_at se nuovo). */
  receivedAt?: string
  /** actor_id degli eventi di dominio; default 'monitoring'. */
  actorId?: string
}

/** Esiti della pipeline per cui l'ingest NON pubblica event.received/resolved/orphan (l'avviso lo ha già dato la pipeline). */
export const QUIET_OUTCOMES: ReadonlySet<string> = new Set(['suppressed', 'flapping', 'storm', 'storm_no_ci'])

export function mapEventPayload(props: Props, ciId: string | null): MonitoringEventPayload {
  const id = String(props['id'])
  return {
    id,
    fingerprint: String(props['fingerprint']),
    title:       String(props['title']),
    severity:    String(props['severity']) as MonitoringEventPayload['severity'],
    status:      String(props['status'])   as MonitoringEventPayload['status'],
    resource:    String(props['resource']),
    count:       Number(props['count'] ?? 0),
    ci_id:       ciId,
    source_id:   String(props['source_id']),
    entity_type: 'event',
    entity_id:   id,
  }
}

/**
 * Deduplica per impronta, aggancia il CI, esegue la pipeline di correlazione
 * (soppressione → salute del CI → incident), pubblica gli eventi di dominio.
 * Restituisce le proprietà dell'Event (stato finale) e il CI agganciato.
 */
export async function ingestEvent(input: IngestInput): Promise<{ props: Props; ciId: string | null; created: boolean }> {
  const { tenantId, sourceId, ev } = input
  const now = input.receivedAt ?? new Date().toISOString()
  const actorId = input.actorId ?? 'monitoring'
  const fingerprint = fingerprintOf(sourceId, ev)
  const labels = JSON.stringify(ev.labels)

  const session = getSession(undefined, 'WRITE')
  let props: Props
  let created: boolean
  let linkedCiId: string | null
  // connector_kind della sorgente (etichetta della metrica events_received_total;
  // assente = webhook precedente all'Event Management → generic, come sourceConfigOf).
  let connectorKind: string
  try {
    const existing = await runQueryOne<{ props: Props; ciId: string | null; connectorKind: string | null }>(session, `
      MATCH (e:Event {tenant_id: $tenantId, fingerprint: $fingerprint})
      OPTIONAL MATCH (e)-[:RAISED_ON]->(ci:ConfigurationItem {tenant_id: $tenantId})
      OPTIONAL MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})
      RETURN properties(e) AS props, ci.id AS ciId, w.connector_kind AS connectorKind
    `, { tenantId, fingerprint, sourceId })

    if (!existing) {
      created = true
      linkedCiId = null
      const row = await runQueryOne<{ props: Props; connectorKind: string | null }>(session, `
        CREATE (e:Event {
          id: $id, tenant_id: $tenantId, fingerprint: $fingerprint, external_id: $externalId,
          status: $status, severity: $severity, title: $title, description: $description,
          resource: $resource, resource_kind: $resourceKind, labels: $labels,
          count: 1, first_seen_at: $now, last_seen_at: $now,
          resolved_at: CASE WHEN $status = 'resolved' THEN $now ELSE null END,
          starts_at: $startsAt, ends_at: $endsAt,
          correlation: 'none', correlation_at: null, correlation_due_at: null, suppressed_by_change_id: null,
          transitions: [], last_payload_status: $status, flapping_since: null,
          source_id: $sourceId, created_at: $now, updated_at: $now
        })
        WITH e
        OPTIONAL MATCH (w:InboundWebhook {id: $sourceId, tenant_id: $tenantId})
        FOREACH (_ IN CASE WHEN w IS NULL THEN [] ELSE [1] END | MERGE (e)-[:FROM_SOURCE]->(w))
        RETURN properties(e) AS props, w.connector_kind AS connectorKind
      `, {
        id: uuidv4(), tenantId, fingerprint, externalId: ev.externalId ?? null,
        status: ev.status, severity: ev.severity, title: ev.title, description: ev.description ?? null,
        resource: ev.resource, resourceKind: ev.resourceKind, labels,
        startsAt: ev.startsAt ?? null, endsAt: ev.endsAt ?? null, sourceId, now,
      })
      if (!row) throw new Error(`Event ${fingerprint} not created for tenant ${tenantId}`)
      props = row.props
      connectorKind = row.connectorKind ?? 'generic'
    } else {
      created = false
      linkedCiId = existing.ciId
      connectorKind = existing.connectorKind ?? 'generic'
      const patch = nextEventState(existing.props, ev, now)
      const row = await runQueryOne<{ props: Props }>(session, `
        MATCH (e:Event {tenant_id: $tenantId, fingerprint: $fingerprint})
        SET e.status = $status, e.severity = $severity, e.count = toInteger($count),
            e.first_seen_at = $firstSeenAt, e.last_seen_at = $lastSeenAt, e.resolved_at = $resolvedAt,
            e.transitions = $transitions, e.last_payload_status = $lastPayloadStatus,
            e.title = $title, e.description = $description, e.labels = $labels,
            e.starts_at = coalesce($startsAt, e.starts_at), e.ends_at = $endsAt,
            e.updated_at = $now
        RETURN properties(e) AS props
      `, {
        tenantId, fingerprint, now,
        status: patch.status, severity: patch.severity, count: patch.count,
        firstSeenAt: patch.first_seen_at, lastSeenAt: patch.last_seen_at, resolvedAt: patch.resolved_at,
        transitions: patch.transitions, lastPayloadStatus: patch.last_payload_status,
        title: ev.title, description: ev.description ?? null, labels,
        startsAt: ev.startsAt ?? null, endsAt: ev.endsAt ?? null,
      })
      if (!row) throw new Error(`Event ${fingerprint} vanished during ingest for tenant ${tenantId}`)
      props = row.props
    }
  } finally {
    await session.close()
  }
  eventsReceivedTotal.inc({ connector: connectorKind })
  if (!created) eventsDeduplicatedTotal.inc({})

  // CI: quello già agganciato (anche a mano) vince; altrimenti riconoscimento.
  let ciId = linkedCiId
  if (!ciId) {
    ciId = await matchCI(tenantId, ev)
    if (ciId) {
      const s = getSession(undefined, 'WRITE')
      try {
        await runQuery(s, `
          MATCH (e:Event {id: $eventId, tenant_id: $tenantId})
          MATCH (ci:ConfigurationItem {id: $ciId, tenant_id: $tenantId})
          MERGE (e)-[:RAISED_ON]->(ci)
        `, { eventId: props['id'], tenantId, ciId })
      } finally { await s.close() }
    }
  }
  if (!ciId) eventsOrphanTotal.inc({})
  // Ondata 3 (services/eventCorrelation.ts): soppressione in finestra di change
  // → salute del CI → correlazione in incident / chiusura automatica. La
  // soppressione blocca anche la salute, per questo il ricalcolo vive lì.
  // Ondata 4: `created` alimenta il contatore di tempesta della sorgente.
  const pipeline = await runEventPipeline({ tenantId, eventId: String(props['id']), actorId, now, mode: 'ingest', created })
  props['status'] = pipeline.status

  // Nessun avviso "ricevuto"/"rientrato" quando l'avviso lo dà già la pipeline:
  // silenziato (event.suppressed), sfarfallio (event.flapping, una volta per
  // episodio) o tempesta (event.storm_started: un solo avviso per sorgente,
  // non uno per ciascuno delle centinaia di allarmi al minuto).
  const payload = mapEventPayload(props, ciId)
  if (!QUIET_OUTCOMES.has(pipeline.outcome)) {
    await publishEvent(props['status'] === 'resolved' ? 'event.resolved' : 'event.received', tenantId, actorId, payload, now)
    if (!ciId) await publishEvent('event.orphan', tenantId, actorId, payload, now)
  }

  log.info({ tenantId, sourceId, eventId: props['id'], fingerprint, created, ciId, status: props['status'], count: props['count'], correlation: pipeline.outcome }, 'Event ingested')
  return { props, ciId, created }
}
