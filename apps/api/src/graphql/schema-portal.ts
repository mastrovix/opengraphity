export function portalSDL(): string {
  return `#graphql

  # ── Portal ticket (read model) ────────────────────────────────────────────────

  type MyTicket {
    id:           ID!
    number:       String!
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
    """
    La severità con le parole di chi guarda: quelle scelte dall'amministratore per
    il portale, altrimenti l'etichetta del Dizionario.
    """
    priorityLabel: String!
    """Il colore del Dizionario per la severità; null se il cliente non gliene ha dato uno (neutro)."""
    priorityColor: String
    """Null for incidents without a category (opened from an alarm)."""
    category:     String
    createdAt:    String!
    updatedAt:    String!
    assignedTeam: String
  }

  type WorkflowHistoryEntry {
    fromStep:    String!
    toStep:      String!
    """Etichette dei passi nella lingua chiesta; null se il passo non è (più) nel workflow."""
    fromLabel:   String
    toLabel:     String
    label:       String
    triggeredAt: String!
    triggeredBy: String!
  }

  type MyTicketDetail {
    id:           ID!
    number:       String!
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
    """
    La severità con le parole di chi guarda: quelle scelte dall'amministratore per
    il portale, altrimenti l'etichetta del Dizionario.
    """
    priorityLabel: String!
    """Il colore del Dizionario per la severità; null se il cliente non gliene ha dato uno (neutro)."""
    priorityColor: String
    """Null for incidents without a category (opened from an alarm)."""
    category:     String
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

  type TicketCategory {
    name:  String!
    label: String!
  }

  """Una severità offerta nel portale, già nella lingua chiesta."""
  type PortalSeverityChoice {
    value: String!
    label: String!
    """Il colore del Dizionario (ValueColor); null = neutro."""
    color: String
  }

  """Una severità offerta nel portale, come l'ha salvata l'amministratore: le etichette scritte, lingua per lingua."""
  type PortalSeverityOption {
    value:  String!
    labels: [LocalizedLabel!]!
  }

  input PortalSeverityLabelInput {
    language: String!
    """Vuota = vale l'etichetta del Dizionario per quella lingua."""
    label:    String!
  }

  input PortalSeverityOptionInput {
    value:  String!
    labels: [PortalSeverityLabelInput!]!
  }

  type MyTicketStats {
    open:       Int!
    inProgress: Int!
    resolved:   Int!
    total:      Int!
  }
  `
}
