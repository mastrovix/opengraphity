/**
 * Mappatore visuale del connettore `generic` — modulo puro (niente React).
 *
 * L'amministratore NON vede mai il JSON di field_mapping / default_values /
 * value_mapping: lo compone l'interfaccia da uno stato leggibile
 * (`GenericMapping`) e lo rilegge in modifica. Formato (confermato dall'API,
 * apps/api/src/services/eventService.ts, normalizeGeneric):
 *
 *   fieldMapping  = { title: "alert.name", severity: "alert.level", resource: "host.name", status: "state", description: "msg", externalId: "id" }
 *   defaultValues = { resourceKind: "hostname" }              (+ severity/status di default, facoltativi)
 *   valueMapping  = { severity: { major: "critical" }, status: { open: "firing", closed: "resolved" } }
 *
 * Un JSON esistente malformato o fuori vocabolario NON viene "aggiustato":
 * `parseSourceConfig` torna `error` e il chiamante lo mostra.
 */
import {
  RESOURCE_KINDS, EVENT_INPUT_STATUSES, EVENT_SEVERITIES,
  type ResourceKind, type EventSeverity, type EventInputStatus,
} from '@/types/events'

/** Campi normalizzati esposti nel mappatore, nell'ordine in cui compaiono. */
export const MAPPER_FIELDS = ['title', 'severity', 'resource', 'status', 'description', 'externalId'] as const
export type MapperField = (typeof MAPPER_FIELDS)[number]
export const REQUIRED_MAPPER_FIELDS: readonly MapperField[] = ['title', 'severity', 'resource']

export interface GenericMapping {
  /** Campo normalizzato → percorso puntato nel payload ('' = non usato). */
  fields:         Record<MapperField, string>
  resourceKind:   ResourceKind
  /** Valore trovato nel campo severità → severità OpenGrafo ('' = non ancora scelto). */
  severityValues: Record<string, EventSeverity | ''>
  /** Valore trovato nel campo stato → stato OpenGrafo ('' = non ancora scelto). */
  statusValues:   Record<string, EventInputStatus | ''>
}

export const EMPTY_MAPPING: GenericMapping = {
  fields: { title: '', severity: '', resource: '', status: '', description: '', externalId: '' },
  resourceKind: 'hostname',
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
  return {
    fieldMapping:  JSON.stringify(fieldMapping),
    defaultValues: JSON.stringify({ resourceKind: m.resourceKind }),
    valueMapping:  JSON.stringify(valueMapping),
  }
}

function parseObject(raw: string | null | undefined, what: string): { value: Record<string, unknown>; error: string | null } {
  if (raw == null || raw.trim() === '') return { value: {}, error: null }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { value: {}, error: `${what}: atteso un oggetto JSON` }
    return { value: parsed as Record<string, unknown>, error: null }
  } catch (e) {
    return { value: {}, error: `${what}: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/**
 * JSON salvati → stato del mappatore (pagina di modifica). Chiavi ignote di
 * field_mapping (labels, startsAt, …) restano fuori dal mappatore ma NON sono
 * un errore: l'API le accetta e la modifica le riscrive perse — per questo
 * vengono segnalate in `dropped`.
 */
export function parseSourceConfig(raw: { fieldMapping: string; defaultValues: string | null; valueMapping: string | null }): { mapping: GenericMapping; error: string | null; dropped: string[] } {
  const fm = parseObject(raw.fieldMapping, 'fieldMapping')
  const dv = parseObject(raw.defaultValues, 'defaultValues')
  const vm = parseObject(raw.valueMapping, 'valueMapping')
  const error = fm.error ?? dv.error ?? vm.error
  if (error) return { mapping: EMPTY_MAPPING, error, dropped: [] }

  const fields = { ...EMPTY_MAPPING.fields }
  const dropped: string[] = []
  for (const [k, v] of Object.entries(fm.value)) {
    if ((MAPPER_FIELDS as readonly string[]).includes(k)) {
      if (typeof v !== 'string') return { mapping: EMPTY_MAPPING, error: `fieldMapping.${k}: atteso un percorso (stringa)`, dropped: [] }
      fields[k as MapperField] = v
    } else if (k === 'resourceKind') {
      // resourceKind letto dal payload: non supportato dal mappatore (si sceglie a mano)
      dropped.push(k)
    } else {
      dropped.push(k)
    }
  }

  const rk = dv.value['resourceKind']
  let resourceKind: ResourceKind = 'hostname'
  if (rk !== undefined) {
    if (typeof rk !== 'string' || !(RESOURCE_KINDS as readonly string[]).includes(rk)) {
      return { mapping: EMPTY_MAPPING, error: `defaultValues.resourceKind: atteso uno tra ${RESOURCE_KINDS.join(', ')}`, dropped: [] }
    }
    resourceKind = rk as ResourceKind
  }

  const severityValues: Record<string, EventSeverity | ''> = {}
  const statusValues:   Record<string, EventInputStatus | ''> = {}
  const sevRaw = vm.value['severity']
  if (sevRaw !== undefined) {
    if (sevRaw === null || typeof sevRaw !== 'object') return { mapping: EMPTY_MAPPING, error: 'valueMapping.severity: atteso un oggetto', dropped: [] }
    for (const [src, dst] of Object.entries(sevRaw as Record<string, unknown>)) {
      if (typeof dst !== 'string' || !(EVENT_SEVERITIES as readonly string[]).includes(dst)) return { mapping: EMPTY_MAPPING, error: `valueMapping.severity.${src}: atteso uno tra ${EVENT_SEVERITIES.join(', ')}`, dropped: [] }
      severityValues[src] = dst as EventSeverity
    }
  }
  const stRaw = vm.value['status']
  if (stRaw !== undefined) {
    if (stRaw === null || typeof stRaw !== 'object') return { mapping: EMPTY_MAPPING, error: 'valueMapping.status: atteso un oggetto', dropped: [] }
    for (const [src, dst] of Object.entries(stRaw as Record<string, unknown>)) {
      if (typeof dst !== 'string' || !(EVENT_INPUT_STATUSES as readonly string[]).includes(dst)) return { mapping: EMPTY_MAPPING, error: `valueMapping.status.${src}: atteso uno tra ${EVENT_INPUT_STATUSES.join(', ')}`, dropped: [] }
      statusValues[src] = dst as EventInputStatus
    }
  }
  return { mapping: { fields, resourceKind, severityValues, statusValues }, error: null, dropped }
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
