export function reportSDL(): string {
  return `
  # ── Custom Report Templates ────────────────────────────────────────────────

  type ReportTemplate {
    id: ID!
    name: String!
    description: String
    icon: String
    visibility: String!
    createdBy: User
    sharedWith: [Team!]!
    sections: [ReportSection!]!
    scheduleEnabled: Boolean!
    scheduleCron: String
    scheduleChannelId: String
    scheduleRecipients: [String!]!
    scheduleFormat: String
    lastScheduledRun: String
    createdAt: String!
    updatedAt: String
  }

  type ReportNode {
    id: ID!
    entityType: String!
    neo4jLabel: String!
    label: String!
    isResult: Boolean!
    isRoot: Boolean!
    positionX: Float!
    positionY: Float!
    filters: String
    selectedFields: [String!]!
  }

  type ReportEdge {
    id: ID!
    sourceNodeId: ID!
    targetNodeId: ID!
    relationshipType: String!
    direction: String!
    label: String!
  }

  type ReportSection {
    id: ID!
    order: Int!
    title: String!
    chartType: String!
    groupByNodeId: String
    groupByField: String
    """Come si raggruppa una data in una serie: day (difetto), week, month."""
    groupByGranularity: String
    metric: String!
    metricField: String
    limit: Int
    sortDir: String
    nodes: [ReportNode!]!
    edges: [ReportEdge!]!
  }

  type NavigableEntity {
    entityType: String!
    label: String!
    """
    Chiave i18n quando l'etichetta è del PRODOTTO (revisione totale · C-18):
    il web la traduce, con «label» come ripiego. Assente per i tipi e i campi
    creati dal cliente, la cui etichetta è già la sua.
    """
    labelKey: String
    neo4jLabel: String!
    # itsm | organization | cmdb: dove il costruttore la mostra
    group: String!
    fields: [NavigableField!]!
    relations: [NavigableRelation!]!
  }

  type NavigableField {
    name: String!
    label: String!
    labelKey: String
    fieldType: String!
    enumValues: [String!]!
    enumTypeName: String
  }

  type NavigableRelation {
    relationshipType: String!
    direction: String!
    label: String!
    labelKey: String
    targetEntityType: String!
    targetLabel: String!
    targetLabelKey: String
    targetNeo4jLabel: String!
  }

  type ReachableEntity {
    entityType: String!
    label: String!
    labelKey: String
    neo4jLabel: String!
    relationshipType: String!
    direction: String!
    count: Int!
    fields: [NavigableField!]!
  }

  type ReportResult {
    sections: [ReportSectionResult!]!
  }

  type ReportSectionResult {
    sectionId: ID!
    title: String!
    chartType: String!
    data: String!
    total: Int
    error: String
  }

  # ── AI Report Conversations ────────────────────────────────────────────────

  type ReportConversation {
    id:        ID!
    title:     String!
    createdAt: String!
    updatedAt: String!
    messages:  [ReportMessage!]!
  }

  type ReportMessage {
    id:        ID!
    role:      String!
    content:   String!
    createdAt: String!
  }

  type AskReportResult {
    message:        ReportMessage!
    conversationId: ID!
  }

  input CreateReportTemplateInput {
    name: String!
    description: String
    icon: String
    visibility: String!
    sharedWithTeamIds: [ID!]
    scheduleEnabled: Boolean
    scheduleCron: String
    scheduleChannelId: String
  }

  input UpdateReportTemplateInput {
    name: String
    description: String
    icon: String
    visibility: String
    sharedWithTeamIds: [ID!]
    scheduleEnabled: Boolean
    scheduleCron: String
    scheduleChannelId: String
  }

  # ── La proposta dell'AI per una sezione (19 set 2026) ─────────────────────
  #
  # Tipizzata: e forma NOSTRA, non dato del cliente, e il costruttore deve
  # poterla leggere pezzo per pezzo. I filtri restano una stringa JSON, come
  # nel nodo salvato: quella e la forma che il costruttore gia scrive.

  """Un nodo proposto: l'entita, il suo posto nel grafo e il perche."""
  type ReportDesignNode {
    id:             ID!
    entityType:     String!
    neo4jLabel:     String!
    label:          String!
    isRoot:         Boolean!
    isResult:       Boolean!
    selectedFields: [String!]!
    """I filtri come JSON \`[{field, operator, value}]\`, o null."""
    filters:        String
    positionX:      Float!
    positionY:      Float!
    why:            String!
  }

  type ReportDesignEdge {
    id:               ID!
    sourceNodeId:     ID!
    targetNodeId:     ID!
    relationshipType: String!
    direction:        String!
    label:            String!
  }

  """
  Il progetto di UNA sezione di report: non scrive niente. I campi hanno gli
  stessi nomi di \`ReportSectionInput\`, perche il costruttore li usa per
  riempire il wizard e per chiedere l'anteprima.
  """
  type ReportDesignProposal {
    """La descrizione da cui e nata, per rileggerla accanto al risultato."""
    prompt:        String!
    title:         String!
    chartType:     String!
    metric:        String!
    metricField:   String
    groupByNodeId: ID
    groupByField:  String
    """day (difetto), week o month: senza, una serie su sei mesi è un punto al giorno."""
    groupByGranularity: String
    limit:         Int!
    sortDir:       String!
    nodes:         [ReportDesignNode!]!
    edges:         [ReportDesignEdge!]!
    """Perche questo disegno: il pezzo della descrizione da cui nasce."""
    why:           String!
    discarded:     [FormDesignDiscard!]!
    """Quello che il modello dice di non aver potuto fare."""
    notes:         [String!]!
  }

  input ReportNodeInput {
    id: String!
    entityType: String!
    neo4jLabel: String!
    label: String!
    isResult: Boolean!
    isRoot: Boolean!
    positionX: Float!
    positionY: Float!
    filters: String
    selectedFields: [String!]
  }

  input ReportEdgeInput {
    id: String!
    sourceNodeId: String!
    targetNodeId: String!
    relationshipType: String!
    direction: String!
    label: String!
  }

  input ReportSectionInput {
    title: String!
    chartType: String!
    groupByNodeId: String
    groupByField: String
    """Come raggruppare una data in una serie: day (difetto), week, month."""
    groupByGranularity: String
    metric: String!
    metricField: String
    limit: Int
    sortDir: String
    nodes: [ReportNodeInput!]!
    edges: [ReportEdgeInput!]!
  }

  extend type Mutation {
    # Private copy of a readable template INCLUDING sections, nodes and edges
    # (new ids), created atomically. Schedule is not copied.
    duplicateReportTemplate(id: ID!, name: String): ReportTemplate!
  }
  `
}
