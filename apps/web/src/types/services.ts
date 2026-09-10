/**
 * Servizi monitorati (ondata 1): una BusinessApplication con una mappa dei
 * componenti che la reggono (`ServiceMap`), la salute calcolata dalle regole
 * d'impatto e la spiegazione di come ci si è arrivati.
 * Contratto: apps/api/src/graphql/schema-services.ts. `ServiceMapRow` è la
 * forma leggera delle liste (fragment `ServiceMapRowFields`), `ServiceMapDetail`
 * quella del dettaglio (nodi, archi, regole, cronologia).
 */
import type { CIHealth } from './events'

/** Salute del servizio: gli stessi termini dei CI più «in manutenzione» e «sconosciuta». */
export type ServiceHealth = 'operational' | 'degraded' | 'down' | 'maintenance' | 'unknown'
/** In ordine di gravità (è anche l'ordine della lista). */
export const SERVICE_HEALTHS: readonly ServiceHealth[] = ['down', 'degraded', 'maintenance', 'unknown', 'operational']

export type ServiceMapStatus = 'draft' | 'active' | 'paused'
export const SERVICE_MAP_STATUSES: readonly ServiceMapStatus[] = ['draft', 'active', 'paused']

/** «Pesa» del nodo: sempre, mai (informativo), ponderato (col suo peso). In ondata 1 always e weighted contano uguale. */
export type NodePropagation = 'always' | 'never' | 'weighted'
export const NODE_PROPAGATIONS: readonly NodePropagation[] = ['always', 'never', 'weighted']

/** Ruolo del nodo, proposto dal tipo del CI (livello 1 → entry). */
export type ServiceNodeRole = 'entry' | 'component' | 'infrastructure' | 'certificate'
export const SERVICE_NODE_ROLES: readonly ServiceNodeRole[] = ['entry', 'component', 'infrastructure', 'certificate']

/** Cosa ha causato la voce di cronologia. */
export type ServiceHealthTrigger = 'created' | 'ci_health' | 'rules_changed' | 'map_changed' | 'maintenance' | 'manual' | 'periodic'
export const SERVICE_HEALTH_TRIGGERS: readonly ServiceHealthTrigger[] = ['created', 'ci_health', 'rules_changed', 'map_changed', 'maintenance', 'manual', 'periodic']

/** Relazioni tecniche percorse in uscita (chi fornisce) per costruire la mappa. */
export const SERVICE_RELATIONSHIP_TYPES = ['DEPENDS_ON', 'HOSTED_ON', 'INSTALLED_ON', 'USES_CERTIFICATE'] as const
export type ServiceRelationshipType = (typeof SERVICE_RELATIONSHIP_TYPES)[number]

export const SERVICE_MAP_DEFAULT_DEPTH = 4
export const SERVICE_MAP_MAX_DEPTH     = 8

/** La BusinessApplication radice della mappa (criticità e owner dal catalogo). */
export interface ServiceRef {
  id:          string
  name:        string
  criticality: string | null
  ownerGroup:  { id: string; name: string } | null
}

/** Un CI citato in un percorso d'impatto (solo id e nome: il tipo è nel nodo della mappa). */
export interface ImpactPathRef {
  id:   string
  name: string
}

/**
 * Un nodo che ha pesato sulla salute: la sua salute, peso e criticità, e il
 * percorso dal nodo malato risalendo `via` fino al livello 1 (il servizio è
 * implicito in cima).
 */
export interface ImpactCause {
  ci:       { id: string; name: string; type: string }
  health:   CIHealth
  weight:   number
  critical: boolean
  path:     ImpactPathRef[]
}

/** Riga della lista (fragment `ServiceMapRowFields`): niente nodi, archi né cronologia. */
export interface ServiceMapRow {
  id:          string
  name:        string
  status:      ServiceMapStatus
  health:      ServiceHealth
  /** Da quando la salute attuale è in vigore. */
  healthSince: string | null
  /** 0..100: quota ponderata dei componenti non operativi. */
  impactScore: number
  /** Un componente incluso non esiste più nella CMDB. */
  stale:       boolean
  nodeCount:   number
  evaluatedAt: string | null
  service:     ServiceRef
  /** Cause ordinate: critiche prima, poi peso, poi livello (max 20). */
  explanation: ImpactCause[]
}

/** Contatori di tutto il tenant, indipendenti dal filtro. */
export interface ServiceMapCounts {
  total:       number
  operational: number
  degraded:    number
  down:        number
  maintenance: number
  unknown:     number
}

export interface ServiceMapPage {
  items:  ServiceMapRow[]
  total:  number
  counts: ServiceMapCounts
}

/** Variabili di `serviceMaps(filter)` — specchio di `ServiceMapFilter`. */
export interface ServiceMapFilterVars {
  health?: ServiceHealth[]
  status?: ServiceMapStatus
  search?: string
}

/** Un componente della mappa con le impostazioni della relazione INCLUDES e la salute attuale del CI. */
export interface ServiceMapNode {
  ci:            { id: string; name: string; type: string }
  /** 1 = applicazioni raggiunte via REALIZES, 2.. = componenti; il servizio (livello 0) non è un nodo. */
  level:         number
  role:          ServiceNodeRole
  propagate:     NodePropagation
  /** 1..10 */
  weight:        number
  critical:      boolean
  /** Id del CI da cui si arriva (null a livello 1). */
  via:           string | null
  addedBy:       string
  /** Salute del CI dal monitoraggio; null = mai toccato da un allarme. */
  health:        CIHealth | null
  /** In finestra di change: non pesa. */
  inMaintenance: boolean
  /** Ha contato nell'ultima valutazione (pesa, non in manutenzione, salute nota o regola «operativi»). */
  contributes:   boolean
}

/** Arco vivo fra due nodi inclusi (id dei CI). */
export interface ServiceMapEdge {
  source:  string
  target:  string
  relType: string
}

export interface ServiceHealthEntry {
  id:             string
  at:             string
  health:         ServiceHealth
  previousHealth: ServiceHealth | null
  impactScore:    number
  trigger:        ServiceHealthTrigger
  causes:         ImpactCause[]
  note:           string | null
}

/** Regole per servizio (JSON versionato sulla mappa), in sola lettura in ondata 1. */
export interface ServiceImpactRules {
  version:          number
  downSharePct:     number
  degradedSharePct: number
  minNodes:         number
  unknownNodes:     string
  openIncidentFrom: string
}

/** Mappa completa (query `serviceMap`): riga + configurazione, nodi, archi, regole, cronologia. */
export interface ServiceMapDetail extends ServiceMapRow {
  /** Contatore di modifica: si rimanda come `expectedVersion` nelle mutation. */
  version:           number
  updatedAt:         string | null
  maxDepth:          number
  relationshipTypes: string[]
  builtFrom:         string
  rules:             ServiceImpactRules
  nodes:             ServiceMapNode[]
  edges:             ServiceMapEdge[]
  /** Ultime 50 voci, dalla più recente. */
  history:           ServiceHealthEntry[]
  historyCount:      number
}
