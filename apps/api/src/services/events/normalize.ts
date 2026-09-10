/**
 * Event Management — normalizzazione dei payload dei connettori (puro).
 *
 * Webhook in ingresso → `sourceConfigOf` (config del webhook) →
 * `normalizePayload` (per connettore: generic, alertmanager, grafana, zabbix,
 * datadog, dynatrace) → `NormalizedEvent[]`; `fingerprintOf` è l'identità
 * stabile dell'allarme. Nessuna funzione qui tocca il grafo: sono le stesse
 * usate dal webhook, da `previewInboundEvents` e da `sendSampleEvent`, così
 * la pipeline è una sola.
 *
 * Niente fallback silenziosi: payload malformato → ValidationError (→ 400 dal
 * webhook) con il percorso del campo.
 */
import { createHash } from 'node:crypto'
import { ValidationError } from '../../lib/errors.js'
import { CONNECTOR_KINDS, EVENT_SEVERITIES, RESOURCE_KINDS, EVENT_INPUT_STATUSES as EVENT_STATUSES_INPUT, type ConnectorKind, type EventInputStatus, type EventSeverity, type ResourceKind } from '../../lib/eventVocabularies.js'

// ── Tipi ─────────────────────────────────────────────────────────────────────

/**
 * Vocabolari chiusi: la definizione vive in lib/eventVocabularies.ts (fonte
 * unica anche per gli enum dello schema GraphQL); qui vengono ri-esportati per
 * i chiamanti storici di questo modulo. Connettori preset (ondata 2: tutto
 * configurabile da interfaccia, senza codice): `generic` è il mappatore visuale
 * (field_mapping con percorsi puntati + value_mapping); gli altri conoscono
 * già la forma del webhook dello strumento.
 */
export { CONNECTOR_KINDS, EVENT_SEVERITIES, RESOURCE_KINDS, CI_ALIAS_KINDS, EVENT_INPUT_STATUSES as EVENT_STATUSES_INPUT } from '../../lib/eventVocabularies.js'
export type { ConnectorKind, EventInputStatus, EventSeverity, ResourceKind, CIAliasKind } from '../../lib/eventVocabularies.js'

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


// ── Helper puri ──────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Valore del payload citato in un messaggio d'errore, troncato a
 * PAYLOAD_SAMPLE_CHARS (B2 della revisione): il messaggio finisce in
 * `InboundWebhook.last_error` (fino a 2000 caratteri) e nei log, e con un
 * mapping sbagliato (es. `severity` puntato a un campo di testo libero) un
 * valore intero del mittente finirebbe nel grafo. Serializzato come JSON, così
 * una stringa resta riconoscibile dalle virgolette.
 */
