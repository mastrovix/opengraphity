export function serviceRequestSDL(): string {
  return `
  # ── Service Request ───────────────────────────────────────────────────────────

  type ServiceRequest {
    id: ID!
    tenantId: String!
    title: String!
    description: String
    status: ServiceRequestStatus!
    priority: ServiceRequestPriority!
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
    priority: ServiceRequestPriority!
    dueDate: String
  }

  input UpdateServiceRequestInput {
    title: String
    description: String
    status: ServiceRequestStatus
    priority: ServiceRequestPriority
    dueDate: String
  }
  `
}
