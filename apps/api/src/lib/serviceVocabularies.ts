/**
 * Vocabolari chiusi dei Servizi monitorati (mappa del servizio + albero
 * d'impatto): UNA sola definizione per ciascuno, come lib/eventVocabularies.ts
 * per l'Event Management.
 *
 * Da qui li leggono lo schema GraphQL (schema-services.ts genera gli `enum`
 * SDL da queste liste), il motore (services/serviceImpact/*), il consumer, il
 * seed e la migrazione. Il modulo è puro (importa solo l'altro vocabolario,
 * lib/eventVocabularies.ts, per il ciclo di vita del CI): lo schema lo carica
 * anche nei test che non toccano Neo4j/Redis. Il test
 * graphql/__tests__/schemaServices.test.ts verifica che ogni enum SDL
 * coincida con la lista qui definita.
 *
 * Progetto: scratchpad service-impact-opengrafo.html (10 set 2026), ondata 1.
 */
import { CI_LIFECYCLE_DECOMMISSIONED, CI_LIFECYCLE_INACTIVE, type CILifecycleStatus } from './eventVocabularies.js'

/** Salute del servizio (`ServiceMap.health`): gli stessi termini del CI più maintenance e unknown. */
export const SERVICE_HEALTHS = ['operational', 'degraded', 'down', 'maintenance', 'unknown'] as const
export type ServiceHealth = (typeof SERVICE_HEALTHS)[number]

/** Ordine di gravità per la lista (down prima, operational per ultimo). */
export const SERVICE_HEALTH_SEVERITY_ORDER: readonly ServiceHealth[] = ['down', 'degraded', 'maintenance', 'unknown', 'operational']

/** Stato della mappa: `draft` (ondata 2, non ancora valutata dal monitoraggio), `active`, `paused` (nessuna valutazione automatica). */
export const SERVICE_MAP_STATUSES = ['draft', 'active', 'paused'] as const
export type ServiceMapStatus = (typeof SERVICE_MAP_STATUSES)[number]

/** Quanto pesa un nodo (`INCLUDES.propagate`): sempre, mai (informativo), col suo peso. In ondata 1 always e weighted contano allo stesso modo. */
export const NODE_PROPAGATIONS = ['always', 'never', 'weighted'] as const
export type NodePropagation = (typeof NODE_PROPAGATIONS)[number]

/** Ruolo del nodo nella mappa (`INCLUDES.role`), proposto dal tipo del CI. */
export const SERVICE_NODE_ROLES = ['entry', 'component', 'infrastructure', 'certificate'] as const
export type ServiceNodeRole = (typeof SERVICE_NODE_ROLES)[number]

/** Cosa ha innescato una voce di cronologia del servizio (`ServiceHealthEntry.trigger`). */
export const SERVICE_HEALTH_TRIGGERS = ['created', 'ci_health', 'rules_changed', 'map_changed', 'maintenance', 'manual', 'periodic'] as const
export type ServiceHealthTrigger = (typeof SERVICE_HEALTH_TRIGGERS)[number]

/** Relazioni tecniche IN USCITA seguite dalla costruzione automatica: `(x)-[r]->(y)` = y è un fornitore di x. */
export const SERVICE_RELATIONSHIP_TYPES = ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE'] as const
export type ServiceRelationshipType = (typeof SERVICE_RELATIONSHIP_TYPES)[number]

/** Come contano i nodi senza salute (mai toccati da un allarme): ignorati o operativi. Mai «giù». */
export const UNKNOWN_NODES_MODES = ['ignore', 'operational'] as const
export type UnknownNodesMode = (typeof UNKNOWN_NODES_MODES)[number]

/**
 * Cosa fa la mappa mentre una sorgente dei suoi allarmi è in tempesta
 * (`ServiceImpactRules.during_storm`, revisione 2 · D6.4): `hold` (default) =
 * la valutazione è sospesa — la salute resta quella di prima, nessun incident
 * di servizio aperto né chiuso, la nota (`ServiceMap.health_note`) dice quale
 * sorgente è in tempesta; `evaluate` = si valuta comunque (comportamento
 * precedente). Una tempesta è quasi sempre un guasto della raccolta, non 60
 * guasti veri: gli allarmi la contengono in UN incident, i servizi la
 * contenevano in un incident per mappa.
 */
export const DURING_STORM_MODES = ['evaluate', 'hold'] as const
export type DuringStormMode = (typeof DURING_STORM_MODES)[number]

