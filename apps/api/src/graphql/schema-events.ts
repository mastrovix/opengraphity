/**
 * Event Management — allarmi dai sistemi di monitoraggio.
 *
 * Un `Event` è un allarme normalizzato, identificato da un'impronta
 * (`fingerprint`): lo stesso allarme che si ripete non crea un nuovo nodo,
 * incrementa `count`. Un `CIAlias` è il nome con cui una sorgente chiama un
 * CI (hostname, ip, fqdn, id esterno) e serve ad agganciare l'evento al nodo.
 * La `EventPolicy` è per tenant e governa apertura incident, raggruppamento,
 * chiusura automatica, sfarfallio e conservazione.
 *
 * Progetto: artifact "Event Management OpenGrafo" (9 set 2026).
 * Ondata 1: ricezione, deduplica, salute del CI (`ci.health`, separata dal
 * ciclo di vita `ci.status`), console; apertura manuale `createIncidentFromEvent`.
 * Ondata 3 (services/eventCorrelation.ts): correlazione automatica in incident
 * (`Event.correlation`, `Incident.correlatedEvents`), silenzio nelle finestre
 * di change (`Event.suppressedBy`, `Change.suppressedEvents`), `reevaluateEvent`.
 * Ondata 4: sfarfallio (`Event.flappingSince`, `transitions24h`, esito
 * `flapping`), tempeste di allarmi per sorgente (`EventStats.stormSources`,
 * esiti `storm` / `storm_no_ci`), conservazione (`retentionDays` → job
 * `purge_events`), nuove chiavi della policy.
 *
 * Revisione (ondata 2 — sicurezza e contratto): i vocabolari chiusi sono enum
 * generati da lib/eventVocabularies.ts (fonte unica con i servizi: un valore
 * nuovo nel servizio compare qui, e un valore fuori lista è rifiutato dalla
 * validazione GraphQL prima del resolver; graphql/__tests__/schemaEvents.test.ts
 * confronta enum ↔ liste); `Event.source` è un riferimento leggero
 * (`MonitoringSourceRef`) e la configurazione della sorgente resta admin-only;
 * i ruoli NON sono scritti nei commenti: la verità è lib/authorization.ts,
 * pinnata campo per campo in lib/__tests__/authorization.test.ts.
 */
import { sdlEnum } from '../lib/eventVocabularies.js'