export function quoteValue(value: unknown): string {
  const raw = value === undefined ? 'undefined' : JSON.stringify(value) ?? String(value)
  return raw.length > PAYLOAD_SAMPLE_CHARS ? `${raw.slice(0, PAYLOAD_SAMPLE_CHARS)}…` : raw
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${what} must be one of: ${allowed.join(', ')}. Got: ${quoteValue(value)}`)
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
 * Profondità massima di un payload (livelli di oggetti/array annidati) per
 * `getPath` e `listPayloadKeys`. `JSON.parse` di V8 è iterativo, la visita no:
 * senza tetto un payload di `[[[[…` da 100 kB (≈50.000 livelli) faceva
 * esplodere lo stack con un errore interno (500) invece di una ValidationError
 * (I-4 della revisione). Nessun payload di monitoraggio reale supera la decina.
 */
export const PAYLOAD_MAX_DEPTH = 32

/**
 * Valore a un percorso puntato (`alert.name`, `alerts.0.labels.instance`):
 * ogni segmento è una chiave d'oggetto o un indice di array. `undefined` se
 * un segmento non esiste. Puro, senza fallback: un percorso vuoto o più
 * profondo di PAYLOAD_MAX_DEPTH è un errore di configurazione. Le chiavi si
 * leggono solo come proprietà PROPRIE (B1): `constructor.name` o `toString`
 * su un oggetto sono "campo mancante", non il valore ereditato dal prototipo.
 */
export function getPath(payload: unknown, path: string, what = 'path'): unknown {
  const p = path.trim()
  if (!p) throw new ValidationError(`${what} is empty`)
  const segments = p.split('.')
  if (segments.length > PAYLOAD_MAX_DEPTH) {
    throw new ValidationError(`${what} has ${segments.length} segments: at most ${PAYLOAD_MAX_DEPTH} levels are supported`)
  }
  let cur: unknown = payload
  for (const seg of segments) {
    if (cur == null) return undefined
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined
      cur = cur[Number(seg)]
    } else if (typeof cur === 'object') {
      cur = Object.hasOwn(cur, seg) ? (cur as Record<string, unknown>)[seg] : undefined
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
 * `PAYLOAD_KEYS_MAX` chiavi, in ordine di visita (profondità). Oltre
 * PAYLOAD_MAX_DEPTH livelli → ValidationError, prima di esaurire lo stack.
 */
export function listPayloadKeys(payload: unknown): PayloadKey[] {
  const out: PayloadKey[] = []
  const visit = (value: unknown, prefix: string, depth: number) => {
    if (out.length >= PAYLOAD_KEYS_MAX) return
    if (depth > PAYLOAD_MAX_DEPTH) {
      throw new ValidationError(`payload is nested deeper than ${PAYLOAD_MAX_DEPTH} levels at ${prefix || '<root>'}`)
    }
    if (Array.isArray(value)) {
      if (value.length === 0) { out.push({ path: prefix, sample: '[]' }); return }
      value.forEach((v, i) => visit(v, prefix ? `${prefix}.${i}` : String(i), depth + 1))
      return
    }
    if (isRecord(value)) {
      const keys = Object.keys(value)
      if (keys.length === 0) { out.push({ path: prefix, sample: '{}' }); return }
      for (const k of keys) visit(value[k], prefix ? `${prefix}.${k}` : k, depth + 1)
      return
    }
    if (!prefix) return   // payload scalare alla radice: nessuna chiave
    const raw = value === null ? 'null' : typeof value === 'string' ? value : JSON.stringify(value)
    out.push({ path: prefix, sample: raw.length > PAYLOAD_SAMPLE_CHARS ? `${raw.slice(0, PAYLOAD_SAMPLE_CHARS)}…` : raw })
  }
  visit(payload, '', 0)
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
  if (!severity) throw new ValidationError(`event_severity must be one of: Not classified, Information, Warning, Average, High, Disaster. Got: ${quoteValue(rawSeverity)}`)

  const rawValue = optionalString(payload['event_value'])
  if (rawValue !== '0' && rawValue !== '1') throw new ValidationError(`event_value must be "1" (problem) or "0" (recovery). Got: ${quoteValue(payload['event_value'] ?? null)}`)
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
  if (!status) throw new ValidationError(`alert_transition must be one of: Triggered, Re-Triggered, Warn, No Data, Recovered. Got: ${quoteValue(rawTransition)}`)

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
  if (!status) throw new ValidationError(`State must be one of: OPEN, RESOLVED. Got: ${quoteValue(rawState)}`)

  const rawSeverity = optionalString(payload['ProblemSeverity'] ?? defaults['severity'])
  if (!rawSeverity) throw new ValidationError('ProblemSeverity is missing (AVAILABILITY | ERROR | PERFORMANCE | RESOURCE_CONTENTION | CUSTOM_ALERT | MONITORING_UNAVAILABLE)')
  const severity = DYNATRACE_SEVERITY[rawSeverity.trim().toLowerCase()]
  if (!severity) throw new ValidationError(`ProblemSeverity must be one of: AVAILABILITY, ERROR, PERFORMANCE, RESOURCE_CONTENTION, CUSTOM_ALERT, MONITORING_UNAVAILABLE. Got: ${quoteValue(rawSeverity)}`)

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
        throw new ValidationError(`value_mapping.${field}.${source} must be one of: ${vocab.join(', ')}. Got: ${quoteValue(target)}`)
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
  throw new ValidationError(`${field} value ${quoteValue(s)} is not mapped (value_mapping.${field}) and is not one of: ${vocab.join(', ')}`)
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
