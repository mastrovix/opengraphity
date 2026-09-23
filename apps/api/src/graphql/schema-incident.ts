export function incidentSDL(): string {
  return `
  # ── Incident ──────────────────────────────────────────────────────────────────

  type Incident {
    id: ID!
    number: String!
    tenantId: String!
    title: String!
    description: String
    severity: String!
    impact: String
    urgency: String
    priority: String!
    major: Boolean
    category: String
    status: String!
    createdAt: String!
    updatedAt: String!
    resolvedAt: String
    rootCause: String
    assignee: User
    assignedTeam: Team
    affectedCIs: [CIBase!]!
    impactedApplications: [ImpactedApplication!]!
    # Ticket collegati (per tipo): altri incident (RELATED_TO), problem (CAUSED_BY),
    # change che lo risolvono (RESOLVED_BY).
    linkedIncidents: [LinkedTicketRef!]!
    linkedProblems:  [LinkedTicketRef!]!
    linkedChanges:   [LinkedTicketRef!]!
    workflowInstance:     WorkflowInstance
    workflowHistory:      [WorkflowStepExecution!]!
    availableTransitions: [WorkflowTransition!]!
    comments:             [Comment!]!
    slaStatus:            SLAStatusInfo
  }

  # Applicazione impattata dall'incident: o direttamente colpita (distance 0),
  # o che dipende — anche transitivamente — dal CI colpito. \`via\` è il nome del
  # CI colpito da cui l'applicazione dipende.
  type ImpactPathNode {
    id:   ID!
    name: String!
    type: String
  }

  type ImpactedApplication {
    ci:       CIBase!
    distance: Int!
    via:      String
    # Catena di CI dal CI colpito → … → applicazione (propagazione dell'impatto).
    path:     [ImpactPathNode!]!
  }

  type SLAStatusInfo {
    startedAt:        String!
    responseDeadline: String!
    resolveDeadline:  String!
    responseMet:      Boolean!
    resolveMet:       Boolean!
    breached:         Boolean!
    pausedAt:         String
    """Minuti di preavviso della policy: sotto questa soglia lo SLA è «in scadenza», per l'avviso e per il badge."""
    warningMinutes:   Int!
  }

  type Comment {
    id:        ID!
    text:      String!
    """Nota di lavoro (solo staff) o risposta pubblica, visibile anche dal portale."""
    isInternal: Boolean!
    author:    User
    """Chi l'ha scritto quando non è una persona: 'automation' (una regola) o 'monitoring'."""
    authorKind:  String
    """Il nome dell'automazione che l'ha scritto."""
    authorLabel: String
    createdAt: String!
    updatedAt: String!
    """Modificato: quando e da chi (il testo di prima è nell'Audit Log)."""
    editedAt:      String
    editedByName:  String
    """Cancellato: il commento resta come traccia, senza testo."""
    deletedAt:     String
    deletedByName: String
  }

  type IncidentsResult {
    items: [Incident!]!
    total: Int!
  }

  input CreateIncidentInput {
    title: String!
    description: String
    severity: String
    impact: String
    urgency: String
    category: String
    affectedCIIds: [ID!]
    """
    Chi crea sa che nessuna policy SLA copre il ticket e accetta che nasca
    senza SLA: la diagnostica di configurazione non lo conta.
    """
    acknowledgeNoSla: Boolean
    """
    The team that takes the incident (the form prefills it with the support
    group of the selected CI). Absent: the support group of the first impacted
    CI that has one; none of them has one: no team.
    """
    teamId: ID
  }

  input UpdateIncidentInput {
    title: String
    description: String
    severity: String
    impact: String
    urgency: String
    # No status: an incident's status is its workflow step — change it only via
    # executeWorkflowTransition (the transition buttons), never by direct edit.
  }
  `
}
