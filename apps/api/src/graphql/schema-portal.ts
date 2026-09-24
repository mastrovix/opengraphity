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
    """
    Il passo da cui si arriva; **null** per la prima voce, che non ha un passo
    di partenza (revisione totale · H-49). Prima era non-nullo e quel caso si
    scriveva con il nome «start», un letterale condiviso fra API e portale: se
    un cliente chiamava un suo passo «start», la riga della storia perdeva la
    parte «da».
    """
    fromStep:    String
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
    "I campi del cliente offerti all'utente finale, con i valori (ondata 4)."
    customFields: [CustomFieldValue!]!
    """
    LE RISPOSTE AL MODULO del catalogo, con le domande della revisione con cui
    la richiesta e' stata compilata. Solo le voci che il modulo offre agli
    utenti finali: le altre sono domande che a lui non sono state fatte.

    Vuoto per un incident e per una richiesta senza modulo. Revisione del 17
    set 2026: chi compilava dodici campi non li rivedeva MAI — ne' per
    controllare, ne' per citarli al telefono.
    """
    formAnswers: [FormAnswer!]!
    """
    True when the ticket is resolved and its workflow lets the requester
    confirm it and close it now: a MANUAL move from the resolved step to a
    step of category closed (tour of 23 Sep 2026, D51). False when the
    workflow closes it only by its timer — then the portal offers no button.
    """
    canConfirmResolution: Boolean!
  }

  type MyTicketsResult {
    items: [MyTicket!]!
    total: Int!
  }

  type TicketCategory {
    name:  String!
    label: String!
    """The icon chosen in the Dictionary (G40), a name of the product's list; null = none chosen."""
    icon:  String
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
