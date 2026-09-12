/** Event Management (GET_EVENTS / GET_EVENT): `EventRow` per le liste, `MonitoringEvent` (completo) per dettaglio e mutation. */

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
 * Revisione 2 (D6.3):
 * - skipped_lifecycle: il CI dell'allarme è in uno degli stati del ciclo di
 *   vita che la policy ignora (`ignoreLifecycleStatuses`, di norma «dismesso»):
 *   nessun incident, nessun ricalcolo della salute; l'allarme resta in console
 *   col suo motivo.
 */
export type EventCorrelation =
  | 'opened' | 'attached' | 'reopened'
  | 'skipped_orphan' | 'skipped_severity' | 'delayed' | 'suppressed'
  | 'auto_resolved' | 'none'
  | 'flapping' | 'storm' | 'storm_no_ci'
  | 'pending' | 'skipped_lifecycle'

export const EVENT_CORRELATIONS: readonly EventCorrelation[] = [
  'opened', 'attached', 'reopened', 'skipped_orphan', 'skipped_severity', 'delayed', 'suppressed', 'auto_resolved', 'none',
  'flapping', 'storm', 'storm_no_ci', 'pending', 'skipped_lifecycle',
]

/** Stati in cui "Rivaluta ora" ha senso: la policy può decidere diversamente. */
export const REEVALUABLE_CORRELATIONS: readonly EventCorrelation[] = ['suppressed', 'delayed', 'skipped_orphan']

/**
 * Come è stato riconosciuto il CI all'ultimo ingest (`Event.matchReason`), in
 * ordine di precedenza: alias external_id, alias, nome esatto, nome corto
 * (policy matchShortHostname); `ambiguous` = più CI con lo stesso nome, l'evento
 * resta senza CI finché non viene collegato a mano; `manual` = collegato da un
 * operatore; `none` = nessuna corrispondenza. Null sugli eventi precedenti al campo.
 */
export type EventMatchReason = 'alias_external_id' | 'alias' | 'name' | 'name_short' | 'ambiguous' | 'none' | 'manual'
export const EVENT_MATCH_REASONS: readonly EventMatchReason[] = ['alias_external_id', 'alias', 'name', 'name_short', 'ambiguous', 'none', 'manual']

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

/**
 * Evento come lo vedono le LISTE (fragment `EventRowFields`): console,
 * allarmi di incident/change, ultimi eventi del CI. Solo i campi mostrati in
 * riga o necessari alle azioni per riga: niente descrizione, etichette,
 * impronta e altri campi pesanti, che restano al dettaglio.
 */
export interface EventRow {
  id:             string
  status:         EventStatus
  severity:       EventSeverity
  title:          string
  resource:       string
  resourceKind:   string
  count:          number
  lastSeenAt:     string
  /** Serve a "Prendi in carico" nella riga (nascosto se già presa). */
  acknowledgedAt: string | null
  /** Riferimento leggero alla sorgente (`MonitoringSourceRef`): la configurazione completa è `MonitoringSource`, solo admin. */
  source:         Pick<MonitoringSourceRef, 'id' | 'name' | 'connectorKind'> | null
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
  /** Esito del riconoscimento del CI: in riga serve solo per il badge "Ambiguo" sugli eventi senza CI. */
  matchReason:    EventMatchReason | null
}

/**
 * Campi scalari di `EventRow`: il FilterBuilder della console (applicato
 * lato client alla pagina corrente) offre solo questi, perché una regola su
 * un campo che la riga non porta non potrebbe essere valutata.
 */
export const EVENT_ROW_SCALAR_FIELDS: ReadonlySet<string> = new Set<keyof EventRow>([
  'id', 'status', 'severity', 'title', 'resource', 'resourceKind', 'count', 'lastSeenAt', 'acknowledgedAt',
  'correlation', 'correlationAt', 'flappingSince', 'transitions24h', 'matchReason',
])

/** Evento completo (fragment `EventFields`): dettaglio e risultati delle mutation. */
export interface MonitoringEvent extends EventRow {
  fingerprint:    string
  /** Identificativo dell'ALLARME presso la sorgente (fingerprint Alertmanager, event_id Zabbix…). */
  externalId:     string | null
  /** Identificativo della RISORSA (il CI) presso la sorgente: è quello confrontato con un alias external_id. */
  resourceExternalId: string | null
  /** Severità più alta vista nel ciclo corrente (riparte a ogni resolved → firing); null sugli eventi precedenti al campo. */
  maxSeverity:    EventSeverity | null
  description:    string | null
  /** Etichette della sorgente, JSON serializzato (sempre presente, almeno "{}"); un evento di prova ha sample = "true". */
  labels:         string
  firstSeenAt:    string
  resolvedAt:     string | null
  acknowledgedBy: { id: string; name: string } | null
}

/**
 * Voci della cronologia dell'allarme (`Event.history`): una per ogni
 * cambiamento di stato o esito, mai per le ripetizioni (bastano count e
 * lastSeenAt). Cicli: first_seen (sempre presente, sintetizzata da
 * firstSeenAt per gli allarmi precedenti alla cronologia), cycle_firing,
 * cycle_resolved, severity_changed (note = severità precedente). Automatiche:
 * correlated (outcome), suppressed/unsuppressed (change), flapping/stable
 * (note = "N passaggi in M min"), storm (incident), auto_resolved /
 * auto_resolve_skipped (incident, note = motivo). Manuali (actorId = utente):
 * acknowledged, resolved_manually (note), linked_ci (ci, note = 'alias'),
 * incident_opened_manually (incident), reevaluated.
 */
