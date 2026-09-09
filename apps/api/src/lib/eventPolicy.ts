/**
 * EventPolicy per tenant (Event Management, ondata 1).
 *
 * Vive su `Tenant.event_policy` come JSON serializzato. È l'unica sorgente
 * dei valori iniziali: la usano la migrazione di bootstrap, l'onboarding del
 * tenant, il servizio eventi e il resolver `eventPolicy`/`updateEventPolicy`.
 *
 * Niente fallback silenziosi: un JSON mancante o corrotto sul tenant è un
 * errore (la migrazione 20260909_1010_event_management_fixup crea i nodi
 * :Tenant mancanti e garantisce la presenza della policy), un input che esce
 * dai valori ammessi è una ValidationError.
 */
import { ValidationError } from './errors.js'

export const OPEN_INCIDENT_FROM = ['info', 'warning', 'critical', 'never'] as const
export const GROUP_BY           = ['ci', 'fingerprint'] as const
export const EVENT_SEVERITIES   = ['info', 'warning', 'critical'] as const
export const IMPACT_URGENCY     = ['low', 'medium', 'high'] as const

export type EventSeverity = (typeof EVENT_SEVERITIES)[number]
export type SeverityMapEntry = { impact: (typeof IMPACT_URGENCY)[number]; urgency: (typeof IMPACT_URGENCY)[number] }
export type SeverityMap = Record<EventSeverity, SeverityMapEntry>

/** Forma persistita (snake_case, come le proprietà Neo4j). */
export interface EventPolicy {
  open_incident_from:     (typeof OPEN_INCIDENT_FROM)[number]
  group_by:               (typeof GROUP_BY)[number]
  open_delay_seconds:     number
  auto_resolve:           boolean
  suppress_upstream_hops: number
  flap_threshold:         number
  flap_window_minutes:    number
  retention_days:         number
  severity_map:           SeverityMap
}

export const DEFAULT_EVENT_POLICY: EventPolicy = {
  open_incident_from:     'critical',
  group_by:               'ci',
  open_delay_seconds:     0,
  auto_resolve:           true,
  suppress_upstream_hops: 1,
  flap_threshold:         4,
  flap_window_minutes:    10,
  retention_days:         90,
  severity_map: {
    critical: { impact: 'high',   urgency: 'high' },
    warning:  { impact: 'medium', urgency: 'medium' },
    info:     { impact: 'low',    urgency: 'low' },
  },
}

export const DEFAULT_EVENT_POLICY_JSON = JSON.stringify(DEFAULT_EVENT_POLICY)

// ── Validazione ──────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}. Got: ${JSON.stringify(value)}`)
  }
  return value as T
}

function assertNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be an integer >= 0. Got: ${JSON.stringify(value)}`)
  }
  return value
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean. Got: ${JSON.stringify(value)}`)
  }
  return value
}

/** Valida una severity_map già decodificata: esattamente le tre severità, ognuna con impact/urgency ammessi. */
export function assertSeverityMap(value: unknown, field = 'severity_map'): SeverityMap {
  if (!isRecord(value)) throw new ValidationError(`${field} must be a JSON object keyed by ${EVENT_SEVERITIES.join(', ')}`)
  const out = {} as SeverityMap
  for (const sev of EVENT_SEVERITIES) {
    const entry = value[sev]
    if (!isRecord(entry)) throw new ValidationError(`${field}.${sev} is missing or not an object`)
    out[sev] = {
      impact:  assertEnum(entry['impact'],  IMPACT_URGENCY, `${field}.${sev}.impact`),
      urgency: assertEnum(entry['urgency'], IMPACT_URGENCY, `${field}.${sev}.urgency`),
    }
  }
  const extra = Object.keys(value).filter((k) => !(EVENT_SEVERITIES as readonly string[]).includes(k))
  if (extra.length) throw new ValidationError(`${field} has unknown keys: ${extra.join(', ')}`)
  return out
}

