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
    slaStatus: SLAStatusInfo
    """I CI che la richiesta riguarda (revisione del 15 set 2026 · CM-8)."""
    affectedCIs: [CIBase!]!
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
  }

  input CreateServiceCatalogItemInput {
    name: String!
    description: String
    category: String
    requiresApproval: Boolean
    priority: String!
  }

  input UpdateServiceCatalogItemInput {
    name: String
    description: String
    category: String
    requiresApproval: Boolean
    priority: String
    active: Boolean
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