export function eventsSDL(): string {
  return `
  # ── Event Management ────────────────────────────────────────────────────────

  ${sdlEnum('EventStatus')}
  ${sdlEnum('EventSeverity')}
  ${sdlEnum('CIAliasKind')}
  """Stato che una sorgente può dichiarare in un payload (prima della pipeline)."""
  ${sdlEnum('EventInputStatus')}
  """Cosa rappresenta la stringa resource dell'evento."""
  ${sdlEnum('ResourceKind')}
  """Chi ha creato l'alias."""
  ${sdlEnum('CIAliasSource')}
  """Connettori di monitoraggio supportati. (InboundWebhook.connectorKind, nello schema delle integrazioni, è ancora String: da allineare a questo enum.)"""
  ${sdlEnum('ConnectorKind')}
  """Salute del CI vista dal monitoraggio (ci.health), separata dal ciclo di vita ci.status."""
  ${sdlEnum('CIHealth')}
  """Origine della salute: calcolata dagli allarmi o forzata a mano."""
  ${sdlEnum('HealthSource')}
  """Esito dell'ultima valutazione di correlazione (Event.correlation)."""
  ${sdlEnum('EventCorrelation')}
  """Perché l'evento ha (o non ha) il suo CI (Event.matchReason). Esiti del riconoscimento automatico, in ordine di precedenza: alias_external_id, alias, name, name_short (policy matchShortHostname), ambiguous (più CI con lo stesso nome: non agganciato), none. manual = CI scelto da un operatore con linkEventToCI (mai scritto dall'ingest)."""
  ${sdlEnum('EventMatchReason')}
  """Soglia di severità oltre la quale la policy apre un incident (never = mai)."""
  ${sdlEnum('OpenIncidentFrom')}
  """Identità del gruppo di correlazione: il CI o l'impronta dell'allarme."""
  ${sdlEnum('EventGroupBy')}
  """Cronologia dell'allarme: una voce per ogni cambiamento di stato o esito; le ripetizioni non compaiono (vedi count/lastSeenAt)."""
  ${sdlEnum('EventHistoryKind')}

  """Una voce della cronologia dell'allarme (Event.history)."""
  type EventHistoryEntry {
    id:       ID!
    at:       String!
    kind:     EventHistoryKind!
    """Esito di correlazione, solo per kind = correlated (valori di EventCorrelation)."""
    outcome:  EventCorrelation
    """'monitoring' per le azioni automatiche, altrimenti l'id dell'utente."""
    actorId:  String!
    """Utente dell'azione; null per il monitoraggio o un utente non più esistente."""
    actor:    User
    """Incident della voce (correlated, storm, auto_resolved, auto_resolve_skipped, incident_opened_manually); null se assente o eliminato."""
    incident: Incident
    """Change della voce (suppressed, unsuppressed); null se assente o eliminata."""
    change:   Change
    """CI della voce (linked_ci); null se assente o eliminato."""
    ci:       ConfigurationItemRef
    """Severità del payload (first_seen, cycle_firing, cycle_resolved, severity_changed; per severity_changed la precedente è in note)."""
    severity: EventSeverity
    note:     String
  }

  """
  Riferimento leggero a una sorgente di monitoraggio: quanto serve alla console
  per nominarla e filtrare. La configurazione completa (mappature, script di
  trasformazione, ultimo errore) è InboundWebhook (query monitoringSources).
  """
  type MonitoringSourceRef {
    id:            ID!
    name:          String!
    """Null per un webhook creato prima dell'Event Management (trattato come generic)."""
    connectorKind: ConnectorKind
    enabled:       Boolean!
  }

  type Event {
    id:             ID!
    fingerprint:    String!
    """Identificativo dell'ALLARME presso la sorgente (fingerprint Alertmanager, event_id Zabbix, ciclo Datadog, PID Dynatrace)."""
    externalId:     String
    """Identificativo della RISORSA (il CI) presso la sorgente: entity di Dynatrace, host_id di Zabbix, field resourceExternalId del generic. È quello confrontato con un alias external_id del CI."""
    resourceExternalId: String
    status:         EventStatus!
    """Severità dell'ULTIMO payload ricevuto: la salute del CI segue questa."""
    severity:       EventSeverity!
    """Severità più alta vista nel ciclo corrente (riparte a ogni resolved → firing). Null solo sugli eventi scritti prima di questo campo."""
    maxSeverity:    EventSeverity
    title:          String!
    description:    String
    """Stringa grezza con cui la sorgente identifica l'oggetto (host, ip, ...)."""
    resource:       String!
    resourceKind:   ResourceKind!
    """Etichette della sorgente, JSON serializzato (sempre presente: l'ingest scrive almeno {}). Un evento di prova (sendSampleEvent) porta sample = "true"."""
    labels:         String!
    count:          Int!
    firstSeenAt:    String!
    lastSeenAt:     String!
    resolvedAt:     String
    acknowledgedBy: User
    acknowledgedAt: String
    """Sorgente (webhook in ingresso con entityType = event), come riferimento leggero."""
    source:         MonitoringSourceRef
    """CI riconosciuto. Null = evento orfano."""
    ci:             ConfigurationItemRef
    """Come è stato riconosciuto (o perché no) il CI all'ultimo ingest: ambiguous = più CI con lo stesso nome, l'evento resta orfano finché non viene collegato a mano; manual = collegato da un operatore (linkEventToCI). Null sugli eventi scritti prima del campo."""
    matchReason:    EventMatchReason
    """Incident a cui l'evento è correlato, se esiste."""
    incident:       Incident
    """Change la cui finestra ha silenziato l'evento (status = suppressed)."""
    suppressedBy:   Change
    """Esito dell'ultima valutazione di correlazione."""
    correlation:    EventCorrelation!
    correlationAt:  String
    """Da quando l'evento sfarfalla (status = flapping); null altrimenti."""
    flappingSince:  String
    """Numero di passaggi firing↔resolved nelle ultime 24 ore."""
    transitions24h: Int!
    """Ultime limit voci (max 200), dalla più recente. La voce first_seen è sempre presente (sintetizzata da firstSeenAt per gli allarmi precedenti alla cronologia: id "<eventId>:first_seen", senza severità)."""
    history(limit: Int = 100): [EventHistoryEntry!]!
    """Numero totale di voci (la first_seen sintetizzata inclusa), indipendente da limit."""
    historyCount:   Int!
  }

  extend type Incident {
    """
    Allarmi di monitoraggio correlati a questo incident, dal più recente.
    Paginati (un incident di tempesta ne aggrega migliaia): limit ≤ 500
    (default 100), offset ≥ 0; il totale è correlatedEventCount.
    """
    correlatedEvents(limit: Int = 100, offset: Int = 0): [Event!]!
    """Numero totale di allarmi correlati, indipendente dalla pagina."""
    correlatedEventCount: Int!
    """Allarmi correlati eliminati dal job di conservazione (purge_events) dopo la chiusura dell'incident: la sezione allarmi può dire "N allarmi eliminati per conservazione" invece di svuotarsi. 0 se nessuno."""
    correlatedEventsPurged: Int!
  }

  extend type Change {
    """Eventi silenziati dalla finestra di questa change (anche storici), dal più recente. Paginati come Incident.correlatedEvents: limit ≤ 500 (default 100), offset ≥ 0; il totale è suppressedEventCount."""
    suppressedEvents(limit: Int = 100, offset: Int = 0): [Event!]!
    """Numero totale di eventi silenziati da questa change, indipendente dalla pagina."""
    suppressedEventCount: Int!
    """Eventi silenziati eliminati dal job di conservazione dopo la chiusura della change. 0 se nessuno."""
    suppressedEventsPurged: Int!
  }

  """Riferimento leggero a un CI, senza dipendere dal tipo dinamico."""
  type ConfigurationItemRef {
    id:     ID!
    name:   String!
    type:   String!
    """Ciclo di vita del CI (active, inactive, maintenance, decommissioned). Il monitoraggio non lo tocca."""
    status: String
    """Salute derivata dal monitoraggio. Null finché nessun evento ha riguardato il CI."""
    health: CIHealth
  }

  type CIAlias {
    id:        ID!
    kind:      CIAliasKind!
    value:     String!
    source:    CIAliasSource!
    createdAt: String!
    ci:        ConfigurationItemRef!
  }

  """Una sorgente di monitoraggio in tempesta di allarmi (InboundWebhook.storm_since valorizzato)."""
  type StormSource {
    sourceId:       ID!
    sourceName:     String!
    """Eventi nuovi al minuto (massimo fra il minuto corrente e il precedente, contatore Redis)."""
    ratePerMinute:  Int!
    since:          String!
    """Incident di tempesta a cui si agganciano gli eventi; null se nessun evento della tempesta aveva un CI."""
    incidentId:     ID
    incidentNumber: String
  }

  type EventStats {
    firing:     Int!
    critical:   Int!
    warning:    Int!
    orphan:     Int!
    suppressed: Int!
    flapping:   Int!
    resolved24h: Int!
    """Tempeste in corso."""
    stormSources: [StormSource!]!
  }

  type EventPolicy {
    """Contatore di modifica (parte da 1, +1 a ogni updateEventPolicy): da passare come expectedVersion per non sovrascrivere la modifica di un altro amministratore."""
    version:              Int!
    """Istante dell'ultimo updateEventPolicy; null = mai modificata dopo il bootstrap."""
    updatedAt:            String
    openIncidentFrom:     OpenIncidentFrom!
    groupBy:              EventGroupBy!
    openDelaySeconds:     Int!
    autoResolve:          Boolean!
    suppressUpstreamHops: Int!
    flapThreshold:        Int!
    flapWindowMinutes:    Int!
    """Minuti senza passaggi dopo i quali un evento flapping torna allo stato dell'ultimo payload."""
    flapStableMinutes:    Int!
    """Eventi nuovi al minuto dalla stessa sorgente oltre i quali la sorgente entra in tempesta (0 = spento)."""
    stormThresholdPerMinute: Int!
    """Minuti consecutivi sotto soglia dopo i quali la tempesta finisce."""
    stormCooldownMinutes: Int!
    """Giorni dopo la risoluzione oltre i quali gli eventi risolti vengono eliminati (0 = mai)."""
    retentionDays:        Int!
    """Riconoscimento del CI per nome: se la risorsa è un FQDN (db-01.example.local) prova anche il nome corto (db-01), e viceversa. Spento per default."""
    matchShortHostname:   Boolean!
    """Stati del ciclo di vita del CI (ci.status) per cui un allarme non apre incident e non cambia la salute: esito skipped_lifecycle, l'allarme resta in console con il suo motivo. Default: decommissioned."""
    ignoreLifecycleStatuses: [String!]!
    """Stati del ciclo di vita che contano come «ritirato»: un CI così non pesa nel calcolo della salute dei servizi (excludedReason lifecycle_decommissioned). Valori iniziali: inactive, decommissioned."""
    retiredStatuses:      [String!]!
    """Stati del ciclo di vita che contano come «in manutenzione»: il monitoraggio non ne aggiorna la salute e il componente esce dal calcolo (excludedReason lifecycle_maintenance). Valore iniziale: maintenance."""
    maintenanceStatuses:  [String!]!
    """Mappa severità → impatto/urgenza, JSON serializzato."""
    severityMap:          String!
  }

  input EventFilter {
    status:    [EventStatus!]
    severity:  [EventSeverity!]
    ciId:      ID
    sourceId:  ID
    orphan:    Boolean
    """
    Ricerca su titolo e risorsa tramite l'indice full-text event_search: ogni
    parola (run di lettere/cifre) deve comparire come sottostringa di un token
    ("example" e "local" trovano api-03.example.local), senza distinzione di
    maiuscole. Un testo senza lettere né cifre non trova nulla.
    """
    search:    String
    """Solo eventi visti da questo istante (data ISO 8601; una data parsabile in altro formato viene normalizzata a ISO prima del confronto)."""
    since:     String
    """Eventi correlati (CORRELATED_INTO) a questo incident."""
    incidentId: ID
    """Eventi silenziati (SUPPRESSED_BY) dalla finestra di questa change."""
    suppressedByChangeId: ID
  }

  """Tutti i campi opzionali: quelli assenti restano invariati. Massimi per campo e regole di coerenza (sfarfallio/tempesta) sono validati con messaggi che citano campo e limite."""
  input EventPolicyInput {
    """Versione letta dal client: se la policy è cambiata nel frattempo il salvataggio è rifiutato (BAD_USER_INPUT), così due amministratori non si sovrascrivono."""
    expectedVersion:      Int
    openIncidentFrom:     OpenIncidentFrom
    groupBy:              EventGroupBy
    openDelaySeconds:     Int
    autoResolve:          Boolean
    suppressUpstreamHops: Int
    flapThreshold:        Int
    flapWindowMinutes:    Int
    flapStableMinutes:    Int
    stormThresholdPerMinute: Int
    stormCooldownMinutes: Int
    retentionDays:        Int
    matchShortHostname:   Boolean
    """Lista completa (non un delta): sostituisce quella attuale; [] = nessuno stato ignorato. Valori ammessi: gli stati del vocabolario ci_status di questo cliente."""
    ignoreLifecycleStatuses: [String!]
    """Lista completa: gli stati che contano come «ritirato». Valori ammessi: gli stati del vocabolario ci_status di questo cliente."""
    retiredStatuses:      [String!]
    """Lista completa: gli stati che contano come «in manutenzione». Valori ammessi: gli stati del vocabolario ci_status di questo cliente."""
    maintenanceStatuses:  [String!]
    severityMap:          String
  }

  type EventPage {
    items:  [Event!]!
    total:  Int!
  }

  # ── Ondata 2: configurazione senza codice ──────────────────────────────────

  """Anteprima della normalizzazione: cosa diventerebbe un payload, senza ingerirlo."""
  type NormalizedEventPreview {
    externalId:   String
    """Identificativo della risorsa presso la sorgente (alias external_id del CI), se il connettore lo porta."""
    resourceExternalId: String
    status:       EventInputStatus!
    severity:     EventSeverity!
    title:        String!
    description:  String
    resource:     String!
    resourceKind: ResourceKind!
    """Etichette estratte, JSON serializzato."""
    labels:       String!
  }

  input InboundEventPreviewInput {
    connectorKind: ConnectorKind!
    """Payload JSON così come lo manderebbe lo strumento (al massimo 256 kB e 32 livelli di annidamento)."""
    payload:       String!
    """Solo per il connettore generic: mappatura campo normalizzato → percorso puntato nel payload (es. labels.instance), JSON."""
    fieldMapping:  String
    """JSON. Generic: valore predefinito di ogni campo normalizzato. Connettori preset: severity, resource + resourceKind (risorsa usata quando il payload non ne porta una), resourceFrom (Datadog: alert_scope)."""
    defaultValues: String
    """Per ogni connettore: JSON { severity: { valoreSorgente: info|warning|critical }, status: { valoreSorgente: firing|resolved } }; nei preset traduce i valori dello strumento prima della tabella incorporata."""
    valueMapping:  String
  }

  """Una chiave trovata in un payload di esempio, con percorso puntato e valore, per il mappatore visuale."""
  type PayloadKey {
    path:   String!
    sample: String!
  }

  """Salute di un CI vista dal monitoraggio, per il dettaglio CI e la topologia."""
  type CIHealthInfo {
    ciId:         ID!
    health:       CIHealth
    healthSource: HealthSource
    lastEventAt:  String
    firingEvents: Int!
  }

  # ── Pagina "Salute CI" ─────────────────────────────────────────────────────

  """Una riga della pagina Salute CI: un CI con dati di salute, il suo impatto e chi lo possiede."""
  type CIHealthRow {
    id:           ID!
    name:         String!
    type:         String!
    environment:  String
    health:       CIHealth!
    healthSource: HealthSource
    """Da quando la salute attuale è in vigore (ci.health_since)."""
    healthSince:  String
    lastEventAt:  String
    firingEvents: Int!
    """CI che dipendono direttamente da questo (DEPENDS_ON entranti): l'impatto."""
    dependents:   Int!
    """Servizi monitorati che dipendono dal CI: quante mappe attive lo includono (0 se nessuna)."""
    servicesCount: Int!
    ownerTeam:    String
  }

  """Contatori su tutto il tenant (indipendenti dal filtro) + righe filtrate e paginate."""
  type CIHealthOverview {
    down:        Int!
    degraded:    Int!
    operational: Int!
    """CI del tenant senza alcun dato di salute."""
    unmonitored: Int!
    """Somma dei CI che dipendono direttamente (DEPENDS_ON) dai CI giù di tutto il tenant: l'impatto complessivo, indipendente da filtro e pagina."""
    downDependents:     Int!
    """Come downDependents, per i CI degradati."""
    degradedDependents: Int!
    items:       [CIHealthRow!]!
    total:       Int!
  }

  input CIHealthFilter {
    health:      [CIHealth!]
    """Nome del tipo CI del metamodello (server, database, …)."""
    type:        String
    environment: String
    """Id del team proprietario (OWNED_BY)."""
    team:        String
    """Ricerca per nome, senza distinzione di maiuscole."""
    search:      String
  }

  extend type Query {
    """Console degli allarmi, dal più recente: limit ≤ 500 (default 50). Pagina e totale in una sola query; source, incident, ci e acknowledgedBy sono risolti con la riga."""
    events(filter: EventFilter, limit: Int, offset: Int): EventPage!
    event(id: ID!): Event
    eventStats: EventStats!
    ciAliases(ciId: ID!): [CIAlias!]!
    eventPolicy: EventPolicy!
    """Payload di esempio realistico per il connettore: alimenta anteprime e prove (strumento del wizard delle sorgenti)."""
    sampleInboundPayload(connectorKind: ConnectorKind!): String!
    """Chiavi con percorso puntato di un payload JSON incollato dall'amministratore (generic). Payload al massimo 256 kB e 32 livelli."""
    payloadKeys(payload: String!): [PayloadKey!]!
    """Le sorgenti di monitoraggio con la configurazione completa: webhook in ingresso con entityType = event (pagina Sorgenti)."""
    monitoringSources: [InboundWebhook!]!
    """Una sola sorgente con la configurazione completa (pagina di modifica): null se non esiste nel tenant. Prima si leggevano tutte per aprirne una."""
    monitoringSource(id: ID!): InboundWebhook
    """Le sorgenti di monitoraggio come riferimenti leggeri (id, nome, connettore, attiva): per il filtro della console e il banner "nessuna sorgente"."""
    monitoringSourceRefs: [MonitoringSourceRef!]!
    ciHealth(ciId: ID!): CIHealthInfo!
    """Pagina Salute CI: i CI con salute, dal più grave e dal più impattante, con i contatori del tenant. limit ≤ 500 (default 100)."""
    ciHealthOverview(filter: CIHealthFilter, limit: Int, offset: Int): CIHealthOverview!
  }

  extend type Mutation {
    """
    Normalizza un payload senza ingerirlo: anteprima per il mappatore. Non scrive
    nulla, ma è una Mutation di proposito: è un'operazione di lavoro del wizard
    (parsing + normalizzazione sul thread principale) invocata a ogni modifica
    del mapping, e sta con le operazioni "esegui" e non nel piano delle letture
    cacheabili/polling delle Query. I ruoli sono quelli delle altre operazioni
    del wizard (lib/authorization.ts).
    """
    previewInboundEvents(input: InboundEventPreviewInput!): [NormalizedEventPreview!]!
    """
    Ingerisce il payload di esempio del connettore attraverso la pipeline REALE:
    l'evento di prova compare in console con sample = "true" nei suoi labels.
    Attraversa riconoscimento del CI, salute e correlazione come un allarme
    vero: se esiste un CI con il nome della risorsa del campione può aggiornarne
    la salute e aprire un incident. Non azzera lastError della sorgente (è la
    diagnosi dell'ultimo payload reale rifiutato). Restituisce il numero di
    eventi accodati.
    """
    sendSampleEvent(sourceId: ID!): Int!
    """Forza la salute a mano (health_source = manual); null toglie la forzatura e ricalcola dal monitoraggio."""
    setCIHealthOverride(ciId: ID!, health: CIHealth): CIHealthInfo!
    """Presa in carico. Rifiutata (BAD_USER_INPUT) su un evento risolto o già preso in carico da un altro utente; ripetuta dallo stesso utente aggiorna l'istante."""
    acknowledgeEvent(id: ID!): Event!
    """Risoluzione manuale di un evento firing, suppressed o flapping: l'evento resta, i residui di soppressione/sfarfallio vengono azzerati, la salute del CI viene ricalcolata. Un evento già risolto → BAD_USER_INPUT (non NOT_FOUND)."""
    resolveEvent(id: ID!, note: String): Event!
    """
    Collega un evento orfano a un CI; con createAlias = true la sorgente verrà
    riconosciuta da sola la prossima volta. Se l'alias esiste già e punta a un
    altro CI → BAD_USER_INPUT con il CI attuale (stessa regola di createCIAlias):
    un alias non viene mai ri-puntato in silenzio. Scrive matchReason = manual:
    l'evento dichiara che il CI è stato scelto da un operatore.
    """
    linkEventToCI(eventId: ID!, ciId: ID!, createAlias: Boolean): Event!
    """Apre a mano un incident dall'evento (solo status firing, non ancora correlato). Serializzata con la correlazione automatica sullo stesso gruppo: due richieste ravvicinate non aprono due incident."""
    createIncidentFromEvent(eventId: ID!): Incident!
    """Rivaluta ora un evento silenziato o in attesa: utile a fine finestra o dopo aver collegato un CI."""
    reevaluateEvent(id: ID!): Event!
    createCIAlias(ciId: ID!, kind: CIAliasKind!, value: String!): CIAlias!
    deleteCIAlias(id: ID!): Boolean!
    updateEventPolicy(input: EventPolicyInput!): EventPolicy!
  }
  `
}
