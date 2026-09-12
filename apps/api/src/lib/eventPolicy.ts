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
 * sfarfallio stabile e tempeste — alle policy già scritte; la
 * 20260909_1060_event_management_policy_version aggiunge `version` e
 * `updated_at`; la 20260910_1070_event_management_tenants aggiunge
 * `match_short_hostname` e crea i :Tenant mancanti anche per i tenant senza
 * utenti), un input che esce dai valori ammessi è una ValidationError.
 */
import { ValidationError } from './errors.js'
import {
  CI_LIFECYCLE_DECOMMISSIONED, CI_LIFECYCLE_INACTIVE, CI_LIFECYCLE_MAINTENANCE, CI_STATUS_VOCABULARY,
  EVENT_GROUP_BY, EVENT_SEVERITIES, OPEN_INCIDENT_FROM,
  type EventGroupBy, type EventSeverity, type OpenIncidentFrom,
} from './eventVocabularies.js'
import { assertDomainValue } from './domainMatrix.js'

/** Chiavi introdotte dall'ondata 4: se mancano, la policy è di una versione precedente (migrazione 1040 non eseguita). */
export const EVENT_POLICY_V2_KEYS = ['flap_stable_minutes', 'storm_threshold_per_minute', 'storm_cooldown_minutes'] as const
export const EVENT_POLICY_V2_MIGRATION = '20260909_1040_event_management_policy_v2'
/** Chiavi introdotte dalla revisione (C-4): versione esplicita e istante dell'ultima modifica (migrazione 1060). */
export const EVENT_POLICY_V3_KEYS = ['version', 'updated_at'] as const
export const EVENT_POLICY_V3_MIGRATION = '20260909_1060_event_management_policy_version'
/** Chiave introdotta dalla revisione (A-2): riconoscimento del CI anche per nome corto/FQDN (migrazione 1070). */
export const EVENT_POLICY_V4_KEYS = ['match_short_hostname'] as const
export const EVENT_POLICY_V4_MIGRATION = '20260910_1070_event_management_tenants'
/** Chiave introdotta dalla revisione 2 · D6.3: cicli di vita del CI ignorati dagli allarmi (migrazione 1130). */
export const EVENT_POLICY_V5_KEYS = ['ignore_lifecycle_statuses'] as const
export const EVENT_POLICY_V5_MIGRATION = '20260911_1130_shared_domain_rules'
/**
 * Chiavi introdotte dall'ondata 7 · C-4/A-14: la **semantica** del ciclo di
 * vita del CI diventa dato del cliente (migrazione 1810). Vedi
 * `lib/ciLifecycle.ts` per il perché della forma scelta.
 */
export const EVENT_POLICY_V6_KEYS = ['retired_statuses', 'maintenance_statuses'] as const
export const EVENT_POLICY_V6_MIGRATION = '20260917_1810_ci_lifecycle_semantics'

/** Vocabolari: la definizione è in eventVocabularies.ts (fonte unica anche per gli enum SDL); ri-esportati per i chiamanti storici. */
export { OPEN_INCIDENT_FROM, EVENT_SEVERITIES }
export const GROUP_BY           = EVENT_GROUP_BY
export const IMPACT_URGENCY     = ['low', 'medium', 'high'] as const

export type { EventSeverity }
export type SeverityMapEntry = { impact: (typeof IMPACT_URGENCY)[number]; urgency: (typeof IMPACT_URGENCY)[number] }
export type SeverityMap = Record<EventSeverity, SeverityMapEntry>

/**
 * Massimi per campo (I-7): senza un tetto `open_delay_seconds` = 2^31 sono 68
 * anni di attesa e `suppress_upstream_hops` = 2^31 è una traversata illimitata
 * delle dipendenze in findSuppressingChange. I valori sono generosi ma finiti;
 * la UI mostra il messaggio, quindi dice campo, minimo e massimo.
 */
export const EVENT_POLICY_MAX = {
  open_delay_seconds:     86_400,   // 24 ore
  suppress_upstream_hops: 10,
  flap_threshold:         1_000,
  flap_window_minutes:    1_440,    // 24 ore
  flap_stable_minutes:    1_440,
  storm_threshold_per_minute: 100_000,
  storm_cooldown_minutes: 1_440,
  retention_days:         3_650,    // 10 anni
} as const

