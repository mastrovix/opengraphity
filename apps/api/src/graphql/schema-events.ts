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
 */
export function eventsSDL(): string {
  return `
  # ── Event Management ────────────────────────────────────────────────────────

  enum EventStatus   { firing resolved suppressed flapping }
  enum EventSeverity { info warning critical }
  enum CIAliasKind   { hostname ip fqdn external_id }

  type Event {
    id:             ID!
    fingerprint:    String!
    externalId:     String
    status:         EventStatus!
    severity:       EventSeverity!
    title:          String!
    description:    String
    """Stringa grezza con cui la sorgente identifica l'oggetto (host, ip, ...)."""
    resource:       String!
    resourceKind:   String!
    """Etichette della sorgente, JSON serializzato."""
    labels:         String
    count:          Int!
    firstSeenAt:    String!
    lastSeenAt:     String!
    resolvedAt:     String
    acknowledgedBy: User
    acknowledgedAt: String
    """Sorgente (webhook in ingresso con entityType = event)."""
    source:         InboundWebhook
    """CI riconosciuto. Null = evento orfano."""
    ci:             ConfigurationItemRef
    """Incident a cui l'evento è correlato, se esiste."""
    incident:       Incident
    """Change la cui finestra ha silenziato l'evento (status = suppressed)."""
    suppressedBy:   Change
    """Esito dell'ultima valutazione di correlazione: opened | attached | reopened | skipped_orphan | skipped_severity | delayed | suppressed | none."""
    correlation:    String!
    correlationAt:  String
  }

  extend type Incident {
    """Allarmi di monitoraggio correlati a questo incident."""
    correlatedEvents: [Event!]!
  }

  extend type Change {
    """Eventi silenziati dalla finestra di questa change."""
    suppressedEvents: [Event!]!
  }

  """Riferimento leggero a un CI, senza dipendere dal tipo dinamico."""
  type ConfigurationItemRef {
    id:     ID!
    name:   String!
    type:   String!
    """Ciclo di vita del CI (active, inactive, maintenance, decommissioned). Il monitoraggio non lo tocca."""
    status: String
    """Salute derivata dal monitoraggio: operational, degraded, down. Null finché nessun evento ha riguardato il CI."""
    health: String
  }

  type CIAlias {
    id:        ID!
    kind:      CIAliasKind!
    value:     String!
    source:    String!
    createdAt: String!
    ci:        ConfigurationItemRef!
  }

  type EventStats {
    firing:     Int!
    critical:   Int!
    warning:    Int!
    orphan:     Int!
    suppressed: Int!
    flapping:   Int!
    resolved24h: Int!
  }

  type EventPolicy {
    openIncidentFrom:     String!
    groupBy:              String!
    openDelaySeconds:     Int!
    autoResolve:          Boolean!
    suppressUpstreamHops: Int!
    flapThreshold:        Int!
    flapWindowMinutes:    Int!
    retentionDays:        Int!
    """Mappa severità → impatto/urgenza, JSON serializzato."""
    severityMap:          String!
  }

  input EventFilter {
    status:    [EventStatus!]
    severity:  [EventSeverity!]
    ciId:      ID
    sourceId:  ID
    orphan:    Boolean
    search:    String
    since:     String
    """Eventi correlati (CORRELATED_INTO) a questo incident."""
    incidentId: ID
    """Eventi silenziati (SUPPRESSED_BY) dalla finestra di questa change."""
    suppressedByChangeId: ID
  }

  input EventPolicyInput {
    openIncidentFrom:     String
    groupBy:              String
    openDelaySeconds:     Int
    autoResolve:          Boolean
    suppressUpstreamHops: Int
    flapThreshold:        Int
    flapWindowMinutes:    Int
    retentionDays:        Int
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
    status:       String!
    severity:     String!
    title:        String!
    description:  String
    resource:     String!
    resourceKind: String!
    """Etichette estratte, JSON serializzato."""
    labels:       String!
  }

  input InboundEventPreviewInput {
    connectorKind: String!
    """Payload JSON così come lo manderebbe lo strumento."""
    payload:       String!
    """Solo per il connettore generic: mappatura campo normalizzato → percorso puntato nel payload (es. labels.instance), JSON."""
    fieldMapping:  String
    defaultValues: String
    """Solo per generic: JSON { severity: { valoreSorgente: info|warning|critical }, status: { valoreSorgente: firing|resolved } }."""
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
    health:       String
    healthSource: String
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
    """operational | degraded | down"""
    health:       String!
    healthSource: String
    """Da quando la salute attuale è in vigore (ci.health_since)."""
    healthSince:  String
    lastEventAt:  String
    firingEvents: Int!
    """CI che dipendono direttamente da questo (DEPENDS_ON entranti): l'impatto."""
    dependents:   Int!
    ownerTeam:    String
  }

  """Contatori su tutto il tenant (indipendenti dal filtro) + righe filtrate e paginate."""
  type CIHealthOverview {
    down:        Int!
    degraded:    Int!
    operational: Int!
    """CI del tenant senza alcun dato di salute."""
    unmonitored: Int!
    items:       [CIHealthRow!]!
    total:       Int!
  }

  input CIHealthFilter {
    """Sottoinsieme di operational | degraded | down."""
    health:      [String!]
    """Nome del tipo CI del metamodello (server, database, …)."""
    type:        String
    environment: String
    """Id del team proprietario (OWNED_BY)."""
    team:        String
    """Ricerca per nome, senza distinzione di maiuscole."""
    search:      String
  }

  extend type Query {
    events(filter: EventFilter, limit: Int, offset: Int): EventPage!
    event(id: ID!): Event
    eventStats: EventStats!
    ciAliases(ciId: ID!): [CIAlias!]!
    eventPolicy: EventPolicy!
    """Payload di esempio realistico per il connettore: alimenta anteprime e prove."""
    sampleInboundPayload(connectorKind: String!): String!
    """Chiavi con percorso puntato di un payload JSON incollato dall'amministratore (generic)."""
    payloadKeys(payload: String!): [PayloadKey!]!
    """Le sorgenti di monitoraggio: webhook in ingresso con entityType = event."""
    monitoringSources: [InboundWebhook!]!
    ciHealth(ciId: ID!): CIHealthInfo!
    """Pagina Salute CI: i CI con salute, dal più grave e dal più impattante, con i contatori del tenant. limit ≤ 500 (default 100)."""
    ciHealthOverview(filter: CIHealthFilter, limit: Int, offset: Int): CIHealthOverview!
  }

  extend type Mutation {
    """Normalizza un payload senza ingerirlo: anteprima per il mappatore."""
    previewInboundEvents(input: InboundEventPreviewInput!): [NormalizedEventPreview!]!
    """Ingerisce il payload di esempio del connettore attraverso la pipeline reale: l'evento di prova compare in console. Restituisce il numero di eventi accodati."""
    sendSampleEvent(sourceId: ID!): Int!
    """Forza la salute a mano (health_source = manual); null toglie la forzatura e ricalcola dal monitoraggio."""
    setCIHealthOverride(ciId: ID!, health: String): CIHealthInfo!
    acknowledgeEvent(id: ID!): Event!
    """Risoluzione manuale: l'evento resta, la salute del CI viene ricalcolata."""
    resolveEvent(id: ID!, note: String): Event!
    """Collega un evento orfano a un CI; con createAlias = true la sorgente verrà riconosciuta da sola la prossima volta."""
    linkEventToCI(eventId: ID!, ciId: ID!, createAlias: Boolean): Event!
    createIncidentFromEvent(eventId: ID!): Incident!
    """Rivaluta ora un evento silenziato o in attesa (admin/operator): utile a fine finestra o dopo aver collegato un CI."""
    reevaluateEvent(id: ID!): Event!
    createCIAlias(ciId: ID!, kind: CIAliasKind!, value: String!): CIAlias!
    deleteCIAlias(id: ID!): Boolean!
    updateEventPolicy(input: EventPolicyInput!): EventPolicy!
  }
  `
}
