/** Event Management (GET_EVENTS / GET_EVENT) — unica definizione per lista, dettaglio e azioni. */

export type EventStatus   = 'firing' | 'resolved' | 'suppressed' | 'flapping'
export type EventSeverity = 'info' | 'warning' | 'critical'
export type CIAliasKind   = 'hostname' | 'ip' | 'fqdn' | 'external_id'
/** Salute del CI derivata dal monitoraggio (`ci.health`), separata dal ciclo di vita (`status`). */
export type CIHealth      = 'operational' | 'degraded' | 'down'

export const EVENT_STATUSES:    readonly EventStatus[]   = ['firing', 'resolved', 'suppressed', 'flapping']
export const EVENT_SEVERITIES:  readonly EventSeverity[] = ['critical', 'warning', 'info']
export const CI_ALIAS_KINDS:    readonly CIAliasKind[]   = ['hostname', 'ip', 'fqdn', 'external_id']

/**
 * Esito della correlazione automatica (ondata 3, `Event.correlation`):
 * cosa ha fatto la policy con l'evento all'ultima valutazione.
 * - opened / attached / reopened: incident aperto, agganciato o riaperto;
 * - skipped_orphan: nessun CI riconosciuto (collegare un CI rivaluta);
 * - skipped_severity: sotto la soglia `openIncidentFrom`;
 * - delayed: in attesa del ritardo `openDelaySeconds`;
 * - suppressed: silenziato da una change in finestra di rilascio;
 * - auto_resolved: l'incident è stato risolto perché la sorgente ha risolto;
 * - none: nessuna valutazione (es. policy "mai").
 * Ondata 4:
 * - flapping: l'allarme va e viene troppo spesso (≥ flapThreshold passaggi
 *   nella finestra): nessun incident aperto/chiuso finché non resta stabile
 *   per flapStableMinutes;
 * - storm: la sorgente manda troppi allarmi nuovi al minuto: l'evento è
 *   raggruppato nell'unico incident di tempesta della sorgente;
 * - storm_no_ci: come storm, ma senza CI riconosciuto.
 */
export type EventCorrelation =
  | 'opened' | 'attached' | 'reopened'
  | 'skipped_orphan' | 'skipped_severity' | 'delayed' | 'suppressed'
  | 'auto_resolved' | 'none'
  | 'flapping' | 'storm' | 'storm_no_ci'

export const EVENT_CORRELATIONS: readonly EventCorrelation[] = [
  'opened', 'attached', 'reopened', 'skipped_orphan', 'skipped_severity', 'delayed', 'suppressed', 'auto_resolved', 'none',
  'flapping', 'storm', 'storm_no_ci',
]

/** Stati in cui "Rivaluta ora" ha senso: la policy può decidere diversamente. */
export const REEVALUABLE_CORRELATIONS: readonly EventCorrelation[] = ['suppressed', 'delayed', 'skipped_orphan']

/** Riferimento leggero alla change che ha silenziato l'evento (`Event.suppressedBy`). */
export interface ChangeRef {
  id:    string
  code:  string
  title: string
}

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
  /** Change in finestra di rilascio che ha silenziato l'evento (correlation = suppressed). */
  suppressedBy:   ChangeRef | null
  correlation:    EventCorrelation
  /** Istante dell'ultima valutazione della policy. */
  correlationAt:  string | null
  /** Da quando l'allarme è in sfarfallio (status = flapping); null altrimenti. */
  flappingSince:  string | null
  /** Passaggi attivo/risolto nelle ultime 24 ore. */
  transitions24h: number
}

/** Contatori della console (un riquadro cliccabile per chiave). */
export interface EventStatCounts {
  firing:      number
  critical:    number
  warning:     number
  orphan:      number
  suppressed:  number
  flapping:    number
  resolved24h: number
}

/**
 * Sorgente in tempesta (ondata 4, `EventStats.stormSources`): manda più
 * allarmi nuovi al minuto della soglia `stormThresholdPerMinute`; i suoi
 * allarmi finiscono tutti nell'incident di tempesta (se ne ha uno).
 */
export interface StormSource {
  sourceId:       string
  sourceName:     string
  ratePerMinute:  number
  /** Inizio della tempesta (ISO). */
  since:          string
  incidentId:     string | null
  incidentNumber: string | null
}

export interface EventStats extends EventStatCounts {
  stormSources: StormSource[]
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
  /** Minuti senza passaggi prima che un allarme in sfarfallio torni alla correlazione normale. */
  flapStableMinutes:    number
  /** Allarmi nuovi al minuto da una sorgente oltre i quali scatta la tempesta. */
  stormThresholdPerMinute: number
  /** Minuti sotto soglia prima di chiudere la tempesta. */
  stormCooldownMinutes: number
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
  /** Eventi correlati a un incident. */
  incidentId?:           string
  /** Eventi silenziati da una change. */
  suppressedByChangeId?: string
}
