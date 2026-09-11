/**
 * Mappatore visuale del connettore `generic` — modulo puro (niente React).
 *
 * L'amministratore NON vede mai il JSON di field_mapping / default_values /
 * value_mapping: lo compone l'interfaccia da uno stato leggibile
 * (`GenericMapping`) e lo rilegge in modifica. Formato (confermato dall'API,
 * apps/api/src/services/events/normalize.ts, normalizeGeneric):
 *
 *   fieldMapping  = { title: "alert.name", severity: "alert.level", resource: "host.name", status: "state", description: "msg", externalId: "id" }
 *   defaultValues = { resourceKind: "hostname", severity: "warning", status: "firing" }   (severity/status facoltativi: usati quando il campo manca)
 *   valueMapping  = { severity: { major: "critical" }, status: { open: "firing", closed: "resolved" } }
 *
 * Round-trip (D·1.2): tutto ciò che l'editor sa rappresentare viene riletto e
 * riscritto uguale; una chiave che NON sa rappresentare (default_values.title,
 * value_mapping.foo, field_mapping.labels…) finisce in `dropped` con il
 * prefisso del JSON di origine, così la pagina di modifica la mostra prima
 * che il salvataggio la perda. Un JSON malformato o fuori vocabolario NON
 * viene "aggiustato": `parseSourceConfig` torna `error` e il chiamante lo
 * mostra. I messaggi passano da i18n (`monitoring.errors.*`, D·6.4).
 */
import i18n from '@/i18n/i18n'
import {
  RESOURCE_KINDS, EVENT_INPUT_STATUSES, EVENT_SEVERITIES,
  type ResourceKind, type EventSeverity, type EventInputStatus, type ConnectorKind,
} from '@/types/events'

/** Campi normalizzati esposti nel mappatore, nell'ordine in cui compaiono. */
export const MAPPER_FIELDS = ['title', 'severity', 'resource', 'status', 'description', 'externalId'] as const
export type MapperField = (typeof MAPPER_FIELDS)[number]
export const REQUIRED_MAPPER_FIELDS: readonly MapperField[] = ['title', 'severity', 'resource']

export interface GenericMapping {
  /** Campo normalizzato → percorso puntato nel payload ('' = non usato). */
  fields:         Record<MapperField, string>
  resourceKind:   ResourceKind
  /** Severità usata quando il campo severità manca nel payload ('' = nessuna: l'allarme viene scartato). */
  defaultSeverity: EventSeverity | ''
  /** Stato usato quando il campo stato manca nel payload ('' = firing, il predefinito dell'API). */
  defaultStatus:   EventInputStatus | ''
  /** Valore trovato nel campo severità → severità OpenGrafo ('' = non ancora scelto). */
  severityValues: Record<string, EventSeverity | ''>
  /** Valore trovato nel campo stato → stato OpenGrafo ('' = non ancora scelto). */
  statusValues:   Record<string, EventInputStatus | ''>
}

export const EMPTY_MAPPING: GenericMapping = {
  fields: { title: '', severity: '', resource: '', status: '', description: '', externalId: '' },
  resourceKind: 'hostname',
  defaultSeverity: '',
  defaultStatus: '',
  severityValues: {},
  statusValues: {},
}

export interface SourceConfig {
  fieldMapping:  string
  defaultValues: string
  valueMapping:  string
}

/** I campi obbligatori sono mappati e ogni valore trovato ha una traduzione. */
export function isMappingComplete(m: GenericMapping): boolean {
  if (REQUIRED_MAPPER_FIELDS.some((f) => !m.fields[f].trim())) return false
  if (Object.values(m.severityValues).some((v) => v === '')) return false
  if (m.fields.status.trim() && Object.values(m.statusValues).some((v) => v === '')) return false
  return true
}

