export function serviceRequestSDL(): string {
  return `
  # ── Service Request ───────────────────────────────────────────────────────────

  type ServiceRequest {
    id: ID!
    number: String!
    tenantId: String!
    title: String!
    description: String
    status: String!
    priority: String!
    dueDate: String
    createdAt: String!
    updatedAt: String!
    completedAt: String
    catalogItemId: String
    requiresApproval: Boolean
    workflowInstance: WorkflowInstance
    availableTransitions: [WorkflowTransition!]!
    requestedBy: User
    assignee: User
  }

  type ServiceCatalogItem {
    id: ID!
    name: String!
    description: String
    category: String
    requiresApproval: Boolean!
    active: Boolean!
    createdAt: String!
  }

  input CreateServiceCatalogItemInput {
    name: String!
    description: String
    category: String
    requiresApproval: Boolean
  }

  input UpdateServiceCatalogItemInput {
    name: String
    description: String
    category: String
    requiresApproval: Boolean
    active: Boolean
  }

  input CreateServiceRequestInput {
    title: String!
    description: String
    priority: String!
    dueDate: String
    catalogItemId: ID
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
