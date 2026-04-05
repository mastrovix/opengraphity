export function portalSDL(): string {
  return `#graphql

  # ── Portal ticket (read model) ────────────────────────────────────────────────

  type MyTicket {
    id:           ID!
    type:         String!
    title:        String!
    description:  String
    status:       String!
    priority:     String!
    category:     String!
    createdAt:    String!
    updatedAt:    String!
    assignedTeam: String
  }

  type WorkflowHistoryEntry {
    fromStep:    String!
    toStep:      String!
    label:       String
    triggeredAt: String!
    triggeredBy: String!
  }

  type MyTicketDetail {
    id:           ID!
    type:         String!
    title:        String!
    description:  String
    status:       String!
    priority:     String!
    category:     String!
    createdAt:    String!
    updatedAt:    String!
    assignedTeam: String
    comments:     [EntityComment!]!
    attachments:  [Attachment!]!
    history:      [WorkflowHistoryEntry!]!
  }

  type MyTicketsResult {
    items: [MyTicket!]!
    total: Int!
  }

  type MyTicketStats {
    open:       Int!
    inProgress: Int!
    resolved:   Int!
    total:      Int!
  }
  `
}
