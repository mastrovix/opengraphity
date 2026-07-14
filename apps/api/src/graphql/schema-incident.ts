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
    category: String
    status: String!
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
    slaStatus:            SLAStatusInfo
  }

  type SLAStatusInfo {
    startedAt:        String!
    responseDeadline: String!
    resolveDeadline:  String!
    responseMet:      Boolean!
    resolveMet:       Boolean!
    breached:         Boolean!
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
    severity: String!
    category: String
    affectedCIIds: [ID!]
  }

  input UpdateIncidentInput {
    title: String
    description: String
    severity: String
    status: String
  }
  `
}