/** Valida un oggetto policy completo (forma persistita). */
export function assertEventPolicy(value: unknown, what = 'event_policy'): EventPolicy {
  if (!isRecord(value)) throw new ValidationError(`${what} must be a JSON object`)
  return {
    open_incident_from:     assertEnum(value['open_incident_from'], OPEN_INCIDENT_FROM, `${what}.open_incident_from`),
    group_by:               assertEnum(value['group_by'], GROUP_BY, `${what}.group_by`),
    open_delay_seconds:     assertNonNegativeInt(value['open_delay_seconds'], `${what}.open_delay_seconds`),
    auto_resolve:           assertBoolean(value['auto_resolve'], `${what}.auto_resolve`),
    suppress_upstream_hops: assertNonNegativeInt(value['suppress_upstream_hops'], `${what}.suppress_upstream_hops`),
    flap_threshold:         assertNonNegativeInt(value['flap_threshold'], `${what}.flap_threshold`),
    flap_window_minutes:    assertNonNegativeInt(value['flap_window_minutes'], `${what}.flap_window_minutes`),
    retention_days:         assertNonNegativeInt(value['retention_days'], `${what}.retention_days`),
    severity_map:           assertSeverityMap(value['severity_map'], `${what}.severity_map`),
  }
}

/**
 * Decodifica `Tenant.event_policy`. Mancante → errore (il tenant non è stato
 * migrato); corrotto → errore con il motivo. Mai il default silenzioso.
 */
export function parseEventPolicy(raw: unknown, tenantId: string): EventPolicy {
  if (raw == null || raw === '') {
    throw new Error(`Tenant ${tenantId} has no event_policy — run the 20260909_1010_event_management_fixup migration`)
  }
  if (typeof raw !== 'string') {
    throw new Error(`Tenant ${tenantId} event_policy is not a JSON string (got ${typeof raw})`)
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (e) {
    throw new Error(`Tenant ${tenantId} event_policy is corrupt JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
  try { return assertEventPolicy(parsed, `Tenant ${tenantId} event_policy`) }
  catch (e) {
    throw new Error(`Tenant ${tenantId} event_policy is invalid: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── GraphQL ↔ persistita ─────────────────────────────────────────────────────

/** Forma GraphQL (`type EventPolicy` in schema-events.ts). */
export interface EventPolicyGQL {
  openIncidentFrom:     string
  groupBy:              string
  openDelaySeconds:     number
  autoResolve:          boolean
  suppressUpstreamHops: number
  flapThreshold:        number
  flapWindowMinutes:    number
  retentionDays:        number
  severityMap:          string
}

export function toEventPolicyGQL(p: EventPolicy): EventPolicyGQL {
  return {
    openIncidentFrom:     p.open_incident_from,
    groupBy:              p.group_by,
    openDelaySeconds:     p.open_delay_seconds,
    autoResolve:          p.auto_resolve,
    suppressUpstreamHops: p.suppress_upstream_hops,
    flapThreshold:        p.flap_threshold,
    flapWindowMinutes:    p.flap_window_minutes,
    retentionDays:        p.retention_days,
    severityMap:          JSON.stringify(p.severity_map),
  }
}

/** `input EventPolicyInput` (tutti i campi opzionali). */
export interface EventPolicyInputGQL {
  openIncidentFrom?:     string | null
  groupBy?:              string | null
  openDelaySeconds?:     number | null
  autoResolve?:          boolean | null
  suppressUpstreamHops?: number | null
  flapThreshold?:        number | null
  flapWindowMinutes?:    number | null
  retentionDays?:        number | null
  severityMap?:          string | null
}

/**
 * Applica un `EventPolicyInput` a una policy esistente e valida il risultato.
 * `null` su un campo è rifiutato (non esiste "azzera": la policy è sempre
 * completa); un campo assente resta invariato.
 */
export function applyEventPolicyInput(current: EventPolicy, input: EventPolicyInputGQL): EventPolicy {
  const next: Record<string, unknown> = { ...current }
  const map: Record<keyof EventPolicyInputGQL, keyof EventPolicy> = {
    openIncidentFrom:     'open_incident_from',
    groupBy:              'group_by',
    openDelaySeconds:     'open_delay_seconds',
    autoResolve:          'auto_resolve',
    suppressUpstreamHops: 'suppress_upstream_hops',
    flapThreshold:        'flap_threshold',
    flapWindowMinutes:    'flap_window_minutes',
    retentionDays:        'retention_days',
    severityMap:          'severity_map',
  }
  for (const [gql, key] of Object.entries(map) as [keyof EventPolicyInputGQL, keyof EventPolicy][]) {
    const v = input[gql]
    if (v === undefined) continue
    if (v === null) throw new ValidationError(`${gql} cannot be null`)
    if (gql === 'severityMap') {
      let parsed: unknown
      try { parsed = JSON.parse(v as string) }
      catch (e) { throw new ValidationError(`severityMap is not valid JSON: ${e instanceof Error ? e.message : String(e)}`) }
      next[key] = assertSeverityMap(parsed, 'severityMap')
    } else {
      next[key] = v
    }
  }
  return assertEventPolicy(next, 'eventPolicy')
}
