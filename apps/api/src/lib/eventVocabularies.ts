/**
 * Vocabolari chiusi dell'Event Management: UNA sola definizione per ciascuno.
 *
 * Da qui li leggono sia lo schema GraphQL (schema-events.ts genera gli `enum`
 * SDL da queste liste) sia i servizi (eventService.ts, eventCorrelation.ts,
 * eventPolicy.ts li importano e li ri-esportano per i loro chiamanti). Prima
 * della revisione (C-1) le stesse liste erano dichiarate in tre-quattro punti e
 * l'SDL le descriveva come `String` con un commento: un valore nuovo aggiunto
 * al servizio non rompeva nulla e il web doveva conoscerli a memoria.
 *
 * Il modulo è puro (nessun import): lo schema lo carica anche nei test che non
 * toccano Neo4j/Redis. Il test graphql/__tests__/schemaEvents.test.ts verifica
 * che ogni enum SDL coincida con la lista qui definita.
 */

/** Stato dell'evento nel grafo (`Event.status`). */
export const EVENT_STATUSES = ['firing', 'resolved', 'suppressed', 'flapping'] as const
export type EventStatus = (typeof EVENT_STATUSES)[number]

/** Stato che una sorgente può dichiarare in ingresso (payload normalizzato). */
export const EVENT_INPUT_STATUSES = ['firing', 'resolved'] as const
export type EventInputStatus = (typeof EVENT_INPUT_STATUSES)[number]

export const EVENT_SEVERITIES = ['info', 'warning', 'critical'] as const
export type EventSeverity = (typeof EVENT_SEVERITIES)[number]

/** Cosa rappresenta la stringa `resource` dell'evento. */
export const RESOURCE_KINDS = ['hostname', 'ip', 'fqdn', 'external_id', 'name'] as const
export type ResourceKind = (typeof RESOURCE_KINDS)[number]

/** Tipi di alias con cui una sorgente chiama un CI (`name` non è un alias: è il nome del CI). */
export const CI_ALIAS_KINDS = ['hostname', 'ip', 'fqdn', 'external_id'] as const
export type CIAliasKind = (typeof CI_ALIAS_KINDS)[number]

/** Chi ha creato l'alias: a mano (console/API) o la discovery. */
export const CI_ALIAS_SOURCES = ['manual', 'discovery'] as const
export type CIAliasSource = (typeof CI_ALIAS_SOURCES)[number]

/** Connettori di monitoraggio supportati (`InboundWebhook.connector_kind` con entity_type = event). */
export const CONNECTOR_KINDS = ['generic', 'alertmanager', 'grafana', 'zabbix', 'datadog', 'dynatrace'] as const
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number]

/** Salute del CI derivata dal monitoraggio (`ci.health`), separata dal ciclo di vita `ci.status`. */
export const CI_HEALTHS = ['operational', 'degraded', 'down'] as const
export type CIHealth = (typeof CI_HEALTHS)[number]

/**
 * Ciclo di vita del CI (`ci.status`): il vocabolario `ci_status` del
 * metamodello (lib/seedEnumTypes.ts lo semina da qui). Niente a che vedere con
 * la salute: il monitoraggio non lo scrive mai, lo legge soltanto — la policy
 * `ignore_lifecycle_statuses` (revisione 2 · D6.3) sceglie fra questi valori
 * quelli per cui un allarme non apre incident e non cambia la salute.
 */
/**
 * `expired` e `revoked` sono i cicli di vita dei certificati: erano già sui CI
 * (dal vivo su c-one: 49 e 19) e NON stavano in nessun vocabolario, quindi non
 * si potevano scegliere nella policy né nell'editor del CI (C-4, parte già
 * attiva — B0-4). Aggiungerli allinea il vocabolario al dato; la SEMANTICA
 * (quali stati contano come ritirati o in manutenzione) non cambia e resta in
 * CI_LIFECYCLE_RETIRED / CI_LIFECYCLE_MAINTENANCE.
 */
export const CI_LIFECYCLE_STATUSES = ['active', 'inactive', 'maintenance', 'decommissioned', 'expired', 'revoked'] as const
export type CILifecycleStatus = (typeof CI_LIFECYCLE_STATUSES)[number]

/** Ciclo di vita del CI «fuori servizio»: il default di `ignore_lifecycle_statuses` e i componenti che non contano in una mappa di servizio (D6.3). */
export const CI_LIFECYCLE_DECOMMISSIONED: CILifecycleStatus = 'decommissioned'
export const CI_LIFECYCLE_INACTIVE: CILifecycleStatus = 'inactive'

/** Origine della salute: calcolata dagli allarmi o forzata a mano (`ci.health_source`). */
export const HEALTH_SOURCES = ['monitoring', 'manual'] as const
export type HealthSource = (typeof HEALTH_SOURCES)[number]

/**
 * Esito dell'ultima valutazione di correlazione (`Event.correlation`), scritto
 * dalla pipeline di services/eventCorrelation.ts. `auto_resolved` e
 * `auto_resolve_skipped` sono esiti della PIPELINE (PipelineOutcome) ma non
 * vengono mai scritti su `correlation`: per questo non stanno qui.
 * `skipped_lifecycle` (revisione 2 · D6.3): il CI dell'allarme ha un ciclo di
 * vita fra quelli ignorati dalla policy (`ignore_lifecycle_statuses`, di
 * norma `decommissioned`) — nessun incident, nessun ricalcolo della salute,
 * l'allarme resta in console con il suo motivo.
 */