/**
 * Ciclo di vita del CI per cui un componente NON conta nella mappa (revisione
 * 2 · D6.3): dismesso o fuori servizio. Il monitoraggio non ne aggiorna la
 * salute e nessuno lo «chiude», quindi non rende il servizio `maintenance`:
 * esce dal calcolo con `excludedReason = lifecycle_decommissioned`. È la
 * stessa famiglia di stati che la policy degli allarmi ignora di default.
 */
export const CI_LIFECYCLE_RETIRED: readonly CILifecycleStatus[] = [CI_LIFECYCLE_INACTIVE, CI_LIFECYCLE_DECOMMISSIONED]

/** True se il ciclo di vita del CI lo mette fuori dal calcolo della mappa. */
export function isRetiredLifecycle(status: string | null | undefined): boolean {
  return status != null && (CI_LIFECYCLE_RETIRED as readonly string[]).includes(status)
}

/** Soglia di salute da cui il servizio apre un incident (ondata 3; in ondata 1 solo conservata). */
export const SERVICE_OPEN_INCIDENT_FROM = ['never', 'down', 'degraded'] as const
export type ServiceOpenIncidentFrom = (typeof SERVICE_OPEN_INCIDENT_FROM)[number]

/**
 * Perché la mappa è «da rivedere» (`ServiceMap.stale_reason`, revisione 2):
 * `missing_ci` = un componente incluso non esiste più nella CMDB (lo scrive il
 * motore), `over_limit` = la proposta supera il tetto dei 500 componenti e la
 * sincronizzazione non ha applicato nulla (lo scrive la sincronizzazione). Le
 * due cose si risolvono in modi diversi, quindi la UI deve poterle distinguere.
 */
export const SERVICE_STALE_REASONS = ['missing_ci', 'over_limit'] as const
export type ServiceStaleReason = (typeof SERVICE_STALE_REASONS)[number]

/** I due motivi come costanti: nel Cypher si interpolano da qui, mai a mano. */
export const SERVICE_STALE_MISSING_CI: ServiceStaleReason = 'missing_ci'
export const SERVICE_STALE_OVER_LIMIT: ServiceStaleReason = 'over_limit'

/**
 * Perché un componente NON conta nel calcolo (`ServiceMapNode.excludedReason`,
 * revisione 2 · R1). null quando conta. Le due manutenzioni sono distinte:
 * `lifecycle_maintenance` = `ci.status = 'maintenance'` (il CI è fuori servizio
 * per il suo ciclo di vita: gli allarmi non ne aggiornano la salute),
 * `change_window` = una change è in finestra su quel CI (solo questa, e solo su
 * un componente critico, può rendere il SERVIZIO `maintenance`).
 * Revisione 2 · D6.2 e D6.3: `upstream_change_window` = la change è su un CI a
 * MONTE (la stessa regola che silenzia gli allarmi, `suppress_upstream_hops`
 * salti lungo le relazioni tecniche) e `lifecycle_decommissioned` = il CI è
 * dismesso o fuori servizio (CI_LIFECYCLE_RETIRED).
 */
export const NODE_EXCLUDED_REASONS = ['never', 'lifecycle_decommissioned', 'lifecycle_maintenance', 'change_window', 'upstream_change_window', 'unknown_health'] as const
export type NodeExcludedReason = (typeof NODE_EXCLUDED_REASONS)[number]

/** Motivo di una `EXCLUDES` creata dall'amministratore dal diff della mappa (ondata 2). */
export const SERVICE_EXCLUSION_REASON_MANUAL = 'escluso a mano'

/**
 * Criticità dell'applicazione radice (`BusinessApplication.criticality`).
 *
 * Il vocabolario vive nel metamodello (`scripts/seed-metamodel.ts`, campo
 * `criticality` del tipo `business_application`): qui c'è la copia che serve a
 * VALIDARE il filtro della pagina Servizi, tenuta uguale da
 * `serviceVocabularies.test.ts`. Il dato sul grafo può comunque essere assente
 * o fuori vocabolario (CI importato da una discovery): chi lo legge lo tratta
 * come tale (`serviceImpactOf`), chi lo filtra no — un filtro su un valore
 * inesistente è un errore del chiamante, non un dato incompleto.
 */
export const SERVICE_CRITICALITIES = ['mission_critical', 'business_critical', 'business_operational', 'office_productivity'] as const
export type ServiceCriticality = (typeof SERVICE_CRITICALITIES)[number]

/**
 * Le criticità che il banner «servizi critici giù» considera critiche
 * (revisione 2 · C-7): prima il web leggeva 20 righe e filtrava a valle, così
 * in una tempesta con 20 servizi non critici giù il banner taceva proprio
 * quando serviva. Ora è il server a filtrare.
 */
