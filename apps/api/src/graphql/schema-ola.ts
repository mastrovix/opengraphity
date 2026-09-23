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
    # Il calendario di servizio con cui conta (null = 24×7), e il suo nome.
    calendarId:      ID
    calendarName:    String
    """The contract's own time zone (IANA); null = it counts in the organization's, like an SLA policy."""
    timezone:        String
    # L'obiettivo di conformità e la soglia d'attenzione, in percentuale.
    complianceTarget:  Float
    complianceWarning: Float
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
    # Il calendario di servizio; null o assente = 24×7.
    calendarId:      ID
    """The contract's own time zone (IANA); null, empty or absent = the organization's."""
    timezone:        String
    complianceTarget:  Float!
    complianceWarning: Float!
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
    # Il calendario di servizio; null = 24×7, assente = invariato.
    calendarId:      ID
    """The contract's own time zone; null or empty = the organization's, absent = unchanged."""
    timezone:        String
    complianceTarget:  Float
    complianceWarning: Float
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
    # L'obiettivo della policy (null per SLA senza policy): colora la percentuale di rispetto.
    complianceTarget:  Float
    complianceWarning: Float
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
    # Quanti dei ticket valutati hanno tempo ricostruito dall'apertura (prima della storia delle assegnazioni).
    inferred:       Int!
    complianceTarget:  Float
    complianceWarning: Float
  }

  """
  Un contratto OLA/UC su un ticket (il riquadro nel dettaglio): il tempo in cui il
  ticket è stato del team del contratto. \`applies\` false: il contratto è del tipo
  del ticket ma non conta, e \`reason\` dice perché (\`other_team\`: il team non
  l'ha mai avuto; \`before_contract\`: l'ha avuto solo prima che il contratto
  esistesse). \`state\`: \`met\`, \`breached\`, \`running\`, \`handed_off\`
  (passato ad altri entro l'obiettivo) o \`scheduled\` (la finestra del piano non è ancora iniziata), null se non conta. \`inferred\`: parte del
  tempo è ricostruita dall'apertura del ticket (ticket di prima della storia delle assegnazioni).
  """
  type TicketOLA {
    contractId:     ID!
    name:           String!
    type:           String!
    teamName:       String
    resolveMinutes: Int!
    calendarId:     ID
    calendarName:   String
    applies:        Boolean!
    reason:         String
    deadline:       String
    concludedAt:    String
    state:          String
    usedMinutes:      Int!
    remainingMinutes: Int!
    inferred:         Boolean!
    """Solo change: la misura del task (assessment, validation, release); null = il ticket intero."""
    unitKind:         String
    unitKey:          String
    ciName:           String
    """Assessment: owner (funzionale) o support (tecnico)."""
    responderRole:    String
    """Validazione e rilascio: il titolo del passo del piano."""
    stepTitle:        String
    """Validazione e rilascio: l'inizio della finestra, da cui il tempo corre."""
    startsAt:         String
  }

  type SLAReport {
    generatedAt: String!
    windowDays:  Int!
    sla:         SLAComplianceBlock!
    ola:         [OLAAttainmentRow!]!
  }
  `
}
