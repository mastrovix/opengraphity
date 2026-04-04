export function approvalSDL(): string {
  return `#graphql

  type ApprovalRequest {
    id:             ID!
    tenantId:       String!
    entityType:     String!
    entityId:       String!
    title:          String!
    description:    String
    status:         String!
    requestedBy:    String!
    requestedAt:    String!
    approvers:      [String!]!
    approvedBy:     [String!]!
    rejectedBy:     String
    approvalType:   String!
    dueDate:        String
    resolvedAt:     String
    resolutionNote: String
  }

  type ApprovalRequestsResult {
    items: [ApprovalRequest!]!
    total: Int!
  }
  `
}