export const SERVICE_CRITICAL_CRITICALITIES: readonly ServiceCriticality[] = ['mission_critical', 'business_critical']

/** Limiti espliciti della mappa: superarli è un errore di validazione, mai un taglio silenzioso. */
export const SERVICE_MAP_DEFAULT_DEPTH = 4
export const SERVICE_MAP_MAX_DEPTH = 8
export const SERVICE_MAP_MAX_NODES = 500
/** Voci di cronologia conservate per mappa (mai la prima, trigger `created`). */
export const SERVICE_HISTORY_MAX = 500
/** Cause riportate nella spiegazione (le più pesanti). */
export const SERVICE_MAX_CAUSES = 20

/** Peso di un nodo: 1..10. */
export const NODE_WEIGHT_MIN = 1
export const NODE_WEIGHT_MAX = 10
/** Pesi proposti dalla costruzione automatica: livello 1 → 8, certificato → 3, altrimenti 5. */
export const NODE_WEIGHT_DEFAULT = 5
export const NODE_WEIGHT_ENTRY = 8
export const NODE_WEIGHT_CERTIFICATE = 3

/**
 * Ruolo proposto dal tipo (label Neo4j) del CI, per i nodi oltre il livello 1
 * (il livello 1 è sempre `entry`). Copre TUTTE le label statiche del
 * metamodello (lib/ciLabels.ts): la costruzione include solo CI con quelle
 * label, quindi una label assente qui è un errore di programmazione, non un
 * caso da coprire con un default.
 */
export const ROLE_BY_CI_LABEL: Readonly<Record<string, ServiceNodeRole>> = {
  Application:         'component',
  Microservice:        'component',
  ApiEndpoint:         'component',
  BusinessApplication: 'component',
  BusinessCapability:  'component',
  DynamicCIGroup:      'component',
  Server:              'infrastructure',
  VirtualMachine:      'infrastructure',
  Storage:             'infrastructure',
  NetworkDevice:       'infrastructure',
  CloudService:        'infrastructure',
  Database:            'infrastructure',
  DatabaseInstance:    'infrastructure',
  Certificate:         'certificate',
  SslCertificate:      'certificate',
}

export function roleOfLabels(labels: readonly string[], level: number): ServiceNodeRole {
  if (level === 1) return 'entry'
  for (const l of labels) {
    const role = ROLE_BY_CI_LABEL[l]
    if (role) return role
  }
  throw new Error(`No service node role for CI labels ${JSON.stringify(labels)}: the label is not in ROLE_BY_CI_LABEL (lib/serviceVocabularies.ts)`)
}

// ── Regole d'impatto del servizio (ServiceMap.rules, JSON versionato) ────────

export interface ServiceImpactRules {
  version:            1
  /** Quota ponderata di nodi giù (in %) da cui il servizio è giù. */
  down_share_pct:     number
  /** Punteggio d'impatto (in %) da cui il servizio è degradato («1» = basta uno). */
  degraded_share_pct: number
  /** Numero minimo di nodi non operativi che contano perché il servizio sia degradato. */
  min_nodes:          number
  unknown_nodes:      UnknownNodesMode
  open_incident_from: ServiceOpenIncidentFrom
  /** Cosa fare mentre una sorgente degli allarmi dei componenti è in tempesta: sospendere la valutazione (default) o valutare comunque. */
  during_storm:       DuringStormMode
}

export const DEFAULT_SERVICE_IMPACT_RULES: ServiceImpactRules = {
  version:            1,
  down_share_pct:     50,
  degraded_share_pct: 1,
  min_nodes:          1,
  unknown_nodes:      'operational',
  open_incident_from: 'down',
  during_storm:       'hold',
}
export const DEFAULT_SERVICE_IMPACT_RULES_JSON = JSON.stringify(DEFAULT_SERVICE_IMPACT_RULES)

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function assertPct(value: unknown, field: string, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error(`${what}.${field} must be an integer between 0 and 100. Got: ${JSON.stringify(value)}`)
  }
  return value
}