export const CORRELATION_OUTCOMES = ['opened', 'attached', 'reopened', 'skipped_orphan', 'skipped_severity', 'skipped_lifecycle', 'delayed', 'pending', 'suppressed', 'flapping', 'storm', 'storm_no_ci', 'none'] as const
export type CorrelationOutcome = (typeof CORRELATION_OUTCOMES)[number]

/**
 * Esito dell'ultimo riconoscimento automatico del CI (`Event.match_reason`,
 * scritto dal MERGE dell'ingest: services/events/transitions.ts#ciMatchCypher),
 * nell'ordine di precedenza: `alias_external_id` (alias external_id del CI =
 * id della risorsa presso la sorgente), `alias` (alias del tipo della risorsa:
 * hostname/ip/fqdn), `name` (name_key = risorsa), `name_short` (policy
 * `match_short_hostname`: prima etichetta del FQDN, o FQDN che inizia con il
 * nome corto), `ambiguous` (più CI con lo stesso nome: NON agganciato, orfano
 * con i candidati), `none` (nessun CI: orfano), `manual` (collegato a mano
 * da un operatore con `linkEventToCI`: non è un esito del riconoscimento e
 * l'ingest non lo produce mai, ma dice al lettore PERCHÉ l'evento ha quel
 * CI). Null sugli eventi scritti prima del campo o mai riconosciuti.
 */
export const MATCH_REASONS = ['alias_external_id', 'alias', 'name', 'name_short', 'ambiguous', 'none', 'manual'] as const
export type CIMatchReason = (typeof MATCH_REASONS)[number]

/** Soglia di severità oltre la quale la policy apre un incident (`never` = mai). */
export const OPEN_INCIDENT_FROM = ['info', 'warning', 'critical', 'never'] as const
export type OpenIncidentFrom = (typeof OPEN_INCIDENT_FROM)[number]

/** Identità del gruppo di correlazione: il CI o l'impronta dell'allarme. */
export const EVENT_GROUP_BY = ['ci', 'fingerprint'] as const
export type EventGroupBy = (typeof EVENT_GROUP_BY)[number]

/**
 * Tipi di voce della cronologia dell'allarme (`EventHistoryEntry.kind`,
 * scritte da services/events/history.ts e dai punti di scrittura dello stato):
 * `first_seen` (creazione dell'Event), `cycle_firing`/`cycle_resolved`
 * (passaggi resolved → firing / → resolved dal payload), `severity_changed`
 * (severità del payload cambiata nello stesso ciclo), `correlated` (esito di
 * correlazione cambiato, con `outcome`), `suppressed`/`unsuppressed` (finestra
 * di change), `flapping`/`stable` (sfarfallio), `storm` (aggancio nuovo
 * all'incident di tempesta), `auto_resolved`/`auto_resolve_skipped` (chiusura
 * automatica), e le azioni manuali `acknowledged`, `resolved_manually`,
 * `linked_ci`, `incident_opened_manually`, `reevaluated` (actor_id = utente).
 * Le ripetizioni di un payload con lo stesso stato non scrivono nulla.
 */
export const EVENT_HISTORY_KINDS = [
  'first_seen', 'cycle_firing', 'cycle_resolved', 'severity_changed', 'correlated', 'suppressed', 'unsuppressed',
  'flapping', 'stable', 'storm', 'auto_resolved', 'auto_resolve_skipped',
  'acknowledged', 'resolved_manually', 'linked_ci', 'incident_opened_manually', 'reevaluated',
] as const
export type EventHistoryKind = (typeof EVENT_HISTORY_KINDS)[number]

/** Nome enum SDL → lista TS: è la tabella che schema-events.ts usa per generare gli enum e che il test confronta con lo schema. */
export const EVENT_SDL_ENUMS: Readonly<Record<string, readonly string[]>> = {
  EventStatus:      EVENT_STATUSES,
  EventInputStatus: EVENT_INPUT_STATUSES,
  EventSeverity:    EVENT_SEVERITIES,
  ResourceKind:     RESOURCE_KINDS,
  CIAliasKind:      CI_ALIAS_KINDS,
  CIAliasSource:    CI_ALIAS_SOURCES,
  ConnectorKind:    CONNECTOR_KINDS,
  CIHealth:         CI_HEALTHS,
  HealthSource:     HEALTH_SOURCES,
  EventCorrelation: CORRELATION_OUTCOMES,
  EventMatchReason: MATCH_REASONS,
  OpenIncidentFrom: OPEN_INCIDENT_FROM,
  EventGroupBy:     EVENT_GROUP_BY,
  EventHistoryKind: EVENT_HISTORY_KINDS,
}

/** `enum Nome { a b c }` per l'SDL. */
export function sdlEnum(name: keyof typeof EVENT_SDL_ENUMS): string {
  return `enum ${name} { ${EVENT_SDL_ENUMS[name]!.join(' ')} }`
}
