/**
 * EventPolicy per tenant (Event Management, ondata 1).
 *
 * Vive su `Tenant.event_policy` come JSON serializzato. È l'unica sorgente
 * dei valori iniziali: la usano la migrazione di bootstrap, l'onboarding del
 * tenant, il servizio eventi e il resolver `eventPolicy`/`updateEventPolicy`.
 *
 * Niente fallback silenziosi: un JSON mancante o corrotto sul tenant è un
 * errore (la migrazione 20260909_1010_event_management_fixup crea i nodi
 * :Tenant mancanti e garantisce la presenza della policy; la
 * 20260909_1040_event_management_policy_v2 aggiunge le chiavi dell'ondata 4 —
 * sfarfallio stabile e tempeste — alle policy già scritte), un input che esce
 * dai valori ammessi è una ValidationError.
 */
import { ValidationError } from './errors.js'

/** Chiavi introdotte dall'ondata 4: se mancano, la policy è di una versione precedente (migrazione 1040 non eseguita). */
export const EVENT_POLICY_V2_KEYS = ['flap_stable_minutes', 'storm_threshold_per_minute', 'storm_cooldown_minutes'] as const
export const EVENT_POLICY_V2_MIGRATION = '20260909_1040_event_management_policy_v2'

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
  /** Passaggi firing↔resolved in `flap_window_minutes` oltre i quali l'evento è `flapping` (0 = rilevamento spento). */
  flap_threshold:         number
  flap_window_minutes:    number
  /** Minuti senza passaggi dopo i quali un evento `flapping` torna allo stato dell'ultimo payload. */
  flap_stable_minutes:    number
  /** Eventi NUOVI al minuto dalla stessa sorgente oltre i quali la sorgente è in tempesta (0 = rilevamento spento). */
  storm_threshold_per_minute: number
  /** Minuti consecutivi sotto soglia dopo i quali la tempesta finisce. */
  storm_cooldown_minutes: number
  /** Giorni dopo `resolved_at` oltre i quali un evento risolto viene eliminato dal job `purge_events` (0 = mai). */
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
  flap_stable_minutes:    15,
  storm_threshold_per_minute: 50,
  storm_cooldown_minutes: 5,
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
    flap_stable_minutes:    assertNonNegativeInt(value['flap_stable_minutes'], `${what}.flap_stable_minutes`),
    storm_threshold_per_minute: assertNonNegativeInt(value['storm_threshold_per_minute'], `${what}.storm_threshold_per_minute`),
    storm_cooldown_minutes: assertNonNegativeInt(value['storm_cooldown_minutes'], `${what}.storm_cooldown_minutes`),
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
    // Una policy valida ma di versione precedente (senza le chiavi dell'ondata 4)
    // non è un dato corrotto: è la migrazione che manca, e va detto.
    const missingV2 = isRecord(parsed) ? EVENT_POLICY_V2_KEYS.filter((k) => parsed[k] === undefined) : []
    const hint = missingV2.length ? ` — missing ${missingV2.join(', ')}: run the ${EVENT_POLICY_V2_MIGRATION} migration` : ''
    throw new Error(`Tenant ${tenantId} event_policy is invalid: ${e instanceof Error ? e.message : String(e)}${hint}`)
  }
}

/**
 * Policy con le chiavi mancanti prese da DEFAULT_EVENT_POLICY (usata dalla
 * migrazione 1040). Restituisce `null` se non manca nulla, così il chiamante
 * non riscrive policy già complete. Solo chiavi assenti: un valore presente,
 * anche se non valido, non viene toccato (lo segnala parseEventPolicy).
 */
export function completeEventPolicy(parsed: Record<string, unknown>): Record<string, unknown> | null {
  const missing = (Object.keys(DEFAULT_EVENT_POLICY) as (keyof EventPolicy)[]).filter((k) => parsed[k] === undefined)
  if (missing.length === 0) return null
  const out: Record<string, unknown> = { ...parsed }
  for (const k of missing) out[k] = structuredClone(DEFAULT_EVENT_POLICY[k])
  return out
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
  flapStableMinutes:    number
  stormThresholdPerMinute: number
  stormCooldownMinutes: number
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
    flapStableMinutes:    p.flap_stable_minutes,
    stormThresholdPerMinute: p.storm_threshold_per_minute,
    stormCooldownMinutes: p.storm_cooldown_minutes,
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
  flapStableMinutes?:    number | null
  stormThresholdPerMinute?: number | null
  stormCooldownMinutes?: number | null
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
    flapStableMinutes:    'flap_stable_minutes',
    stormThresholdPerMinute: 'storm_threshold_per_minute',
    stormCooldownMinutes: 'storm_cooldown_minutes',
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
