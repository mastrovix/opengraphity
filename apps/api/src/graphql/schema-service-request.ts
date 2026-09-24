export function serviceRequestSDL(): string {
  return `
  # ── Service Request ───────────────────────────────────────────────────────────

  type ServiceRequestsResult {
    items: [ServiceRequest!]!
    total: Int!
  }

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
    """La categoria ereditata dalla voce di catalogo: la leggono le policy SLA per categoria (revisione totale · B-32)."""
    category: String
    requiresApproval: Boolean
    workflowInstance: WorkflowInstance
    availableTransitions: [WorkflowTransition!]!
    requestedBy: User
    assignee: User
    """
    The team the request is assigned to: at creation the fulfilment group of its
    catalog item (D56); the assignee is a member of it.
    """
    team: Team
    slaStatus: SLAStatusInfo
    """I CI che la richiesta riguarda (revisione del 15 set 2026 · CM-8)."""
    affectedCIs: [CIBase!]!
    """La revisione del modulo con cui e stata compilata: 0 o null = nessun modulo (moduli del catalogo, ondata 1)."""
    formRevision: Int
    """Le risposte del modulo, nell'ordine del modulo con cui e stata compilata."""
    formAnswers: [FormAnswer!]!
    """
    I valori dei campi della LIBRERIA messi «nelle liste», per le colonne e per
    l'esportazione (moduli del catalogo, ondata 4). Diverso da \`formAnswers\`:
    quello racconta il modulo di allora, con le domande nel loro ordine; questo
    dice solo cosa c'e scritto adesso, e non ha bisogno della revisione — quindi
    funziona anche sui ticket che non nascono da un modulo.
    """
    formFieldValues: [FormAnswer!]!
  }

  type ServiceCatalogItem {
    id: ID!
    name: String!
    description: String
    """Un valore del vocabolario \`category\`: la eredita la richiesta, e la usano le policy SLA per categoria."""
    category: String
    """La categoria scritta a mano prima del Dizionario, quando non corrispondeva a nessun valore: da sostituire scegliendone una."""
    legacyCategory: String
    requiresApproval: Boolean!
    """
    La priorità (vocabolario \`priority\`) con cui nascono le richieste aperte da
    questa voce: la decide l'amministratore, non l'utente del portale. Null solo
    per voci vecchie mai sistemate: da quelle il portale non apre richieste.
    """
    priority: String
    active: Boolean!
    createdAt: String!
    """
    L'iter di QUESTA voce (moduli del catalogo, ondata 3): l'identificativo
    della definizione di workflow da usare. Assente = si sceglie per categoria,
    come prima. Il motore la preferisce alla categoria.
    """
    workflowDefinitionId: ID
    """Il nome della definizione scelta, per mostrarlo senza una seconda query."""
    workflowDefinitionName: String
    """The fulfilment group: the requests of this item are born assigned to it (D56). Null = born without a team."""
    fulfillmentTeam: Team
  }

  input CreateServiceCatalogItemInput {
    name: String!
    description: String
    category: String
    requiresApproval: Boolean
    priority: String!
    """L'iter di questa voce: assente = si sceglie per categoria (moduli del catalogo, ondata 3)."""
    workflowDefinitionId: ID
    """The fulfilment group of the item's requests (D56)."""
    fulfillmentTeamId: ID
  }

  input UpdateServiceCatalogItemInput {
    name: String
    description: String
    category: String
    requiresApproval: Boolean
    priority: String
    active: Boolean
    """L'iter di questa voce: assente = si sceglie per categoria (moduli del catalogo, ondata 3)."""
    workflowDefinitionId: ID
    """The fulfilment group (D56); null removes it."""
    fulfillmentTeamId: ID
  }

  input CreateServiceRequestInput {
    title: String!
    description: String
    """
    Obbligatoria per una richiesta generica. Da una voce del catalogo vale la
    priorità della voce; un operatore può indicarne un'altra, l'utente del portale no.
    """
    priority: String
    dueDate: String
    catalogItemId: ID
    """
    Chi crea sa che nessuna policy SLA copre il ticket e accetta che nasca
    senza SLA: la diagnostica di configurazione non lo conta.
    """
    acknowledgeNoSla: Boolean
    """Le risposte al modulo della voce di catalogo (moduli del catalogo, ondata 1)."""
    formAnswers: [FormAnswerInput!]
    """
    L'identificativo della BOZZA su cui sono stati caricati i file dei campi
    allegato (ondata 2). Lo scegli il client PRIMA di caricare; alla creazione i
    file passano dalla bozza al ticket. Le bozze mai reclamate le pulisce la
    manutenzione notturna.
    """
    formDraftId: ID
    """
    La revisione del modulo che il client ha COMPILATO (ondata 8). Se
    l'amministratore ripubblica il modulo mentre qualcuno lo sta compilando, le
    risposte sono di un altro modulo: la richiesta viene rifiutata dicendolo —
    «il modulo e' cambiato, ricomincia» — invece di ricevere un rifiuto
    incomprensibile su un campo che non ha mai visto. Assente = il client non la
    manda (un client vecchio): si accetta come prima.
    """
    formRevision: Int
    """
    The person the request is for, when someone of the staff opens it for them
    (tour of 24 Sep 2026, G28: the service desk could not open a request for a
    colleague). Absent = the person opening it. Not from the portal.
    """
    requestedForId: ID
  }

  input UpdateServiceRequestInput {
    title: String
    description: String
    priority: String
    dueDate: String
    # No status: a request's status is its workflow step — change it only via
    # executeWorkflowTransition (the transition buttons), never by direct edit.
  }
  `
}