/** Validazione completa: un campo mancante o fuori vocabolario è un errore, mai un default silenzioso. */
export function assertServiceImpactRules(value: unknown, what = 'rules'): ServiceImpactRules {
  if (!isRecord(value)) throw new Error(`${what} must be a JSON object. Got: ${JSON.stringify(value)}`)
  if (value['version'] !== 1) throw new Error(`${what}.version must be 1. Got: ${JSON.stringify(value['version'])}`)
  const minNodes = value['min_nodes']
  if (typeof minNodes !== 'number' || !Number.isInteger(minNodes) || minNodes < 1) {
    throw new Error(`${what}.min_nodes must be an integer >= 1. Got: ${JSON.stringify(minNodes)}`)
  }
  const unknownNodes = value['unknown_nodes']
  if (typeof unknownNodes !== 'string' || !(UNKNOWN_NODES_MODES as readonly string[]).includes(unknownNodes)) {
    throw new Error(`${what}.unknown_nodes must be one of: ${UNKNOWN_NODES_MODES.join(', ')}. Got: ${JSON.stringify(unknownNodes)}`)
  }
  const openFrom = value['open_incident_from']
  if (typeof openFrom !== 'string' || !(SERVICE_OPEN_INCIDENT_FROM as readonly string[]).includes(openFrom)) {
    throw new Error(`${what}.open_incident_from must be one of: ${SERVICE_OPEN_INCIDENT_FROM.join(', ')}. Got: ${JSON.stringify(openFrom)}`)
  }
  const duringStorm = value['during_storm']
  if (typeof duringStorm !== 'string' || !(DURING_STORM_MODES as readonly string[]).includes(duringStorm)) {
    throw new Error(`${what}.during_storm must be one of: ${DURING_STORM_MODES.join(', ')}. Got: ${JSON.stringify(duringStorm)}`)
  }
  const known = new Set(Object.keys(DEFAULT_SERVICE_IMPACT_RULES))
  const unknown = Object.keys(value).filter((k) => !known.has(k))
  if (unknown.length) throw new Error(`${what} has unknown keys: ${unknown.join(', ')}`)
  return {
    version:            1,
    down_share_pct:     assertPct(value['down_share_pct'], 'down_share_pct', what),
    degraded_share_pct: assertPct(value['degraded_share_pct'], 'degraded_share_pct', what),
    min_nodes:          minNodes,
    unknown_nodes:      unknownNodes as UnknownNodesMode,
    open_incident_from: openFrom as ServiceOpenIncidentFrom,
    during_storm:       duringStorm as DuringStormMode,
  }
}

/** `ServiceMap.rules` (stringa JSON) → regole validate. Assente o corrotta = mappa non scritta dal motore: errore con l'id della mappa. */
export function parseServiceImpactRules(raw: unknown, mapId: string): ServiceImpactRules {
  if (raw == null || raw === '') throw new Error(`ServiceMap ${mapId} has no rules — run the 20260910_1080_service_maps_bootstrap migration`)
  if (typeof raw !== 'string') throw new Error(`ServiceMap ${mapId} rules is not a JSON string (got ${typeof raw})`)
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (e) { throw new Error(`ServiceMap ${mapId} rules is corrupt JSON: ${e instanceof Error ? e.message : String(e)}`) }
  return assertServiceImpactRules(parsed, `ServiceMap ${mapId} rules`)
}

/**
 * Regole con le chiavi mancanti prese dai default (migrazione 1080): `null`
 * se non manca nulla, così il chiamante non riscrive regole già complete.
 * Solo chiavi assenti: un valore presente, anche se non valido, non viene
 * toccato (lo segnala parseServiceImpactRules).
 */
export function completeServiceImpactRules(parsed: Record<string, unknown>): Record<string, unknown> | null {
  const missing = (Object.keys(DEFAULT_SERVICE_IMPACT_RULES) as (keyof ServiceImpactRules)[]).filter((k) => parsed[k] === undefined)
  if (missing.length === 0) return null
  const out: Record<string, unknown> = { ...parsed }
  for (const k of missing) out[k] = DEFAULT_SERVICE_IMPACT_RULES[k]
  return out
}

/** Nome enum SDL → lista TS: la tabella che schema-services.ts usa per generare gli enum e che il test confronta con lo schema. */
export const SERVICE_SDL_ENUMS: Readonly<Record<string, readonly string[]>> = {
  ServiceHealth:            SERVICE_HEALTHS,
  ServiceMapStatus:         SERVICE_MAP_STATUSES,
  NodePropagation:          NODE_PROPAGATIONS,
  ServiceNodeRole:          SERVICE_NODE_ROLES,
  ServiceHealthTrigger:     SERVICE_HEALTH_TRIGGERS,
  UnknownNodesMode:         UNKNOWN_NODES_MODES,
  ServiceOpenIncidentFrom:  SERVICE_OPEN_INCIDENT_FROM,
  ServiceStaleReason:       SERVICE_STALE_REASONS,
  DuringStormMode:          DURING_STORM_MODES,
}

/** `enum Nome { a b c }` per l'SDL. */
export function sdlEnum(name: keyof typeof SERVICE_SDL_ENUMS): string {
  return `enum ${name} { ${SERVICE_SDL_ENUMS[name]!.join(' ')} }`
}