/** Stato del mappatore → i tre JSON che l'API si aspetta. */
export function buildSourceConfig(m: GenericMapping): SourceConfig {
  const fieldMapping: Record<string, string> = {}
  for (const f of MAPPER_FIELDS) {
    const path = m.fields[f].trim()
    if (path) fieldMapping[f] = path
  }
  const severity: Record<string, string> = {}
  for (const [src, dst] of Object.entries(m.severityValues)) if (dst) severity[src] = dst
  const status: Record<string, string> = {}
  if (m.fields.status.trim()) {
    for (const [src, dst] of Object.entries(m.statusValues)) if (dst) status[src] = dst
  }
  const valueMapping: Record<string, Record<string, string>> = {}
  if (Object.keys(severity).length) valueMapping['severity'] = severity
  if (Object.keys(status).length)   valueMapping['status']   = status
  const defaults: Record<string, string> = { resourceKind: m.resourceKind }
  if (m.defaultSeverity) defaults['severity'] = m.defaultSeverity
  if (m.defaultStatus)   defaults['status']   = m.defaultStatus
  return {
    fieldMapping:  JSON.stringify(fieldMapping),
    defaultValues: JSON.stringify(defaults),
    valueMapping:  JSON.stringify(valueMapping),
  }
}

// ── Messaggi (i18n: monitoring.errors.*) ─────────────────────────────────────

const expectedObject   = (what: string) => i18n.t('monitoring.errors.expectedObject', { what })
const expectedOneOf    = (what: string, values: readonly string[]) => i18n.t('monitoring.errors.expectedOneOf', { what, values: values.join(', ') })
const expectedNonEmpty = (what: string) => i18n.t('monitoring.errors.expectedNonEmpty', { what })
const notEditable      = (what: string) => i18n.t('monitoring.errors.notEditable', { what })
const notSupported     = (what: string) => i18n.t('monitoring.errors.notSupported', { what })

function parseObject(raw: string | null | undefined, what: string): { value: Record<string, unknown>; error: string | null } {
  if (raw == null || raw.trim() === '') return { value: {}, error: null }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { value: {}, error: expectedObject(what) }
    return { value: parsed as Record<string, unknown>, error: null }
  } catch (e) {
    return { value: {}, error: i18n.t('monitoring.errors.invalidJson', { what, error: e instanceof Error ? e.message : String(e) }) }
  }
}

/**
 * value_mapping.severity / value_mapping.status → tabella di traduzione.
 * `undefined` = chiave assente. Valore fuori vocabolario → `error`.
 */
function parseValueTable<T extends string>(raw: unknown, what: string, vocabulary: readonly T[]): { table: Record<string, T>; error: string | null } {
  const table: Record<string, T> = {}
  if (raw === undefined) return { table, error: null }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { table, error: expectedObject(what) }
  for (const [src, dst] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof dst !== 'string' || !(vocabulary as readonly string[]).includes(dst)) return { table, error: expectedOneOf(`${what}.${src}`, vocabulary) }
    table[src] = dst as T
  }
  return { table, error: null }
}

/**
 * JSON salvati → stato del mappatore (pagina di modifica). Chiavi che il
 * mappatore non rappresenta (field_mapping.labels, default_values.title,
 * value_mapping.foo, …) restano fuori ma NON sono un errore: l'API le accetta
 * e la modifica le riscriverebbe perse — per questo vengono segnalate in
 * `dropped` con il prefisso del JSON di origine (`defaultValues.title`).
 */
