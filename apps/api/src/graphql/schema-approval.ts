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
    """
    QUALE PARTE dell'approvazione, per le change (20 set 2026, dal giro nel
    browser). Una change ne pretende due — \`owner_group\` e \`change_manager\` —
    e senza questo la pagina mostrava DUE RIGHE IDENTICHE: stesso ticket,
    stesso team, stessa ora. Chi approva non sapeva cosa stesse approvando, né
    perché la stessa change comparisse due volte. Assente per le richieste,
    che hanno un passo solo.
    """
    approvalKind: String
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
