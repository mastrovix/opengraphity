export function incidentSDL(): string {
  return `
  # ── Incident ──────────────────────────────────────────────────────────────────

  type Incident {
    id: ID!
    tenantId: String!
    title: String!
    description: String
    severity: IncidentSeverity!
    status: IncidentStatus!
    createdAt: String!
    updatedAt: String!
    resolvedAt: String
    rootCause: String
    assignee: User
    assignedTeam: Team
    affectedCIs: [CIBase!]!
    causedByProblem: Problem
    workflowInstance:     WorkflowInstance
    workflowHistory:      [WorkflowStepExecution!]!
    availableTransitions: [WorkflowTransition!]!
    comments:             [Comment!]!
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
    severity: IncidentSeverity!
    affectedCIIds: [ID!]
  }

  input UpdateIncidentInput {
    title: String
    description: String
    severity: IncidentSeverity
    status: IncidentStatus
  }
  `
}