export function parseSourceConfig(raw: { fieldMapping: string; defaultValues: string | null; valueMapping: string | null }): { mapping: GenericMapping; error: string | null; dropped: string[] } {
  const fm = parseObject(raw.fieldMapping, 'fieldMapping')
  const dv = parseObject(raw.defaultValues, 'defaultValues')
  const vm = parseObject(raw.valueMapping, 'valueMapping')
  const error = fm.error ?? dv.error ?? vm.error
  if (error) return { mapping: EMPTY_MAPPING, error, dropped: [] }
  const fail = (message: string) => ({ mapping: EMPTY_MAPPING, error: message, dropped: [] })

  const fields = { ...EMPTY_MAPPING.fields }
  const dropped: string[] = []
  for (const [k, v] of Object.entries(fm.value)) {
    if ((MAPPER_FIELDS as readonly string[]).includes(k)) {
      if (typeof v !== 'string') return fail(i18n.t('monitoring.errors.expectedPath', { key: k }))
      fields[k as MapperField] = v
    } else {
      // resourceKind letto dal payload, labels, startsAt, …: l'API li accetta, il mappatore no
      dropped.push(`fieldMapping.${k}`)
    }
  }

  let resourceKind: ResourceKind = 'hostname'
  let defaultSeverity: EventSeverity | '' = ''
  let defaultStatus: EventInputStatus | '' = ''
  for (const [k, v] of Object.entries(dv.value)) {
    if (k === 'resourceKind') {
      if (typeof v !== 'string' || !(RESOURCE_KINDS as readonly string[]).includes(v)) return fail(expectedOneOf('defaultValues.resourceKind', RESOURCE_KINDS))
      resourceKind = v as ResourceKind
    } else if (k === 'severity') {
      // L'API accetterebbe anche un valore poi tradotto da value_mapping; l'editor espone solo il vocabolario.
      if (typeof v !== 'string' || !(EVENT_SEVERITIES as readonly string[]).includes(v)) return fail(expectedOneOf('defaultValues.severity', EVENT_SEVERITIES))
      defaultSeverity = v as EventSeverity
    } else if (k === 'status') {
      if (typeof v !== 'string' || !(EVENT_INPUT_STATUSES as readonly string[]).includes(v)) return fail(expectedOneOf('defaultValues.status', EVENT_INPUT_STATUSES))
      defaultStatus = v as EventInputStatus
    } else {
      dropped.push(`defaultValues.${k}`)
    }
  }

  const sev = parseValueTable<EventSeverity>(vm.value['severity'], 'valueMapping.severity', EVENT_SEVERITIES)
  if (sev.error) return fail(sev.error)
  const st = parseValueTable<EventInputStatus>(vm.value['status'], 'valueMapping.status', EVENT_INPUT_STATUSES)
  if (st.error) return fail(st.error)
  for (const k of Object.keys(vm.value)) if (k !== 'severity' && k !== 'status') dropped.push(`valueMapping.${k}`)

  return { mapping: { fields, resourceKind, defaultSeverity, defaultStatus, severityValues: sev.table, statusValues: st.table }, error: null, dropped }
}

