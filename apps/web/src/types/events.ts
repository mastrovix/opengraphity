/** Event Management (GET_EVENTS / GET_EVENT) — unica definizione per lista, dettaglio e azioni. */

export type EventStatus   = 'firing' | 'resolved' | 'suppressed' | 'flapping'
export type EventSeverity = 'info' | 'warning' | 'critical'
export type CIAliasKind   = 'hostname' | 'ip' | 'fqdn' | 'external_id'
/** Salute del CI derivata dal monitoraggio (`ci.health`), separata dal ciclo di vita (`status`). */
export type CIHealth      = 'operational' | 'degraded' | 'down'

export const EVENT_STATUSES:    readonly EventStatus[]   = ['firing', 'resolved', 'suppressed', 'flapping']
export const EVENT_SEVERITIES:  readonly EventSeverity[] = ['critical', 'warning', 'info']
export const CI_ALIAS_KINDS:    readonly CIAliasKind[]   = ['hostname', 'ip', 'fqdn', 'external_id']

export interface ConfigurationItemRef {
  id:     string
  name:   string
  type:   string
  /** Ciclo di vita (active, inactive, maintenance, decommissioned). */
  status: string | null
  /** Salute dal monitoraggio; null finché nessun evento ha riguardato il CI. */
  health: CIHealth | null
}

export interface MonitoringEvent {
  id:             string
  fingerprint:    string
  externalId:     string | null
  status:         EventStatus
  severity:       EventSeverity
  title:          string
  description:    string | null
  resource:       string
  resourceKind:   string
  /** Etichette della sorgente, JSON serializzato. */
  labels:         string | null
  count:          number
  firstSeenAt:    string
  lastSeenAt:     string
  resolvedAt:     string | null
  acknowledgedAt: string | null
  acknowledgedBy: { id: string; name: string } | null
  source:         { id: string; name: string; connectorKind: string | null } | null
  ci:             ConfigurationItemRef | null
  incident:       { id: string; number: string; title: string; status: string } | null
}

export interface EventStats {
  firing:      number
  critical:    number
  warning:     number
  orphan:      number
  suppressed:  number
  flapping:    number
  resolved24h: number
}

export interface CIAlias {
  id:        string
  kind:      CIAliasKind
  value:     string
  source:    string
  createdAt: string
  ci:        ConfigurationItemRef
}

export interface EventPolicy {
  openIncidentFrom:     string
  groupBy:              string
  openDelaySeconds:     number
  autoResolve:          boolean
  suppressUpstreamHops: number
  flapThreshold:        number
  flapWindowMinutes:    number
  retentionDays:        number
  /** Mappa severità → impatto/urgenza, JSON serializzato. */
  severityMap:          string
}

// ── Ondata 2: sorgenti di monitoraggio e configurazione senza codice ─────────

/** Connettori supportati (`InboundWebhook.connectorKind` con entityType = event). */
export type ConnectorKind = 'generic' | 'alertmanager' | 'grafana' | 'zabbix' | 'datadog' | 'dynatrace'
export const CONNECTOR_KINDS: readonly ConnectorKind[] = ['alertmanager', 'grafana', 'zabbix', 'datadog', 'dynatrace', 'generic']

/** Cosa rappresenta la stringa `resource` dell'evento (default_values.resourceKind del connettore generic). */
export type ResourceKind = 'hostname' | 'ip' | 'fqdn' | 'external_id' | 'name'
export const RESOURCE_KINDS: readonly ResourceKind[] = ['hostname', 'ip', 'fqdn', 'external_id', 'name']

/** Stati che una sorgente può dichiarare in ingresso (value_mapping.status). */
export type EventInputStatus = 'firing' | 'resolved'
export const EVENT_INPUT_STATUSES: readonly EventInputStatus[] = ['firing', 'resolved']

export const CI_HEALTHS: readonly CIHealth[] = ['operational', 'degraded', 'down']

/** Sorgente di monitoraggio: `InboundWebhook` con entityType = event (query `monitoringSources`). */
export interface MonitoringSource {
  id:             string
  name:           string
  entityType:     string
  connectorKind:  ConnectorKind | null
  /** JSON campo normalizzato → percorso puntato (solo generic). */
  fieldMapping:   string
  defaultValues:  string | null
  valueMapping:   string | null
  enabled:        boolean
  lastReceivedAt: string | null
  receiveCount:   number
  /** Motivo dell'ultimo payload rifiutato; null dopo il primo batch accettato. */
  lastError:      string | null
  lastErrorAt:    string | null
  errorCount:     number
  createdAt:      string
}

/** Chiave di un payload di esempio con percorso puntato e valore (query `payloadKeys`). */
export interface PayloadKey {
  path:   string
  sample: string
}

/** Risultato di `previewInboundEvents`: cosa diventerebbe il payload, senza ingerirlo. */
export interface NormalizedEventPreview {
  externalId:   string | null
  status:       string
  severity:     string
  title:        string
  description:  string | null
  resource:     string
  resourceKind: string
  /** Etichette estratte, JSON serializzato. */
  labels:       string
}

/** Salute di un CI vista dal monitoraggio (query `ciHealth`, mutation `setCIHealthOverride`). */
export interface CIHealthInfo {
  ciId:         string
  health:       CIHealth | null
  /** 'monitoring' | 'manual' (forzatura). Null finché nessun evento ha riguardato il CI. */
  healthSource: string | null
  lastEventAt:  string | null
  firingEvents: number
}

// ── Pagina "Salute CI" (query `ciHealthOverview`) ────────────────────────────

/** Origine della salute di un CI: calcolata dagli allarmi o forzata a mano. */
export type CIHealthSource = 'monitoring' | 'manual'

/** Una riga della pagina Salute CI: CI con dati di salute, impatto e squadra. */
export interface CIHealthRow {
  id:           string
  name:         string
  /** Nome del tipo del metamodello (server, database, …): alimenta `ciPath`. */
  type:         string
  environment:  string | null
  health:       CIHealth
  healthSource: CIHealthSource | null
  /** Da quando la salute attuale è in vigore (ci.health_since). */
  healthSince:  string | null
  lastEventAt:  string | null
  firingEvents: number
  /** CI che dipendono direttamente da questo (DEPENDS_ON entranti): l'impatto. */
  dependents:   number
  ownerTeam:    string | null
}

/** Contatori di tutto il tenant (indipendenti dal filtro) + righe filtrate e paginate. */
export interface CIHealthOverview {
  down:        number
  degraded:    number
  operational: number
  /** CI del tenant senza alcun dato di salute. */
  unmonitored: number
  items:       CIHealthRow[]
  total:       number
}

/** Variabili di `ciHealthOverview(filter)` — specchio di `CIHealthFilter`. */
export interface CIHealthFilterVars {
  health?:      CIHealth[]
  type?:        string
  environment?: string
  /** Id del team proprietario (OWNED_BY). */
  team?:        string
  search?:      string
}

/** Variabili di `events(filter)` — specchio di `EventFilter`. */
export interface EventFilterVars {
  status?:   EventStatus[]
  severity?: EventSeverity[]
  ciId?:     string
  sourceId?: string
  orphan?:   boolean
  search?:   string
  since?:    string
}
