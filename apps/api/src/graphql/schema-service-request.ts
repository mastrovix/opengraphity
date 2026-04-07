export function serviceRequestSDL(): string {
  return `
  # ── Service Request ───────────────────────────────────────────────────────────

  type ServiceRequest {
    id: ID!
    tenantId: String!
    title: String!
    description: String
    status: String!
    priority: String!
    dueDate: String
    createdAt: String!
    updatedAt: String!
    completedAt: String
    requestedBy: User
    assignee: User
  }

  input CreateServiceRequestInput {
    title: String!
    description: String
    priority: String!
    dueDate: String
  }

  input UpdateServiceRequestInput {
    title: String
    description: String
    status: String
    priority: String
    dueDate: String
  }
  `
}
