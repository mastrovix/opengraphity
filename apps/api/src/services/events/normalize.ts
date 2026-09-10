/**
 * Event Management — normalizzazione dei payload dei connettori (puro).
 *
 * Webhook in ingresso → `sourceConfigOf` (config del webhook) →
 * `normalizeBatch` (per connettore: generic, alertmanager, grafana, zabbix,
 * datadog, dynatrace) → `NormalizedEvent[]` + elementi scartati;
 * `fingerprintOf` è l'identità stabile dell'allarme. Nessuna funzione qui
 * tocca il grafo: sono le stesse usate dal webhook, da `previewInboundEvents`
 * e da `sendSampleEvent`, così la pipeline è una sola.
 *
 * Niente fallback silenziosi: payload malformato → ValidationError (→ 400 dal
 * webhook) con il percorso del campo. Ondata 4 (A1): la normalizzazione è PER
 * ELEMENTO — in un batch Alertmanager/Grafana un allarme difettoso viene
 * scartato (contato e visibile: `rejected[]`, `last_error`, metrica) senza
 * trascinare con sé gli altri; un difetto della busta (non è un oggetto,
 * manca `alerts`, troppi allarmi) resta un errore dell'intera richiesta.
 * `value_mapping` (severity, status) e `default_values` (severity, resource +
 * resourceKind, resourceFrom) valgono per TUTTI i connettori: un valore fuori
 * vocabolario o una risorsa assente sono scarti espliciti finché
 * l'amministratore non configura la traduzione o la risorsa predefinita.
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
  /** Identificativo dell'ALLARME presso la sorgente (fingerprint Alertmanager, event_id Zabbix, ciclo Datadog, PID Dynatrace): entra nell'impronta. */
  externalId?: string
  /**
   * Identificativo della RISORSA (il CI) presso la sorgente (M2): `entity` di
   * Dynatrace (HOST-…), `host_id` di Zabbix, `field_mapping.resourceExternalId`
   * del generic. È quello da confrontare con un alias `external_id` del CI —
   * mai `externalId`, che identifica l'allarme.
   */
  resourceExternalId?: string
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

/** Opzioni di normalizzazione che dipendono dal tenant, non dal payload. */
export interface NormalizeOptions {
  /**
   * Fuso IANA del tenant (`Tenant.timezone`): serve a Zabbix, che manda
   * `{EVENT.DATE} {EVENT.TIME}` nell'ora locale del server senza offset. Assente
   * o non valido → `startsAt` resta vuoto e il grezzo va in `labels.event_time`.
   */
  timezone?: string | null
}

/** Un elemento del payload scartato: indice nel batch (0 per i connettori a un evento) e motivo. */
export interface RejectedPayloadItem { index: number; error: string }

export interface NormalizedBatch {
  events:   NormalizedEvent[]
  rejected: RejectedPayloadItem[]
  /** Elementi presenti nel payload (accettati + scartati). */
  total:    number
}

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

/**
 * Etichette in una delle tre forme che gli strumenti usano (B6): oggetto
 * `{ k: v }`, lista di `chiave:valore` (stile Datadog `$TAGS`, un elemento senza
 * `:` vale `true`), stringa separata da virgole. Vale per Datadog e per il
 * connettore generic.
 */
