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

  """
  Un'approvazione che si decide nella pagina del ticket, non qui: il
  requisito di un team su una change, o una service request ferma in un passo
  di approvazione. La pagina Approvazioni le elenca accanto alle richieste
  generiche, con il link al ticket.
  """
  type PendingTicketApproval {
    kind:        String!
    entityId:    ID!
    number:      String
    title:       String!
    """Il team del requisito (change) o l'etichetta del passo (richiesta)."""
    detail:      String
    requestedAt: String
  }

  type ApprovalRequestsResult {
    items: [ApprovalRequest!]!
    total: Int!
  }
  extend type Query {
    pendingTicketApprovals: [PendingTicketApproval!]!
  }
  `
}
