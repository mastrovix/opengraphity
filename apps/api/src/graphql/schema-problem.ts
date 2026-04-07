export function problemSDL(): string {
  return `
  # ── Problem ───────────────────────────────────────────────────────────────────

  type Problem {
    id: ID!
    title: String!
    description: String
    priority: String!
    status: String!
    rootCause: String
    workaround: String
    affectedUsers: Int
    createdAt: String!
    updatedAt: String
    resolvedAt: String
    closedAt: String
    createdBy: User
    assignee: User
    assignedTeam: Team
    affectedCIs: [CIBase!]!
    relatedIncidents: [Incident!]!
    relatedChanges: [Change!]!
    workflowInstance: WorkflowInstance
    availableTransitions: [WorkflowTransition!]!
    workflowHistory: [WorkflowStepExecution!]!
    comments: [ProblemComment!]!
  }

  type ProblemComment {
    id: ID!
    text: String!
    type: String!
    createdAt: String!
    updatedAt: String
    author: User
  }

  type ProblemsResult {
    items: [Problem!]!
    total: Int!
  }

  input CreateProblemInput {
    title: String!
    description: String
    priority: String!
    affectedCIs: [ID!]
    relatedIncidents: [ID!]
    workaround: String
  }

  input UpdateProblemInput {
    title: String
    description: String
    priority: String
    rootCause: String
    workaround: String
    affectedUsers: Int
  }
  `
}
