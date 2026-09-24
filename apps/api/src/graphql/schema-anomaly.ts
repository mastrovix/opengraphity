export function anomalySDL(): string {
  return `
  # ── Anomaly Detection ──────────────────────────────────────────────────────

  enum ResolutionStatus {
    resolved
    false_positive
    accepted_risk
  }

  type Anomaly {
    id:               ID!
    ruleKey:          String!
    title:            String!
    severity:         String!
    status:           String!
    entityId:         String!
    entityType:       String!
    entitySubtype:    String!
    entityName:       String!
    description:      String!
    # Parametri della frase del risultato (la pagina la compone nella lingua di chi guarda).
    # Null = anomalia registrata prima del 14 set 2026 e non più riscansionata.
    descriptionParams: [AnomalyParam!]
    detectedAt:       String!
    resolvedAt:       String
    resolutionStatus: String
    resolutionNote:   String
    """L'id di chi l'ha risolta: per mostrarlo usa «resolvedByName» (G-ANO-8)."""
    resolvedBy:       String
    """
    Il NOME di chi l'ha risolta (revisione totale · G-ANO-8): il pannello
    mostrava «resolvedBy», cioè l'UUID — «Risolta da 3f2a9c…» — oppure la
    stringa «unknown» per una chiusura automatica dello scan. Vuoto quando
    l'ha chiusa il prodotto e non una persona.
    """
    resolvedByName:   String
    """Perché lo scan l'ha chiusa: \`not_detected\` (non c'è più) o \`rule_disabled\` (la regola è stata spenta)."""
    resolvedReason:   String
    tenantId:         String!
  }

  type AnomalyParam {
    key:   String!
    value: String!
  }

  type AnomaliesResult {
    items: [Anomaly!]!
    total: Int!
  }

  type AnomalyStats {
    total:         Int!
    open:          Int!
    critical:      Int!
    high:          Int!
    medium:        Int!
    low:           Int!
    falsePositive: Int!
    acceptedRisk:  Int!
  }

  type AnomalyScanStatus {
    lastScanAt:  String
    totalScans:  Int!
  }
  
  # ── Configurazione delle regole (verifica «Cosa resta cablato», ondata 5) ──

  """Quali scelte ha senso fare su una regola: le altre restano vuote."""
  type AnomalyRuleSpec {
    ciTypes:            Boolean!
    relations:          Boolean!
    """No relation chosen means every relation between the tenant's CIs (isolated cluster, D49); otherwise at least one is required."""
    allRelationsWhenEmpty: Boolean!
    thresholdMin:       Int
    thresholdMax:       Int
    incidentSeverities: Boolean!
    forbidden:          Boolean!
    """The rule weighs a CI by its environment: a severity outside production can be chosen (G32)."""
    environment:        Boolean!
  }

  type AnomalyForbiddenRelation {
    fromType: String!
    relation: String!
    toType:   String!
  }

  """Perché una regola salvata non si può eseguire, come chiave da tradurre."""
  type AnomalyRuleProblem {
    key:     String!
    params:  [AnomalyParam!]!
    message: String!
  }

  """
  Una regola di anomalia con le scelte del cliente. La logica (cos'è un orfano,
  un ciclo, un cluster) è del prodotto; soglia, gravità, tipi, relazioni e
  severità contate sono sue. Prima erano scritte nelle Cypher.
  """
  type AnomalyRuleConfig {
    ruleKey:            String!
    enabled:            Boolean!
    severity:           String!
    """Nomi dei tipi di CI; vuoto = tutti i tipi, anche quelli creati dopo."""
    ciTypes:            [String!]!
    relations:          [String!]!
    threshold:          Int
    incidentSeverities: [String!]!
    forbidden:          [AnomalyForbiddenRelation!]!
    """The severity on a CI outside production (the event policy's production environments); null = the same as severity."""
    nonProductionSeverity: String
    spec:               AnomalyRuleSpec!
    """Vero quando il cliente non l'ha mai salvata: valgono le scelte di fabbrica."""
    isDefault:          Boolean!
    updatedAt:          String
    """Non null quando la regola cita un tipo, una relazione o una severità che non esistono più: lo scan la fa fallire."""
    problem:            AnomalyRuleProblem
    """Anomalie aperte di questa regola."""
    openCount:          Int!
  }

  type AnomalyCIType {
    name:       String!
    label:      String!
    neo4jLabel: String!
  }

  """Le scelte possibili, dal metamodello e dai vocabolari del cliente."""
  type AnomalyRuleOptions {
    ciTypes:            [AnomalyCIType!]!
    relations:          [String!]!
    incidentSeverities: [String!]!
    """La scala della gravità di un'anomalia (del prodotto)."""
    severities:         [String!]!
  }

  input AnomalyForbiddenRelationInput {
    fromType: String!
    relation: String!
    toType:   String!
  }

  input AnomalyRuleSettingsInput {
    enabled:            Boolean!
    severity:           String!
    ciTypes:            [String!]!
    relations:          [String!]!
    threshold:          Int
    incidentSeverities: [String!]!
    forbidden:          [AnomalyForbiddenRelationInput!]!
    nonProductionSeverity: String
  }

  extend type Query {
    """Le regole di anomalia con la configurazione del cliente. Admin."""
    anomalyRules: [AnomalyRuleConfig!]!
    """Tipi di CI, relazioni e severità fra cui scegliere. Admin."""
    anomalyRuleOptions: AnomalyRuleOptions!
  }

  extend type Mutation {
    """
    Salva le scelte di una regola. Valida ogni tipo, relazione e severità contro
    il metamodello del cliente e rifiuta una scelta che la regola non usa.
    Admin. Vale dal prossimo scan.
    """
    updateAnomalyRule(ruleKey: String!, settings: AnomalyRuleSettingsInput!): AnomalyRuleConfig!
  }
  `
}
