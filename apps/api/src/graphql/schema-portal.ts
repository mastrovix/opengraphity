export function portalSDL(): string {
  return `#graphql

  # ── Portal ticket (read model) ────────────────────────────────────────────────

  type MyTicket {
    id:           ID!
    type:         String!
    title:        String!
    description:  String
    status:       String!
    """
    CATEGORIA del passo di workflow in cui si trova il ticket (active, waiting,
    resolved, closed, …), dal workflow di QUESTO cliente.
    Ondata 7 · D-15: il portale coloriva lo stato con una mappa di otto nomi di
    passo di fabbrica e un grigio silenzioso per tutto il resto, quindi un passo
    rinominato o aggiunto nel disegnatore diventava una pastiglia grigia con il
    nome grezzo. La categoria è la stessa cosa che usa il web (PhaseBadge) e
    sopravvive a una rinomina. null = il passo non dichiara una categoria.
    """
    statusCategory: String
    """Etichetta del passo nel workflow del cliente; null se il passo non è (più) nel workflow — allora il portale mostra il valore grezzo."""
    statusLabel:  String
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
    """
    CATEGORIA del passo di workflow in cui si trova il ticket (active, waiting,
    resolved, closed, …), dal workflow di QUESTO cliente.
    Ondata 7 · D-15: il portale coloriva lo stato con una mappa di otto nomi di
    passo di fabbrica e un grigio silenzioso per tutto il resto, quindi un passo
    rinominato o aggiunto nel disegnatore diventava una pastiglia grigia con il
    nome grezzo. La categoria è la stessa cosa che usa il web (PhaseBadge) e
    sopravvive a una rinomina. null = il passo non dichiara una categoria.
    """
    statusCategory: String
    """Etichetta del passo nel workflow del cliente; null se il passo non è (più) nel workflow — allora il portale mostra il valore grezzo."""
    statusLabel:  String
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