/** Valore a un percorso puntato (`alert.level`, `alerts.0.labels.severity`) — stessa regola dell'API (getPath). */
export function valueAtPath(payload: unknown, path: string): unknown {
  let cur: unknown = payload
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined
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

/**
 * Percorso puntato in parole per chi non è tecnico (D·2.2): `alert.level` →
 * "level (in alert)", `alerts.0.labels.severity` → "severity (in alerts.0.labels)",
 * `id` → "id". `container` è la chiave i18n del testo tra parentesi ("in").
 */
export function readablePath(path: string, inWord: string): string {
  const segs = path.split('.')
  if (segs.length < 2) return path
  return `${segs[segs.length - 1]} (${inWord} ${segs.slice(0, -1).join('.')})`
}

/**
 * Valori distinti (stringhe) trovati nel payload di esempio al percorso scelto.
 * Un percorso con indice di array (`alerts.0.labels.severity`) raccoglie il
 * valore di OGNI elemento (`alerts.*.labels.severity`), così il mappatore
 * propone tutte le severità presenti nell'esempio.
 */
export function distinctValuesAtPath(payload: unknown, path: string): string[] {
  const out = new Set<string>()
  const collect = (cur: unknown, segs: string[]) => {
    if (segs.length === 0) {
      if (cur === null || cur === undefined || typeof cur === 'object') return
      out.add(String(cur))
      return
    }
    const [seg, ...rest] = segs as [string, ...string[]]
    if (Array.isArray(cur)) {
      if (/^\d+$/.test(seg)) cur.forEach((item) => collect(item, rest))
      return
    }
    if (cur !== null && typeof cur === 'object') collect((cur as Record<string, unknown>)[seg], rest)
  }
  if (path.trim()) collect(payload, path.split('.'))
  return [...out]
}

/**
 * Riallinea la tabella di traduzione ai valori trovati nel payload: i nuovi
 * valori entrano senza traduzione (''), quelli già scelti restano (anche se
 * aggiunti a mano e non presenti nell'esempio), tranne quando il campo è
 * stato deselezionato.
 */
export function syncValueTable<T extends string>(current: Record<string, T | ''>, found: string[], fieldPath: string): Record<string, T | ''> {
  if (!fieldPath.trim()) return {}
  const next: Record<string, T | ''> = { ...current }
  for (const v of found) if (!(v in next)) next[v] = ''
  return next
}

/**
 * Suggerimento di traduzione per un valore sorgente: solo quando la parola è
 * inequivocabile (già nel vocabolario o un sinonimo universale). Tutto il
 * resto resta '' e lo sceglie l'amministratore.
 */
export function suggestSeverity(value: string): EventSeverity | '' {
  const v = value.trim().toLowerCase()
  if ((EVENT_SEVERITIES as readonly string[]).includes(v)) return v as EventSeverity
  if (['crit', 'fatal', 'emergency', 'disaster', 'error', 'high', 'p1', 'sev1'].includes(v)) return 'critical'
  if (['warn', 'minor', 'average', 'medium', 'p2', 'sev2'].includes(v)) return 'warning'
  if (['information', 'informational', 'notice', 'low', 'ok', 'debug'].includes(v)) return 'info'
  return ''
}

export function suggestStatus(value: string): EventInputStatus | '' {
  const v = value.trim().toLowerCase()
  if ((EVENT_INPUT_STATUSES as readonly string[]).includes(v)) return v as EventInputStatus
  if (['open', 'active', 'alerting', 'triggered', 'problem', 'ok', 'up', 'down', '1'].includes(v)) return v === 'ok' || v === 'up' ? 'resolved' : 'firing'
  if (['closed', 'recovered', 'cleared', 'normal', '0'].includes(v)) return 'resolved'
  return ''
}

// ── Regole dei connettori preset (A1: value_mapping e risorsa predefinita) ──
// Speculare a validatePresetDefaults / mapPresetValue dell'API
// (apps/api/src/services/events/normalize.ts): per Alertmanager, Grafana,
// Zabbix, Datadog e Dynatrace l'amministratore non mappa i campi (la forma è
// fissa) ma può tradurre i valori di severità/stato che lo strumento usa,
// scegliere la risorsa da usare quando l'allarme non ne porta una (alert su
// metriche aggregate, monitor su log/APM) e la severità da usare quando
// l'allarme non ne porta una (default_values.severity, D·2.3). Senza queste
// regole l'allarme è scartato con il motivo in `lastError`: l'API non inventa nulla.

/** Connettori con la forma del payload già nota (tutti tranne generic). */
export type PresetConnectorKind = Exclude<ConnectorKind, 'generic'>

/** Sorgenti alternative della risorsa per connettore (`default_values.resourceFrom`); solo Datadog ne ha una. */
export const RESOURCE_FROM_OPTIONS: Readonly<Partial<Record<PresetConnectorKind, 'alert_scope'>>> = { datadog: 'alert_scope' }

export interface PresetRules {
  /** Valore di severità dello strumento → severità OpenGrafo ('' = non ancora scelto). */
  severityValues: Record<string, EventSeverity | ''>
  /** Valore di stato dello strumento → stato OpenGrafo ('' = non ancora scelto). */
  statusValues:   Record<string, EventInputStatus | ''>
  /**
   * Severità usata quando l'allarme non ne porta una, nelle parole dello
   * strumento ('' = nessuna: l'allarme viene scartato). L'API la tratta come un
   * valore ricevuto: prima la traduzione qui sopra, poi la tabella dello strumento.
   */
  defaultSeverity:     string
  /** Risorsa usata quando l'allarme non ne porta una ('' = nessuna: l'allarme viene scartato). */
  defaultResource:     string
  defaultResourceKind: ResourceKind
  /** Datadog: con hostname vuoto usa alert_scope come nome (default_values.resourceFrom = alert_scope). */
  resourceFromAlertScope: boolean
}

export const EMPTY_PRESET_RULES: PresetRules = {
  severityValues: {},
  statusValues: {},
  defaultSeverity: '',
  defaultResource: '',
  defaultResourceKind: 'name',
  resourceFromAlertScope: false,
}

/** Ogni valore aggiunto ha una traduzione (una riga senza destinazione sarebbe scartata dall'API in scrittura). */
export function isPresetRulesComplete(r: PresetRules): boolean {
  if (Object.values(r.severityValues).some((v) => v === '')) return false
  if (Object.values(r.statusValues).some((v) => v === '')) return false
  return true
}

/** Stato delle regole → i tre JSON che l'API si aspetta (field_mapping sempre vuoto: la forma è quella dello strumento). */
export function buildPresetConfig(kind: PresetConnectorKind, r: PresetRules): SourceConfig {
  const severity: Record<string, string> = {}
  for (const [src, dst] of Object.entries(r.severityValues)) if (dst) severity[src] = dst
  const status: Record<string, string> = {}
  for (const [src, dst] of Object.entries(r.statusValues)) if (dst) status[src] = dst
  const valueMapping: Record<string, Record<string, string>> = {}
  if (Object.keys(severity).length) valueMapping['severity'] = severity
  if (Object.keys(status).length)   valueMapping['status']   = status
  const defaults: Record<string, string> = {}
  if (r.defaultSeverity.trim()) defaults['severity'] = r.defaultSeverity.trim()
  if (r.defaultResource.trim()) {
    defaults['resource'] = r.defaultResource.trim()
    defaults['resourceKind'] = r.defaultResourceKind
  }
  if (r.resourceFromAlertScope && RESOURCE_FROM_OPTIONS[kind]) defaults['resourceFrom'] = RESOURCE_FROM_OPTIONS[kind]!
  return {
    fieldMapping:  '{}',
    defaultValues: JSON.stringify(defaults),
    valueMapping:  JSON.stringify(valueMapping),
  }
}

/**
 * JSON salvati di un connettore preset → regole (pagina di modifica). Un JSON
 * malformato, un valore fuori vocabolario o una chiave che l'editor non sa
 * rappresentare (es. una default_values scritta via API fuori da
 * severity/resource/resourceKind/resourceFrom) → `error`: mai un salvataggio
 * che perde regole in silenzio.
 */
export function parsePresetConfig(kind: PresetConnectorKind, raw: { defaultValues: string | null; valueMapping: string | null }): { rules: PresetRules; error: string | null } {
  const dv = parseObject(raw.defaultValues, 'defaultValues')
  const vm = parseObject(raw.valueMapping, 'valueMapping')
  const error = dv.error ?? vm.error
  if (error) return { rules: EMPTY_PRESET_RULES, error }
  const fail = (message: string) => ({ rules: EMPTY_PRESET_RULES, error: message })

  const rules: PresetRules = { ...EMPTY_PRESET_RULES, severityValues: {}, statusValues: {} }
  for (const [k, v] of Object.entries(dv.value)) {
    if (k === 'severity') {
      if (typeof v !== 'string' || !v.trim()) return fail(expectedNonEmpty('defaultValues.severity'))
      rules.defaultSeverity = v
    } else if (k === 'resource') {
      if (typeof v !== 'string' || !v.trim()) return fail(expectedNonEmpty('defaultValues.resource'))
      rules.defaultResource = v
    } else if (k === 'resourceKind') {
      if (typeof v !== 'string' || !(RESOURCE_KINDS as readonly string[]).includes(v)) return fail(expectedOneOf('defaultValues.resourceKind', RESOURCE_KINDS))
      rules.defaultResourceKind = v as ResourceKind
    } else if (k === 'resourceFrom') {
      if (v !== RESOURCE_FROM_OPTIONS[kind]) return fail(i18n.t('monitoring.errors.resourceFromNotAllowed', { kind }))
      rules.resourceFromAlertScope = true
    } else {
      return fail(notEditable(`defaultValues.${k}`))
    }
  }
  const sev = parseValueTable<EventSeverity>(vm.value['severity'], 'valueMapping.severity', EVENT_SEVERITIES)
  if (sev.error) return fail(sev.error)
  rules.severityValues = sev.table
  const st = parseValueTable<EventInputStatus>(vm.value['status'], 'valueMapping.status', EVENT_INPUT_STATUSES)
  if (st.error) return fail(st.error)
  rules.statusValues = st.table
  for (const k of Object.keys(vm.value)) {
    if (k !== 'severity' && k !== 'status') return fail(notSupported(`valueMapping.${k}`))
  }
  return { rules, error: null }
}

// ── Rate limit per sorgente (M7) ─────────────────────────────────────────────
// Speculare a apps/api/src/lib/webhookRateLimit.ts: 100 è l'unico default
// ammesso (webhook creati prima del campo), l'intervallo è validato anche dal server.

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 100
export const RATE_LIMIT_MIN = 1
export const RATE_LIMIT_MAX = 10_000

/** Campo `rateLimitPerMinute` letto da GET_MONITORING_SOURCE (non fa parte di MonitoringSource). */
export interface SourceRateLimit {
  rateLimitPerMinute: number
}

/** Testo del campo numerico → intero in 1..10000, altrimenti null (il pulsante Salva resta disabilitato). */
export function parseRateLimit(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null
  const n = Number(text.trim())
  return n >= RATE_LIMIT_MIN && n <= RATE_LIMIT_MAX ? n : null
}
