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
    detectedAt:       String!
    resolvedAt:       String
    resolutionStatus: String
    resolutionNote:   String
    resolvedBy:       String
    tenantId:         String!
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
  `
}