export function parseLabels(raw: unknown, what: string): Record<string, string> {
  if (raw == null || raw === '') return {}
  if (isRecord(raw)) return stringLabels(raw, what)
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null
  if (!items) throw new ValidationError(`${what} must be a list of "key:value" strings, a comma-separated string or an object`)
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
 * Toglie la porta da un `instance` di Prometheus (M5): `host:9100` → `host`,
 * `10.0.0.7:9100` → `10.0.0.7`, `[::1]:9100` → `::1` (le parentesi dell'IPv6
 * cadono con la porta: l'alias `ip` del CI è `::1`). Un IPv6 nudo (`2001:db8::1`)
 * o qualunque altra forma restano intatti: la regex precedente (`^(.*):\d+$`)
 * lo mutilava in `2001:db8:`.
 */
export function stripPort(instance: string): string {
  const bracketed = /^\[(.+)\](?::\d+)?$/.exec(instance)
  if (bracketed) return bracketed[1]!
  const single = /^([^:]+):\d+$/.exec(instance)
  return single ? single[1]! : instance
}

export function assertConnectorKind(value: unknown, what = 'connector_kind'): ConnectorKind {
  return oneOf(value, CONNECTOR_KINDS, what)
}

// ── Ora locale → ISO (Zabbix) ────────────────────────────────────────────────

/** Offset (ms) del fuso `timeZone` all'istante UTC `utcMs`: ora locale − UTC. Fuso non valido → RangeError da Intl. */
function timeZoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const localAsUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second'))
  return localAsUtc - Math.floor(utcMs / 1000) * 1000
}

/**
 * `"2026.09.09 10:12:37"` (ora di parete nel fuso `timeZone`, formato di
 * `{EVENT.DATE} {EVENT.TIME}` di Zabbix; accettati anche `-` e `/` come
 * separatori della data) → istante ISO UTC. `null` se il testo non ha quella
 * forma, la data non esiste, il fuso è assente o non è una zona IANA: il
 * chiamante conserva il grezzo, MAI un istante inventato (M4). Un'ora
 * inesistente per il passaggio all'ora legale viene proiettata sull'istante
 * più vicino secondo l'offset successivo (come fa il sistema operativo).
 */
export function zonedTimeToISO(text: string, timeZone: string | null | undefined): string | null {
  if (!timeZone) return null
  const m = /^(\d{4})[.\-/](\d{2})[.\-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text.trim())
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number]
  const wall = Date.UTC(y, mo - 1, d, h, mi, s)
  const check = new Date(wall)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null
  try {
    let guess = wall - timeZoneOffsetMs(wall, timeZone)
    const offset = timeZoneOffsetMs(guess, timeZone)
    if (wall - offset !== guess) guess = wall - offset
    return new Date(guess).toISOString()
  } catch {
    return null   // fuso non valido: nessun istante
  }
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

// ── value_mapping e default_values (tutti i connettori) ──────────────────────

/** Campi a cui si applica value_mapping, con il vocabolario di destinazione. */
export const VALUE_MAPPED_FIELDS: Readonly<Record<'severity' | 'status', readonly string[]>> = {
  severity: EVENT_SEVERITIES,
  status:   EVENT_STATUSES_INPUT,
}

export type ValueMapping = Partial<Record<'severity' | 'status', Record<string, string>>>

/**
 * value_mapping: `{ severity: { valoreSorgente: info|warning|critical }, status: { valoreSorgente: firing|resolved } }`.
 * Le chiavi sorgente si confrontano senza distinguere maiuscole; i valori di
 * destinazione devono stare nel vocabolario. Vale per ogni connettore: nei
 * preset traduce la severità/stato dello strumento PRIMA della tabella
 * incorporata (es. Alertmanager `page` → critical, Zabbix `Average` → critical).
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

/**
 * Applica value_mapping a un valore grezzo che deve finire DIRETTAMENTE nel
 * vocabolario (Alertmanager/Grafana/generic): mappato → destinazione; già nel
 * vocabolario → tale quale; altrimenti ValidationError con il valore ricevuto.
 * `what` è il percorso del campo citato nel messaggio.
 */
function mapValue(field: 'severity' | 'status', raw: unknown, mapping: ValueMapping, what: string = field): string {
  const s = typeof raw === 'string' ? raw : String(raw)
  const table = mapping[field]
  const mapped = table?.[s.trim().toLowerCase()]
  if (mapped) return mapped
  const vocab = VALUE_MAPPED_FIELDS[field]
  if (vocab.includes(s)) return s
  if (vocab.includes(s.trim().toLowerCase())) return s.trim().toLowerCase()
  throw new ValidationError(`${what} value ${quoteValue(s)} is not mapped (value_mapping.${field}) and is not one of: ${vocab.join(', ')}`)
}

/**
 * Valore di un connettore preset con tabella incorporata (Zabbix, Datadog,
 * Dynatrace): prima value_mapping (l'amministratore vince), poi la tabella
 * dello strumento; fuori da entrambe → ValidationError che cita i valori
 * previsti e ricorda che value_mapping può aggiungerne.
 */
function mapPresetValue<T extends string>(field: 'severity' | 'status', raw: string, mapping: ValueMapping, table: Readonly<Record<string, T>>, what: string, allowed: string): T {
  const key = raw.trim().toLowerCase()
  const mapped = mapping[field]?.[key]
  if (mapped) return mapped as T
  const builtin = table[key]
  if (builtin !== undefined) return builtin
  throw new ValidationError(`${what} must be one of: ${allowed}. Got: ${quoteValue(raw)} (or map it in value_mapping.${field})`)
}

/** Chiavi ammesse in default_values per i connettori preset (generic accetta ogni campo normalizzato). */
export const PRESET_DEFAULT_KEYS = ['severity', 'resource', 'resourceKind', 'resourceFrom'] as const
/** Sorgenti alternative della risorsa per connettore (`default_values.resourceFrom`): Datadog può usare `$ALERT_SCOPE` quando `$HOSTNAME` è vuoto. */
export const RESOURCE_FROM_OPTIONS: Readonly<Partial<Record<ConnectorKind, readonly string[]>>> = {
  datadog: ['alert_scope'],
}

/**
 * default_values dei connettori preset, validati in scrittura (sourceConfigOf):
 * `severity` (stringa, tradotta come il valore del payload), `resource` +
 * `resourceKind` (risorsa usata quando il payload non ne porta una: entrambi
 * obbligatori insieme, il codice non inventa il tipo), `resourceFrom` (solo
 * dove il connettore lo prevede). Una chiave ignota è una configurazione
 * rotta, non un valore da ignorare.
 */
export function validatePresetDefaults(connectorKind: ConnectorKind, defaults: Record<string, unknown>): void {
  for (const key of Object.keys(defaults)) {
    if (!(PRESET_DEFAULT_KEYS as readonly string[]).includes(key)) {
      throw new ValidationError(`default_values.${key} is not supported by the ${connectorKind} connector (allowed: ${PRESET_DEFAULT_KEYS.join(', ')})`)
    }
  }
  if (defaults['severity'] !== undefined && (typeof defaults['severity'] !== 'string' || !defaults['severity'].trim())) {
    throw new ValidationError('default_values.severity must be a non-empty string')
  }
  const resource = defaults['resource']
  if (resource !== undefined) {
    if (typeof resource !== 'string' || !resource.trim()) throw new ValidationError('default_values.resource must be a non-empty string')
    if (defaults['resourceKind'] === undefined) throw new ValidationError(`default_values.resourceKind is required with default_values.resource (${RESOURCE_KINDS.join(' | ')})`)
  }
  if (defaults['resourceKind'] !== undefined) oneOf(defaults['resourceKind'], RESOURCE_KINDS, 'default_values.resourceKind')
  const from = defaults['resourceFrom']
  if (from !== undefined) {
    const options = RESOURCE_FROM_OPTIONS[connectorKind] ?? []
    if (typeof from !== 'string' || !options.includes(from)) {
      throw new ValidationError(options.length
        ? `default_values.resourceFrom for ${connectorKind} must be one of: ${options.join(', ')}. Got: ${quoteValue(from)}`
        : `default_values.resourceFrom is not supported by the ${connectorKind} connector`)
    }
  }
}

/**
 * Risorsa predefinita della sorgente (`default_values.resource` +
 * `resourceKind`) quando il payload non ne porta una. Senza configurazione →
 * ValidationError che dice cosa manca e come rimediare: mai una risorsa
 * inventata dal codice (A1).
 */
function defaultResourceOf(defaults: Record<string, unknown>, what: string, hint = ''): { resource: string; resourceKind: ResourceKind } {
  const resource = defaults['resource']
  if (typeof resource === 'string' && resource.trim()) {
    return { resource: resource.trim(), resourceKind: oneOf(defaults['resourceKind'], RESOURCE_KINDS, 'default_values.resourceKind') }
  }
  throw new ValidationError(`${what} is missing or empty and default_values.resource is not set${hint} (set default_values.resource + resourceKind on the source to accept alerts without a resource)`)
}

// ── normalizePayload ─────────────────────────────────────────────────────────

/** Errore di un singolo elemento → voce di `rejected`; qualunque altro errore (bug, non payload) propaga. */
function collect(batch: NormalizedBatch, index: number, produce: () => NormalizedEvent): void {
  try {
    batch.events.push(produce())
  } catch (e) {
    if (!(e instanceof ValidationError)) throw e
    batch.rejected.push({ index, error: e.message })
  }
}

/** Connettori a un solo oggetto per chiamata: l'unico elemento ha indice 0. */
function single(produce: () => NormalizedEvent): NormalizedBatch {
  const batch: NormalizedBatch = { events: [], rejected: [], total: 1 }
  collect(batch, 0, produce)
  return batch
}

/**
 * Alertmanager e Grafana condividono la forma `{ alerts: [...] }`. Grafana
 * (unified alerting) non ha sempre `labels.instance`: in sua assenza vale
 * `labels.host`. Senza nessuno dei due → `default_values.resource` (A1) o
 * scarto dell'elemento. La severità è un'etichetta libera in Prometheus
 * (`page`, `P1`…): value_mapping.severity la traduce, altrimenti deve essere
 * già nel vocabolario.
 */
function normalizeAlertsArray(kind: 'alertmanager' | 'grafana', payload: unknown, defaults: Record<string, unknown>, valueMapping: ValueMapping): NormalizedBatch {
  const name = kind === 'grafana' ? 'Grafana' : 'Alertmanager'
  if (!isRecord(payload)) throw new ValidationError(`${name} payload must be a JSON object with an \`alerts\` array`)
  const alerts = payload['alerts']
  if (!Array.isArray(alerts)) throw new ValidationError(`${name} payload has no \`alerts\` array`)
  if (alerts.length > MAX_EVENTS_PER_REQUEST) {
    throw new ValidationError(`Too many alerts in one request: ${alerts.length} (max ${MAX_EVENTS_PER_REQUEST})`)
  }
  const batch: NormalizedBatch = { events: [], rejected: [], total: alerts.length }
  alerts.forEach((alert, i) => collect(batch, i, () => {
    const at = `alerts[${i}]`
    if (!isRecord(alert)) throw new ValidationError(`${at} is not an object`)
    const labels = alert['labels']
    if (!isRecord(labels)) throw new ValidationError(`${at}.labels is missing or not an object`)
    const annotations = isRecord(alert['annotations']) ? alert['annotations'] : {}

    const title = nonEmptyString(labels['alertname'], `${at}.labels.alertname`)
    const rawSeverity = labels['severity'] ?? defaults['severity']
    if (rawSeverity == null || rawSeverity === '') throw new ValidationError(`${at}.labels.severity is missing (no default_values.severity)`)
    const severity = mapValue('severity', rawSeverity, valueMapping, `${at}.labels.severity`) as EventSeverity
    if (alert['status'] == null || alert['status'] === '') throw new ValidationError(`${at}.status is missing`)
    const status = mapValue('status', alert['status'], valueMapping, `${at}.status`) as EventInputStatus

    const instance = optionalString(labels['instance'])?.trim()
    const host = kind === 'grafana' ? optionalString(labels['host'])?.trim() : undefined
    let resource: string
    let resourceKind: ResourceKind
    if (instance) { resource = stripPort(instance); resourceKind = 'hostname' }
    else if (host) { resource = host; resourceKind = 'hostname' }
    else ({ resource, resourceKind } = defaultResourceOf(defaults, `${at}.labels.instance${kind === 'grafana' ? ' (or labels.host)' : ''}`))

    const summary  = optionalString(annotations['summary'])
    const detail   = optionalString(annotations['description'])
    const description = [summary, detail].filter((s): s is string => !!s && s.trim() !== '').join('\n') || undefined

    const ev: NormalizedEvent = {
      status, severity, title,
      resource, resourceKind,
      labels: stringLabels(labels, `${at}.labels`),
    }
    const externalId = optionalString(alert['fingerprint'])
    if (externalId) ev.externalId = externalId
    if (description) ev.description = description
    const startsAt = optionalString(alert['startsAt']); if (startsAt) ev.startsAt = startsAt
    const endsAt   = optionalString(alert['endsAt']);   if (endsAt && !endsAt.startsWith('0001-')) ev.endsAt = endsAt
    return ev
  }))
  return batch
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
const ZABBIX_SEVERITY_LABEL = 'Not classified, Information, Warning, Average, High, Disaster'

/** `{EVENT.VALUE}` di Zabbix: 1 = problema, 0 = ripristino. */
export const ZABBIX_VALUE: Readonly<Record<string, EventInputStatus>> = { '1': 'firing', '0': 'resolved' }

/**
 * Zabbix: un oggetto per chiamata (media type "webhook" con parametri
 * event_id, event_name/trigger_name, event_severity, event_value, host_name,
 * host_ip, host_id, event_date/event_time, trigger_description, event_opdata).
 * `host_id` ({HOST.ID}) è l'id della risorsa (resourceExternalId, M2);
 * `event_date event_time` è ora locale del server Zabbix, convertita con il
 * fuso del tenant (M4): senza conversione possibile resta in `labels.event_time`.
 */
function normalizeZabbix(payload: unknown, defaults: Record<string, unknown>, valueMapping: ValueMapping, opts: NormalizeOptions): NormalizedBatch {
  return single(() => {
    if (!isRecord(payload)) throw new ValidationError('Zabbix payload must be a JSON object (one event per request)')
    const externalId = optionalString(payload['event_id'])
    if (!externalId) throw new ValidationError('event_id is missing or empty')
    const title = nonEmptyString(payload['event_name'] ?? payload['trigger_name'], 'event_name (or trigger_name)')

    const rawSeverity = optionalString(payload['event_severity'] ?? defaults['severity'])
    if (!rawSeverity) throw new ValidationError(`event_severity is missing (${ZABBIX_SEVERITY_LABEL.replaceAll(', ', ' | ')})`)
    const severity = mapPresetValue('severity', rawSeverity, valueMapping, ZABBIX_SEVERITY, 'event_severity', ZABBIX_SEVERITY_LABEL)

    const rawValue = optionalString(payload['event_value'])
    if (rawValue === undefined) throw new ValidationError('event_value is missing ("1" problem | "0" recovery)')
    const status = mapPresetValue('status', rawValue, valueMapping, ZABBIX_VALUE, 'event_value', '"1" (problem), "0" (recovery)')

    const hostName = optionalString(payload['host_name'])?.trim()
    const hostIp   = optionalString(payload['host_ip'])?.trim()
    let resource: string
    let resourceKind: ResourceKind
    if (hostName) { resource = hostName; resourceKind = 'hostname' }
    else if (hostIp) { resource = hostIp; resourceKind = 'ip' }
    else ({ resource, resourceKind } = defaultResourceOf(defaults, 'host_name (or host_ip)'))

    const parts = [optionalString(payload['trigger_description']), optionalString(payload['event_opdata'])]
      .filter((s): s is string => !!s && s.trim() !== '')
    const labels: Record<string, string> = {}
    for (const k of ['host_name', 'host_ip', 'host_id', 'event_severity', 'trigger_id', 'event_tags', 'event_nseverity'] as const) {
      const v = optionalString(payload[k]); if (v) labels[k] = v
    }

    const ev: NormalizedEvent = { externalId, status, severity, title, resource, resourceKind, labels }
    const hostId = optionalString(payload['host_id'])?.trim()
    if (hostId) ev.resourceExternalId = hostId
    if (parts.length) ev.description = parts.join('\n')
    const date = optionalString(payload['event_date'])?.trim()
    const time = optionalString(payload['event_time'])?.trim()
    if (date || time) {
      const raw = [date, time].filter(Boolean).join(' ')
      const iso = date && time ? zonedTimeToISO(raw, opts.timezone) : null
      if (iso) ev.startsAt = iso
      else labels['event_time'] = raw   // non convertibile: il grezzo resta visibile, nessun istante inventato
    }
    return ev
  })
}

/**
 * Transizioni di Datadog (`$ALERT_TRANSITION`) → stato dell'evento. Valori dalla
 * documentazione dell'integrazione Webhooks (docs.datadoghq.com/integrations/webhooks,
 * verificata il 10 set 2026): `Recovered`, `Triggered`/`Re-Triggered`,
 * `No Data`/`Re-No Data`, `Warn`/`Re-Warn`, `Renotify`. In più `Warn Recovered`
 * (rientro da uno stato di warning, presente nei titoli delle notifiche dei
 * monitor anche se non nella tabella delle variabili) e `Re-Notify` (grafia
 * alternativa vista nei payload). Tutto il resto → value_mapping.status.
 */
export const DATADOG_TRANSITION: Readonly<Record<string, EventInputStatus>> = {
  'triggered':      'firing',
  're-triggered':   'firing',
  'warn':           'firing',
  're-warn':        'firing',
  'no data':        'firing',
  're-no data':     'firing',
  'renotify':       'firing',
  're-notify':      'firing',
  'recovered':      'resolved',
  'warn recovered': 'resolved',
}
const DATADOG_TRANSITION_LABEL = 'Triggered, Re-Triggered, Warn, Re-Warn, No Data, Re-No Data, Renotify, Recovered, Warn Recovered'

/** `$ALERT_TYPE` di Datadog → severità (error, warning, success, info: i quattro valori documentati). */
export const DATADOG_ALERT_TYPE: Readonly<Record<string, EventSeverity>> = {
  'error':   'critical',
  'warning': 'warning',
  'info':    'info',
  'success': 'info',
}

/** Etichette di Datadog (`$TAGS`): lista di `chiave:valore`, stringa separata da virgole o oggetto. */
function datadogTags(raw: unknown): Record<string, string> {
  return parseLabels(raw, 'tags')
}

/**
 * Datadog: un oggetto per chiamata (webhook integration con variabili
 * $ALERT_ID, $ALERT_CYCLE_KEY, $ALERT_SCOPE, $ALERT_TRANSITION, $ALERT_TYPE,
 * $EVENT_TITLE, $EVENT_MSG/$TEXT_ONLY_MSG, $HOSTNAME, $TAGS).
 *
 * Identità dell'allarme (A3): `$ALERT_ID` è l'id del MONITOR, uguale per
 * tutti gli host di un monitor "multi alert" — usarlo da solo collassava gli
 * host in un solo Event. L'impronta è `alert_cycle_key` (unico per ciclo
 * trigger→resolve) se presente, altrimenti `alert_id` + risorsa.
 * Risorsa: `hostname`; se vuoto (monitor su log/APM) `alert_scope` come nome
 * SOLO con `default_values.resourceFrom = "alert_scope"`, poi
 * `default_values.resource`; altrimenti scarto esplicito.
 */
function normalizeDatadog(payload: unknown, defaults: Record<string, unknown>, valueMapping: ValueMapping): NormalizedBatch {
  return single(() => {
    if (!isRecord(payload)) throw new ValidationError('Datadog payload must be a JSON object (one alert per request)')
    const alertId = optionalString(payload['alert_id'])?.trim()
    if (!alertId) throw new ValidationError('alert_id is missing or empty')
    const title = nonEmptyString(payload['title'], 'title')

    const rawTransition = optionalString(payload['alert_transition'])
    if (!rawTransition) throw new ValidationError(`alert_transition is missing (${DATADOG_TRANSITION_LABEL.replaceAll(', ', ' | ')})`)
    const status = mapPresetValue('status', rawTransition, valueMapping, DATADOG_TRANSITION, 'alert_transition', DATADOG_TRANSITION_LABEL)

    const rawType = optionalString(payload['alert_type'] ?? defaults['severity'])
    if (!rawType) throw new ValidationError('alert_type is missing (error | warning | info | success)')
    const severity = mapPresetValue('severity', rawType, valueMapping, DATADOG_ALERT_TYPE, 'alert_type', 'error, warning, info, success')

    const hostname = optionalString(payload['hostname'])?.trim()
    const scope = optionalString(payload['alert_scope'])?.trim()
    const cycleKey = optionalString(payload['alert_cycle_key'])?.trim()
    let resource: string
    let resourceKind: ResourceKind
    if (hostname) { resource = stripPort(hostname); resourceKind = 'hostname' }
    else if (defaults['resourceFrom'] === 'alert_scope' && scope) { resource = scope; resourceKind = 'name' }
    else ({ resource, resourceKind } = defaultResourceOf(defaults, 'hostname', scope ? ' and default_values.resourceFrom is not "alert_scope"' : ''))
    const body = optionalString(payload['body']) ?? optionalString(payload['text'])

    const labels = datadogTags(payload['tags'])
    labels['alert_id'] = alertId
    if (scope) labels['alert_scope'] = scope
    if (cycleKey) labels['alert_cycle_key'] = cycleKey
    const ev: NormalizedEvent = {
      externalId: cycleKey ?? `${alertId}@${resource}`,
      status, severity, title,
      resource, resourceKind,
      labels,
    }
    if (body && body.trim()) ev.description = body
    const date = payload['date']
    if (typeof date === 'number' && Number.isFinite(date)) ev.startsAt = new Date(date < 1e12 ? date * 1000 : date).toISOString()
    else { const s = optionalString(date); if (s) ev.startsAt = s }
    return ev
  })
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
const DYNATRACE_SEVERITY_LABEL = 'AVAILABILITY, ERROR, PERFORMANCE, RESOURCE_CONTENTION, CUSTOM_ALERT, MONITORING_UNAVAILABLE'

/**
 * Prefissi di tipo con cui Dynatrace compone `{ImpactedEntity}` ("Host web-02",
 * "Service checkout"): riconosciuto → tolto (M3), `Host` → hostname, gli altri
 * → name. Un prefisso ignoto (o "3 impacted entities") → errore: meglio
 * incollare `{ImpactedEntities}`, che porta tipo, nome e id.
 */
export const DYNATRACE_ENTITY_PREFIXES: ReadonlyArray<readonly [prefix: string, kind: ResourceKind]> = [
  ['Host', 'hostname'],
  ['Service', 'name'],
  ['Application', 'name'],
  ['Process group', 'name'],
  ['Process', 'name'],
  ['Custom device', 'name'],
  ['Database', 'name'],
  ['Synthetic monitor', 'name'],
  ['Kubernetes cluster', 'name'],
  ['Cloud application', 'name'],
]

/**
 * Dynatrace: un problema per chiamata (Problem notifications → Custom
 * integration con payload personalizzato: {State}, {ProblemID}, {PID},
 * {ProblemTitle}, {ProblemSeverity}, {ProblemImpact}, {ImpactedEntity},
 * {ImpactedEntities}, {ProblemDetailsText}, {ProblemURL}, {Tags}).
 * La risorsa è il primo elemento di `ImpactedEntities`: `type` HOST → hostname,
 * altrimenti nome (M3); `entity` (HOST-…, SERVICE-…) è l'id della risorsa
 * (resourceExternalId, M2). Senza elementi si usa `ImpactedEntity` senza il
 * prefisso di tipo.
 */
function normalizeDynatrace(payload: unknown, defaults: Record<string, unknown>, valueMapping: ValueMapping): NormalizedBatch {
  return single(() => {
    if (!isRecord(payload)) throw new ValidationError('Dynatrace payload must be a JSON object (one problem per request)')
    const externalId = optionalString(payload['PID']) ?? optionalString(payload['ProblemID'])
    if (!externalId || !externalId.trim()) throw new ValidationError('PID (or ProblemID) is missing or empty')
    const title = nonEmptyString(payload['ProblemTitle'], 'ProblemTitle')

    const rawState = optionalString(payload['State'])
    if (!rawState) throw new ValidationError('State is missing (OPEN | RESOLVED)')
    const status = mapPresetValue('status', rawState, valueMapping, DYNATRACE_STATE, 'State', 'OPEN, RESOLVED')

    const rawSeverity = optionalString(payload['ProblemSeverity'] ?? defaults['severity'])
    if (!rawSeverity) throw new ValidationError(`ProblemSeverity is missing (${DYNATRACE_SEVERITY_LABEL.replaceAll(', ', ' | ')})`)
    const severity = mapPresetValue('severity', rawSeverity, valueMapping, DYNATRACE_SEVERITY, 'ProblemSeverity', DYNATRACE_SEVERITY_LABEL)

    const entities = payload['ImpactedEntities']
    if (entities != null && !Array.isArray(entities)) throw new ValidationError('ImpactedEntities must be a list of { type, name, entity } (paste the {ImpactedEntities} placeholder without quotes)')
    const first: unknown = Array.isArray(entities) ? entities[0] : undefined
    let resource: string
    let resourceKind: ResourceKind
    let entityId: string | undefined
    if (first !== undefined) {
      if (!isRecord(first)) throw new ValidationError('ImpactedEntities[0] must be an object { type, name, entity }')
      resource = nonEmptyString(first['name'], 'ImpactedEntities[0].name')
      resourceKind = optionalString(first['type'])?.trim().toUpperCase() === 'HOST' ? 'hostname' : 'name'
      entityId = optionalString(first['entity'])?.trim()
    } else {
      const impacted = optionalString(payload['ImpactedEntity'])?.trim()
      if (!impacted) ({ resource, resourceKind } = defaultResourceOf(defaults, 'ImpactedEntities is empty and ImpactedEntity'))
      else {
        const known = DYNATRACE_ENTITY_PREFIXES.find(([prefix]) => impacted.toLowerCase().startsWith(`${prefix.toLowerCase()} `))
        if (!known) throw new ValidationError(`ImpactedEntity ${quoteValue(impacted)} does not start with a known entity type (${DYNATRACE_ENTITY_PREFIXES.map(([p]) => p).join(', ')}): paste the {ImpactedEntities} placeholder to get typed entities`)
        resource = nonEmptyString(impacted.slice(known[0].length), 'ImpactedEntity (after the type prefix)')
        resourceKind = known[1]
      }
    }

    const labels: Record<string, string> = {}
    for (const k of ['ProblemImpact', 'ProblemURL', 'ProblemID', 'Tags'] as const) {
      const v = optionalString(payload[k]); if (v && v.trim()) labels[k] = v
    }
    if (entityId) labels['dynatrace_entity'] = entityId

    const ev: NormalizedEvent = { externalId: externalId.trim(), status, severity, title, resource, resourceKind, labels }
    if (entityId) ev.resourceExternalId = entityId
    const description = optionalString(payload['ProblemDetailsText'])
    if (description && description.trim()) ev.description = description
    return ev
  })
}

// ── generic: mappatore senza codice ──────────────────────────────────────────

/** Campi normalizzati che il connettore generic sa leggere dal payload (chiavi di field_mapping). */
export const GENERIC_FIELDS = ['title', 'severity', 'status', 'resource', 'resourceKind', 'resourceExternalId', 'externalId', 'description', 'labels', 'startsAt', 'endsAt'] as const
export type GenericField = (typeof GENERIC_FIELDS)[number]

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
 * Connettore generic: ogni campo normalizzato si legge al percorso puntato di
 * field_mapping (campo non mappato → chiave omonima alla radice del payload),
 * poi default_values riempie i campi ancora assenti, poi value_mapping
 * traduce severity/status. `resourceKind` viene dal payload (se mappato) o da
 * default_values.resourceKind: l'interfaccia lo scrive sempre (hostname
 * predefinito), il codice non lo inventa. `labels` accetta oggetto, lista
 * `["k:v"]` o stringa CSV (B6).
 */
function normalizeGeneric(payload: unknown, fieldMapping: Record<string, string>, defaults: Record<string, unknown>, valueMapping: ValueMapping): NormalizedBatch {
  return single(() => {
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
      labels:   parseLabels(read('labels'), 'labels'),
    }
    const externalId  = optionalString(read('externalId'));  if (externalId)  ev.externalId  = externalId
    const resourceExternalId = optionalString(read('resourceExternalId')); if (resourceExternalId) ev.resourceExternalId = resourceExternalId
    const description = optionalString(read('description')); if (description) ev.description = description
    const startsAt    = optionalString(read('startsAt'));    if (startsAt)    ev.startsAt    = startsAt
    const endsAt      = optionalString(read('endsAt'));      if (endsAt)      ev.endsAt      = endsAt
    return ev
  })
}

/**
 * Payload grezzo del webhook → eventi normalizzati PER ELEMENTO (A1).
 * `alertmanager`/`grafana`: uno per elemento di `alerts`, ciascuno accettato o
 * scartato da solo. `zabbix`/`datadog`/`dynatrace`/`generic`: un oggetto per
 * chiamata (indice 0). Un difetto della busta (payload non oggetto, `alerts`
 * assente, oltre MAX_EVENTS_PER_REQUEST, connettore sconosciuto) → ValidationError
 * dell'intera richiesta; il difetto di un elemento → voce di `rejected`.
 */
export function normalizeBatch(
  connectorKind: ConnectorKind,
  payload: unknown,
  fieldMapping: Record<string, string>,
  defaults: Record<string, unknown>,
  valueMapping: ValueMapping = {},
  opts: NormalizeOptions = {},
): NormalizedBatch {
  switch (connectorKind) {
    case 'alertmanager': return normalizeAlertsArray('alertmanager', payload, defaults, valueMapping)
    case 'grafana':      return normalizeAlertsArray('grafana', payload, defaults, valueMapping)
    case 'zabbix':       return normalizeZabbix(payload, defaults, valueMapping, opts)
    case 'datadog':      return normalizeDatadog(payload, defaults, valueMapping)
    case 'dynatrace':    return normalizeDynatrace(payload, defaults, valueMapping)
    case 'generic':      return normalizeGeneric(payload, fieldMapping, defaults, valueMapping)
    default: {
      const never: never = connectorKind
      throw new ValidationError(`Unknown connector_kind ${JSON.stringify(never)}`)
    }
  }
}

/**
 * Riepilogo degli scarti per `last_error` e per il 400 quando nessun elemento
 * passa: "N di M scartati: <primo errore>" (con un solo elemento il messaggio
 * è l'errore stesso, che porta già l'indice). Troncato: finisce nel grafo.
 */
export function rejectionSummary(batch: Pick<NormalizedBatch, 'rejected' | 'total'>, maxChars = 500): string {
  const first = batch.rejected[0]
  if (!first) return ''
  const message = batch.total === 1 ? first.error : `${batch.rejected.length} di ${batch.total} scartati: ${first.error}`
  return message.length > maxChars ? `${message.slice(0, maxChars - 1)}…` : message
}

/**
 * Variante "tutto o niente" di `normalizeBatch`: anteprima, campione e test.
 * Il primo elemento scartato fa fallire l'intera chiamata con il suo motivo.
 */
export function normalizePayload(
  connectorKind: ConnectorKind,
  payload: unknown,
  fieldMapping: Record<string, string>,
  defaults: Record<string, unknown>,
  valueMapping: ValueMapping = {},
  opts: NormalizeOptions = {},
): NormalizedEvent[] {
  const batch = normalizeBatch(connectorKind, payload, fieldMapping, defaults, valueMapping, opts)
  const first = batch.rejected[0]
  if (first) throw new ValidationError(first.error)
  return batch.events
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
  else validatePresetDefaults(connectorKind, defaults)
  return { connectorKind, fieldMapping, defaults, valueMapping }
}

export function normalizeWithConfig(config: SourceConfig, payload: unknown, opts: NormalizeOptions = {}): NormalizedEvent[] {
  return normalizePayload(config.connectorKind, payload, config.fieldMapping, config.defaults, config.valueMapping, opts)
}

export function normalizeBatchWithConfig(config: SourceConfig, payload: unknown, opts: NormalizeOptions = {}): NormalizedBatch {
  return normalizeBatch(config.connectorKind, payload, config.fieldMapping, config.defaults, config.valueMapping, opts)
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
