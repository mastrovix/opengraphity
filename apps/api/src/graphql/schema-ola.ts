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
    partyType:       String    # team (sourcing internal) | supplier (sourcing external)
    # Legacy: il nome del fornitore scritto a mano. Oggi il responsabile e sempre un team (teamId/teamName).
    partyName:       String
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
    # team → un team con sourcing internal; supplier → un team con sourcing external
    partyType:       String
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

  # Rispetto degli SLA per ORIGINE: la policy da cui sono nati (policyId/policyName),
  # la regola che li ha impostati (setByRule), o nessuna delle due per gli SLA creati
  # prima che l'origine venisse registrata.
  type SLAPolicyAttainmentRow {
    policyId:        String
    policyName:      String
    setByRule:       String
    entityType:      String
    responseMinutes: Int
    resolveMinutes:  Int
    total:           Int!
    met:             Int!
    breached:        Int!
    paused:          Int!
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
    byPolicy:             [SLAPolicyAttainmentRow!]!
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
