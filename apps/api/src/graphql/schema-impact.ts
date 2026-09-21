export function impactSDL(): string {
  return `
  # ── Impact Analysis ───────────────────────────────────────────────────────────

  type ImpactAnalysis {
    riskScore:     Int!
    riskLevel:     String!
    blastRadius:   [ImpactCI!]!
    openIncidents: [ImpactIncident!]!
    recentChanges: [ImpactChange!]!
    breakdown:     ImpactBreakdown!
  }

  type ImpactCI {
    id:          String!
    name:        String!
    type:        String!
    """Nullabile: un CI senza ambiente non è «unknown», è senza ambiente (revisione totale · B-25)."""
    environment: String
    distance:    Int!
  }

  type ImpactIncident {
    id:        String!
    number:    String!
    title:     String!
    """Nullabile: nessuna gravità inventata (B-25)."""
    severity:  String
    status:    String!
    ciName:    String!
    ciId:      String!
    createdAt: String!
    isOpen:    Boolean!
  }

  type ImpactChange {
    id:        String!
    code:      String!
    title:     String!
    phase:     String!
    ciName:    String!
    ciId:      String!
    createdAt: String!
  }

  type ImpactBreakdown {
    productionCIs:  Int!
    blastRadiusCIs: Int!
    openIncidents:  Int!
    failedChanges:  Int!
    ongoingChanges: Int!
    scoreDetails:   String!
  }

  extend type Query {
    changeImpactAnalysis(ciIds: [ID!]!): ImpactAnalysis!
  }
  `
}
