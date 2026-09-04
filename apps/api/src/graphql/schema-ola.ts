export function olaSDL(): string {
  return `
  # ── OLA / UC (Operational Level Agreements & Underpinning Contracts) ──────────
  #
  # OLA: internal target between support teams. UC: target underpinned by an
  # external supplier. Both carry response/resolve targets and a responsible
  # party, and feed the SLA report's attainment section.

  type OLAContract {
    id:              ID!
    type:            String!   # ola | uc
    name:            String!
    description:     String
    entityType:      String!   # incident | problem | change | service_request | any
    responseMinutes: Int!
    resolveMinutes:  Int!
    businessHours:   Boolean!
    partyType:       String    # team | supplier
    partyName:       String    # supplier name (UC) or team label (OLA)
    teamId:          String
    teamName:        String
    enabled:         Boolean!
    createdAt:       String!
  }

  input CreateOLAContractInput {
    type:            String!
    name:            String!
    description:     String
    entityType:      String!
    responseMinutes: Int!
    resolveMinutes:  Int!
    businessHours:   Boolean
    partyType:       String
    partyName:       String
    teamId:          String
  }

  input UpdateOLAContractInput {
    name:            String
    description:     String
    entityType:      String
    responseMinutes: Int
    resolveMinutes:  Int
    businessHours:   Boolean
    partyType:       String
    partyName:       String
    teamId:          String
    enabled:         Boolean
  }

  # ── SLA Report ───────────────────────────────────────────────────────────────

  type SLAPriorityRow {
    priority: String!
    total:    Int!
    met:      Int!
    breached: Int!
  }

  type SLAComplianceBlock {
    total:                Int!
    met:                  Int!
    breached:             Int!
    paused:               Int!
    openOnTrack:          Int!
    breachRate:           Float!
    avgResolutionMinutes: Float
    byPriority:           [SLAPriorityRow!]!
  }

  type OLAAttainmentRow {
    id:             ID!
    type:           String!
    name:           String!
    entityType:     String!
    partyType:      String
    partyName:      String
    resolveMinutes: Int!
    evaluated:      Int!
    met:            Int!
    breached:       Int!
    attainmentPct:  Float
  }

  type SLAReport {
    generatedAt: String!
    windowDays:  Int!
    sla:         SLAComplianceBlock!
    ola:         [OLAAttainmentRow!]!
  }
  `
}