/** Forma persistita (snake_case, come le proprietà Neo4j). */
export interface EventPolicy {
  /**
   * Contatore di modifica: parte da 1 (bootstrap) e cresce a ogni
   * updateEventPolicy. `EventPolicyInput.expectedVersion` lo confronta per
   * rifiutare il salvataggio sopra una modifica concorrente di un altro admin.
   */
  version:                number
  /** Istante dell'ultimo updateEventPolicy; null = mai modificata dopo il bootstrap. */
  updated_at:             string | null
  open_incident_from:     OpenIncidentFrom
  group_by:               EventGroupBy
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
  /**
   * Riconoscimento del CI per nome: se la risorsa dell'allarme è un FQDN
   * (`db-01.example.local`) prova anche il nome corto (`db-01`), e viceversa.
   * Spento per default: con nomi corti uguali in ambienti diversi il match
   * per prima etichetta sarebbe ambiguo. (Solo la regola: il confronto vive
   * nel riconoscimento del CI, services/events/ingest.)
   */
  match_short_hostname:   boolean
  /**
   * Cicli di vita del CI (`ci.status`) per cui un allarme non apre incident e
   * non cambia la salute: esito `skipped_lifecycle`, l'allarme resta in
   * console con il suo motivo (revisione 2 · D6.3). Default
   * `['decommissioned']`; lista vuota = nessuno stato ignorato. I valori
   * appartengono al vocabolario `ci_status` **del cliente** (ondata 7: la
   * validazione di appartenenza è in scrittura, `lib/ciLifecycle.ts`).
   */
  ignore_lifecycle_statuses: string[]
  /**
   * Ondata 7 · C-4/A-14 — **la semantica «ritirato»**: i cicli di vita per cui
   * un CI non conta in una mappa di servizio (`excludedReason =
   * lifecycle_decommissioned`). Era la costante `CI_LIFECYCLE_RETIRED`
   * (`['inactive','decommissioned']`): ora è dato del cliente, con quel
   * contenuto come valore iniziale.
   */
  retired_statuses:       string[]
  /**
   * Ondata 7 · C-4/A-14 — **la semantica «in manutenzione»**: i cicli di vita
   * per cui il monitoraggio non aggiorna `ci.health` e il componente esce dal
   * calcolo della mappa con `excludedReason = lifecycle_maintenance`. Era il
   * letterale `'maintenance'` nel Cypher di ciHealth.ts e la costante
   * `CI_LIFECYCLE_MAINTENANCE`: ora è dato del cliente, ed è una LISTA (un
   * cliente può avere «in manutenzione programmata» e «in manutenzione
   * straordinaria»), con `['maintenance']` come valore iniziale.
   */
  maintenance_statuses:   string[]
  severity_map:           SeverityMap
}

export const DEFAULT_EVENT_POLICY: EventPolicy = {
  version:                1,
  updated_at:             null,
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
  match_short_hostname:   false,
  ignore_lifecycle_statuses: [CI_LIFECYCLE_DECOMMISSIONED],
  retired_statuses:       [CI_LIFECYCLE_INACTIVE, CI_LIFECYCLE_DECOMMISSIONED],
  maintenance_statuses:   [CI_LIFECYCLE_MAINTENANCE],
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

/** Intero in [0, max]: il messaggio cita il massimo perché la UI lo mostra all'amministratore. */
function assertIntUpTo(value: unknown, max: number, field: string): number {
  const n = assertNonNegativeInt(value, field)
  if (n > max) throw new ValidationError(`${field} must be at most ${max}. Got: ${n}`)
  return n
}

function assertPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${field} must be an integer >= 1. Got: ${JSON.stringify(value)}`)
  }
  return value
}

function assertIsoOrNull(value: unknown, field: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO date or null. Got: ${JSON.stringify(value)}`)
  }
  return value
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean. Got: ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Valida la **forma** di una delle tre liste del ciclo di vita
 * (`ignore_lifecycle_statuses`, `retired_statuses`, `maintenance_statuses`):
 * lista, anche vuota, di stringhe non vuote, senza doppioni.
 *
 * Ondata 7 · C-4/A-14 — **qui non c'è più nessuna lista di valori**. Prima
 * questa funzione confrontava i valori con `CI_LIFECYCLE_STATUSES`, la lista
 * del CODICE: un cliente che avesse rinominato `decommissioned` in `dismesso`
 * si vedeva rifiutare il valore giusto (rumoroso) e conservare quello vecchio
 * (silenzioso). L'appartenenza al vocabolario `ci_status` **del cliente** si
 * controlla dove si può leggere il Dizionario, cioè in scrittura:
 * `assertTenantLifecycleStatuses` in lib/ciLifecycle.ts, chiamata da
 * `applyEventPolicyInput`.
 *
 * Perché la LETTURA (`parseEventPolicy`) valida solo la forma: la policy
 * salvata è dato del cliente e viene riletta a ogni allarme e a ogni
 * valutazione di mappa. Se togliere un valore dal Dizionario facesse fallire
 * la lettura, una modifica del vocabolario spegnerebbe l'intera pipeline degli
 * allarmi — molto peggio del difetto. Un valore rimasto nella lista e non più
 * nel vocabolario semplicemente non combacia con nessun CI; e non può nemmeno
 * restarci per sbaglio, perché `updateEnumType` rifiuta di togliere un valore
 * in uso, la policy inclusa (ondata 7 · B7-2).
 */
