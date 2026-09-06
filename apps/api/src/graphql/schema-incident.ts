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
    causedByProblem: Problem
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
  }

  type Comment {
    id:        ID!
    text:      String!
    author:    User
    createdAt: String!
    updatedAt: String!
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