export type EventHistoryKind =
  | 'first_seen' | 'cycle_firing' | 'cycle_resolved' | 'severity_changed'
  | 'correlated' | 'suppressed' | 'unsuppressed' | 'flapping' | 'stable' | 'storm'
  | 'auto_resolved' | 'auto_resolve_skipped'
  | 'acknowledged' | 'resolved_manually' | 'linked_ci' | 'incident_opened_manually' | 'reevaluated'

export const EVENT_HISTORY_KINDS: readonly EventHistoryKind[] = [
  'first_seen', 'cycle_firing', 'cycle_resolved', 'severity_changed',
  'correlated', 'suppressed', 'unsuppressed', 'flapping', 'stable', 'storm',
  'auto_resolved', 'auto_resolve_skipped',
  'acknowledged', 'resolved_manually', 'linked_ci', 'incident_opened_manually', 'reevaluated',
]

/** Una voce della cronologia (fragment `EventHistoryFields`). */
export interface EventHistoryEntry {
  id:       string
  at:       string
  kind:     EventHistoryKind
  /** Esito di correlazione, solo per kind = correlated. */
  outcome:  EventCorrelation | null
  /** 'monitoring' per le azioni automatiche, altrimenti l'id dell'utente. */
  actorId:  string
  /** Null per il monitoraggio o se l'utente non esiste più (resta actorId). */
  actor:    { id: string; name: string } | null
  incident: { id: string; number: string; title: string } | null
  change:   ChangeRef | null
  ci:       Pick<ConfigurationItemRef, 'id' | 'name' | 'type'> | null
  severity: EventSeverity | null
  note:     string | null
}

/**
 * Evento del DETTAGLIO (query `GET_EVENT`): l'evento completo più la
 * cronologia. Solo il dettaglio la seleziona: le mutation restituiscono
 * `EventFields` e la pagina rilegge (`refetch`) per aggiornarla.
 */
export interface MonitoringEventDetail extends MonitoringEvent {
  /** Ultime 100 voci, dalla più recente. */
  history:      EventHistoryEntry[]
  /** Voci totali: se supera history.length la sezione dice "mostrate le ultime N di M". */
  historyCount: number
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
  /** Contatore di modifica: si rimanda come `expectedVersion` nell'input per non sovrascrivere la modifica di un altro amministratore. */
  version:              number
  /** Istante dell'ultimo salvataggio; null = mai modificata dopo il bootstrap. */
  updatedAt:            string | null
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
  /** Riconoscimento del CI per nome: FQDN ↔ nome corto (db-01.example.local ↔ db-01). */
  matchShortHostname:   boolean
  /**
   * Stati del ciclo di vita del CI (`ci.status`) che il monitoraggio ignora
   * (revisione 2, D6.3): un allarme su un CI in uno di questi stati ha esito
   * `skipped_lifecycle` — nessun incident, salute invariata. Vuoto = nessuno
   * stato ignorato. I valori sono quelli del metamodello (`baseCIType`), non
   * un vocabolario chiuso del web.
   */
  ignoreLifecycleStatuses: string[]
  /**
   * Ondata 7 · C-4/A-14 — la SEMANTICA del ciclo di vita, dato del cliente:
   * quali stati contano come «ritirato» (il componente non pesa nel calcolo
   * della salute dei servizi) e quali come «in manutenzione» (il monitoraggio
   * non ne aggiorna la salute). Prima erano costanti nell'API, e un valore
   * rinominato nel Dizionario cambiava il comportamento in silenzio.
   */
  retiredStatuses:      string[]
  maintenanceStatuses:  string[]
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

/**
 * Riferimento leggero a una sorgente (query `monitoringSourceRefs`, campo
 * `Event.source`): quanto serve alla console per nominarla e filtrare, a
 * tutti i ruoli dello staff. La configurazione completa è `MonitoringSource`.
 */
export interface MonitoringSourceRef {
  id:            string
  name:          string
  connectorKind: ConnectorKind | null
  enabled:       boolean
}

/** Sorgente di monitoraggio: `InboundWebhook` con entityType = event (query `monitoringSources`, solo admin). */
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
  /** Id della risorsa presso la sorgente (alias external_id del CI): entity di Dynatrace, host_id di Zabbix, field resourceExternalId del generic. Selezionato solo dove serve. */
  resourceExternalId?: string | null
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
  /** Quante mappe di servizio attive includono questo CI (ondata 3 dei Servizi monitorati). */
  servicesCount: number
  ownerTeam:    string | null
}

/** Contatori di tutto il tenant (indipendenti dal filtro) + righe filtrate e paginate. */
export interface CIHealthOverview {
  down:        number
  degraded:    number
  operational: number
  /** CI del tenant senza alcun dato di salute. */
  unmonitored: number
  /** Somma dei CI che dipendono direttamente dai CI giù di tutto il tenant (impatto complessivo, non della pagina). */
  downDependents:     number
  /** Come `downDependents`, per i CI degradati. */
  degradedDependents: number
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