export function assertLifecycleStatuses(value: unknown, field = 'ignore_lifecycle_statuses'): string[] {
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be a list of CI lifecycle statuses (values of the ci_status vocabulary). Got: ${JSON.stringify(value)}`)
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string' || v === '') {
      throw new ValidationError(`${field}: ${JSON.stringify(v)} is not a non-empty string`)
    }
    if (out.includes(v)) throw new ValidationError(`${field}: ${v} appears twice`)
    out.push(v)
  }
  return out
}

/** Le tre liste della policy che contengono valori di `ci_status`: una definizione sola per validazione e interfaccia. */
export const LIFECYCLE_POLICY_LISTS = ['ignore_lifecycle_statuses', 'retired_statuses', 'maintenance_statuses'] as const
export type LifecyclePolicyList = (typeof LIFECYCLE_POLICY_LISTS)[number]

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

/**
 * Valida un oggetto policy completo (forma persistita): tipi, massimi per
 * campo (EVENT_POLICY_MAX) e coerenza incrociata (I-7): un rilevamento acceso
 * (soglia > 0) con la sua finestra/raffreddamento a 0 non ha senso — lo
 * sfarfallio non scatterebbe mai (finestra vuota) o la tempesta non finirebbe
 * mai — e prima veniva salvato senza dire nulla.
 */
export function assertEventPolicy(value: unknown, what = 'event_policy'): EventPolicy {
  if (!isRecord(value)) throw new ValidationError(`${what} must be a JSON object`)
  const policy: EventPolicy = {
    version:                assertPositiveInt(value['version'], `${what}.version`),
    updated_at:             assertIsoOrNull(value['updated_at'], `${what}.updated_at`),
    open_incident_from:     assertEnum(value['open_incident_from'], OPEN_INCIDENT_FROM, `${what}.open_incident_from`),
    group_by:               assertEnum(value['group_by'], GROUP_BY, `${what}.group_by`),
    open_delay_seconds:     assertIntUpTo(value['open_delay_seconds'], EVENT_POLICY_MAX.open_delay_seconds, `${what}.open_delay_seconds`),
    auto_resolve:           assertBoolean(value['auto_resolve'], `${what}.auto_resolve`),
    suppress_upstream_hops: assertIntUpTo(value['suppress_upstream_hops'], EVENT_POLICY_MAX.suppress_upstream_hops, `${what}.suppress_upstream_hops`),
    flap_threshold:         assertIntUpTo(value['flap_threshold'], EVENT_POLICY_MAX.flap_threshold, `${what}.flap_threshold`),
    flap_window_minutes:    assertIntUpTo(value['flap_window_minutes'], EVENT_POLICY_MAX.flap_window_minutes, `${what}.flap_window_minutes`),
    flap_stable_minutes:    assertIntUpTo(value['flap_stable_minutes'], EVENT_POLICY_MAX.flap_stable_minutes, `${what}.flap_stable_minutes`),
    storm_threshold_per_minute: assertIntUpTo(value['storm_threshold_per_minute'], EVENT_POLICY_MAX.storm_threshold_per_minute, `${what}.storm_threshold_per_minute`),
    storm_cooldown_minutes: assertIntUpTo(value['storm_cooldown_minutes'], EVENT_POLICY_MAX.storm_cooldown_minutes, `${what}.storm_cooldown_minutes`),
    retention_days:         assertIntUpTo(value['retention_days'], EVENT_POLICY_MAX.retention_days, `${what}.retention_days`),
    match_short_hostname:   assertBoolean(value['match_short_hostname'], `${what}.match_short_hostname`),
    ignore_lifecycle_statuses: assertLifecycleStatuses(value['ignore_lifecycle_statuses'], `${what}.ignore_lifecycle_statuses`),
    retired_statuses:       assertLifecycleStatuses(value['retired_statuses'], `${what}.retired_statuses`),
    maintenance_statuses:   assertLifecycleStatuses(value['maintenance_statuses'], `${what}.maintenance_statuses`),
    severity_map:           assertSeverityMap(value['severity_map'], `${what}.severity_map`),
  }
  if (policy.flap_threshold > 0 && policy.flap_window_minutes === 0) {
    throw new ValidationError(`${what}.flap_window_minutes must be > 0 when flap_threshold is > 0 (flapping detection is on but its window is empty; set flap_threshold = 0 to turn it off)`)
  }
  if (policy.storm_threshold_per_minute > 0 && policy.storm_cooldown_minutes === 0) {
    throw new ValidationError(`${what}.storm_cooldown_minutes must be > 0 when storm_threshold_per_minute is > 0 (a storm would never end; set storm_threshold_per_minute = 0 to turn storm detection off)`)
  }
  return policy
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
    // Una policy valida ma di versione precedente (senza le chiavi dell'ondata 4,
    // senza version/updated_at o senza match_short_hostname) non è un dato
    // corrotto: è la migrazione che manca, e va detto — la più vecchia per
    // prima, perché ognuna completa anche le chiavi delle successive (tutte
    // usano completeEventPolicy).
    const hints: string[] = []
    if (isRecord(parsed)) {
      const missingV2 = EVENT_POLICY_V2_KEYS.filter((k) => parsed[k] === undefined)
      const missingV3 = EVENT_POLICY_V3_KEYS.filter((k) => parsed[k] === undefined)
      const missingV4 = EVENT_POLICY_V4_KEYS.filter((k) => parsed[k] === undefined)
      const missingV5 = EVENT_POLICY_V5_KEYS.filter((k) => parsed[k] === undefined)
      const missingV6 = EVENT_POLICY_V6_KEYS.filter((k) => parsed[k] === undefined)
      if (missingV2.length) hints.push(` — missing ${missingV2.join(', ')}: run the ${EVENT_POLICY_V2_MIGRATION} migration`)
      else if (missingV3.length) hints.push(` — missing ${missingV3.join(', ')}: run the ${EVENT_POLICY_V3_MIGRATION} migration`)
      else if (missingV4.length) hints.push(` — missing ${missingV4.join(', ')}: run the ${EVENT_POLICY_V4_MIGRATION} migration`)
      else if (missingV5.length) hints.push(` — missing ${missingV5.join(', ')}: run the ${EVENT_POLICY_V5_MIGRATION} migration`)
      else if (missingV6.length) hints.push(` — missing ${missingV6.join(', ')}: run the ${EVENT_POLICY_V6_MIGRATION} migration`)
    }
    throw new Error(`Tenant ${tenantId} event_policy is invalid: ${e instanceof Error ? e.message : String(e)}${hints.join('')}`)
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

// ── Cache in memoria (M11 della revisione) ───────────────────────────────────

/**
 * La policy del tenant viene letta dal grafo (MATCH + JSON.parse + validazione)
 * a ogni allarme, più volte lungo la pipeline. Qui una cache per tenant con
 * TTL breve: `getEventPolicy` la consulta, `setEventPolicy` la invalida.
 * È per processo: su più repliche una modifica della policy arriva alle altre
 * entro EVENT_POLICY_CACHE_TTL_MS (limite noto e accettato, come per le altre
 * cache in memoria dell'API).
 */
export const EVENT_POLICY_CACHE_TTL_MS = 30_000

interface CachedPolicy { policy: EventPolicy; expiresAt: number }
const policyCache = new Map<string, CachedPolicy>()

export function getCachedEventPolicy(tenantId: string, nowMs: number = Date.now()): EventPolicy | null {
  const hit = policyCache.get(tenantId)
  if (!hit) return null
  if (hit.expiresAt <= nowMs) { policyCache.delete(tenantId); return null }
  return hit.policy
}

export function cacheEventPolicy(tenantId: string, policy: EventPolicy, nowMs: number = Date.now()): void {
  policyCache.set(tenantId, { policy, expiresAt: nowMs + EVENT_POLICY_CACHE_TTL_MS })
}

/** Senza argomento svuota tutto (test, shutdown). */
export function invalidateEventPolicyCache(tenantId?: string): void {
  if (tenantId === undefined) policyCache.clear()
  else policyCache.delete(tenantId)
}

// ── GraphQL ↔ persistita ─────────────────────────────────────────────────────

/** Forma GraphQL (`type EventPolicy` in schema-events.ts). */
export interface EventPolicyGQL {
  version:              number
  updatedAt:            string | null
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
  matchShortHostname:   boolean
  ignoreLifecycleStatuses: string[]
  retiredStatuses:      string[]
  maintenanceStatuses:  string[]
  severityMap:          string
}

export function toEventPolicyGQL(p: EventPolicy): EventPolicyGQL {
  return {
    version:              p.version,
    updatedAt:            p.updated_at,
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
    matchShortHostname:   p.match_short_hostname,
    ignoreLifecycleStatuses: [...p.ignore_lifecycle_statuses],
    retiredStatuses:      [...p.retired_statuses],
    maintenanceStatuses:  [...p.maintenance_statuses],
    severityMap:          JSON.stringify(p.severity_map),
  }
}

/** `input EventPolicyInput` (tutti i campi opzionali). */
export interface EventPolicyInputGQL {
  /** Versione che il client ha letto: se non è più quella attuale il salvataggio è rifiutato (modifica concorrente). */
  expectedVersion?:      number | null
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
  matchShortHostname?:   boolean | null
  /** Lista completa (non un delta): quella passata sostituisce la precedente; `[]` = nessuno stato ignorato. */
  ignoreLifecycleStatuses?: string[] | null
  /** Ondata 7: gli stati che contano come «ritirato» (lista completa, come sopra). */
  retiredStatuses?:      string[] | null
  /** Ondata 7: gli stati che contano come «in manutenzione» (lista completa, come sopra). */
  maintenanceStatuses?:  string[] | null
  severityMap?:          string | null
}

/**
 * Applica un `EventPolicyInput` a una policy esistente e valida il risultato.
 * `null` su un campo è rifiutato (non esiste "azzera": la policy è sempre
 * completa); un campo assente resta invariato. La policy risultante ha
 * `version` = attuale + 1 e `updated_at` = `now`. Con `expectedVersion`
 * diverso dalla versione attuale → ValidationError: il client ha letto una
 * policy che un altro amministratore ha già modificato (lost update).
 *
 * Ondata 7 · C-4/A-14: è **il** punto di scrittura della policy, quindi è qui
 * che le tre liste del ciclo di vita vengono confrontate con il vocabolario
 * `ci_status` **del cliente** (`assertDomainValue`, lib/domainMatrix.ts).
 * `tenantId` serve solo a questo. Per questo la funzione è asincrona: leggere
 * il Dizionario è una query (a cache calda, nessuna).
 */
export async function applyEventPolicyInput(
  tenantId: string, current: EventPolicy, input: EventPolicyInputGQL, now: string = new Date().toISOString(),
): Promise<EventPolicy> {
  if (input.expectedVersion != null && input.expectedVersion !== current.version) {
    throw new ValidationError(`eventPolicy was modified by someone else (expected version ${input.expectedVersion}, current is ${current.version}${current.updated_at ? `, updated at ${current.updated_at}` : ''}): reload it and apply your changes again`)
  }
  const next: Record<string, unknown> = { ...current, version: current.version + 1, updated_at: now }
  const map: Record<Exclude<keyof EventPolicyInputGQL, 'expectedVersion'>, keyof EventPolicy> = {
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
    matchShortHostname:   'match_short_hostname',
    ignoreLifecycleStatuses: 'ignore_lifecycle_statuses',
    retiredStatuses:      'retired_statuses',
    maintenanceStatuses:  'maintenance_statuses',
    severityMap:          'severity_map',
  }
  const LIFECYCLE_INPUTS: readonly string[] = ['ignoreLifecycleStatuses', 'retiredStatuses', 'maintenanceStatuses']
  for (const [gql, key] of Object.entries(map) as [Exclude<keyof EventPolicyInputGQL, 'expectedVersion'>, keyof EventPolicy][]) {
    const v = input[gql]
    if (v === undefined) continue
    if (v === null) throw new ValidationError(`${gql} cannot be null`)
    if (LIFECYCLE_INPUTS.includes(gql)) {
      const values = assertLifecycleStatuses(v, gql)
      // Il punto unico di validazione: il vocabolario è quello del cliente,
      // non una lista scritta qui (era il difetto C-4/A-14).
      for (const value of values) await assertDomainValue(tenantId, CI_STATUS_VOCABULARY, value)
      next[key] = values
    } else if (gql === 'severityMap') {
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
