export function whatifSDL(): string {
  return `
  # ── What-If Planning ─────────────────────────────────────────────────────────

  type WhatIfCI {
    id:          ID!
    name:        String!
    type:        String!
    environment: String
    status:      String
    impactLevel: String!
    impactPath:  [String!]!
    isRedundant: Boolean!
  }

  type WhatIfTeam {
    id:              ID!
    name:            String!
    role:            String!
    impactedCICount: Int!
  }

  type WhatIfResult {
    targetCI:         WhatIfCI!
    action:           String!
    impactedCIs:      [WhatIfCI!]!
    impactedServices: [WhatIfCI!]!
    impactedTeams:    [WhatIfTeam!]!
    totalImpacted:    Int!
    riskScore:        Int!
    hasRedundancy:    Boolean!
    openIncidents:    Int!
    summary:          String!
  }

  input WhatIfScenarioInput {
    ciId:   ID!
    action: String!
  }

  # ── Change Calendar ──────────────────────────────────────────────────────────

  type ChangeCalendarEvent {
    id:               ID!
    title:            String!
    changeType:       String!
    status:           String!
    riskLevel:        String
    scheduledStart:   String
    scheduledEnd:     String
    duration:         Int
    ciNames:          [String!]!
    teamName:         String
    requiresDowntime: Boolean!
    color:            String!
  }

  type ChangeConflict {
    changeA:      ChangeCalendarEvent!
    changeB:      ChangeCalendarEvent!
    sharedCIs:    [String!]!
    overlapStart: String!
    overlapEnd:   String!
  }

  type SuggestedSlot {
    start:  String!
    end:    String!
    score:  Int!
    reason: String!
  }
  `
}
