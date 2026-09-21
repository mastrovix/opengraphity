export function problemSDL(): string {
  return `
  # ── Problem ───────────────────────────────────────────────────────────────────

  type Problem {
    id: ID!
    number: String!
    title: String!
    description: String
    """Nullabile: un problem senza priorità si mostra senza priorità, non «medium» (revisione totale · B-25)."""
    priority: String
    impact: String
    urgency: String
    """
    La categoria del problem (vocabolario del cliente). Il nodo non la scriveva
    affatto: le policy SLA «problem, categoria X» erano ammesse e non
    sceglievano mai nessun problem, e il valore passato via REST spariva
    (revisione totale · B-3).
    """
    category: String
    status: String!
    rootCause: String
    workaround: String
    affectedUsers: Int
    createdAt: String!
    updatedAt: String
    resolvedAt: String
    closedAt: String
    createdBy: User
    assignee: User
    assignedTeam: Team
    affectedCIs: [CIBase!]!
    # Ticket collegati (per tipo, shape uniforme): incident (CAUSED_BY), altri
    # problem (RELATED_TO), change che lo risolvono (RESOLVED_BY).
    linkedIncidents: [LinkedTicketRef!]!
    linkedProblems:  [LinkedTicketRef!]!
    linkedChanges:   [LinkedTicketRef!]!
    workflowInstance: WorkflowInstance
    availableTransitions: [WorkflowTransition!]!
    workflowHistory: [WorkflowStepExecution!]!
    comments: [ProblemComment!]!
    # Lo SLA del problem. Il motore lo creava (dopo la correzione del payload:
    # leggeva «impact», che nessuno pubblica) ma il tipo non lo esponeva, quindi
    # non c'era modo di vederne la scadenza da nessuna pagina — ed è la ragione
    # per cui «nessuno SLA per nessun problem» è passato inosservato.
    slaStatus: SLAStatusInfo
    # Valorizzato SOLO dal risultato di executeProblemTransition: azioni di step
    # fallite DOPO che la transizione è stata persistita.
    actionErrors: [String!]
  }

  type ProblemComment {
    id: ID!
    text: String!
    type: String!
    isInternal: Boolean!
    createdAt: String!
    updatedAt: String
    author: User
    authorKind: String
    authorLabel: String
    editedAt: String
    editedByName: String
    deletedAt: String
    deletedByName: String
  }

  type ProblemsResult {
    items: [Problem!]!
    total: Int!
  }

  input CreateProblemInput {
    title: String!
    description: String
    priority: String
    impact: String
    urgency: String
    """Categoria del vocabolario del cliente: sceglie il workflow E resta sul nodo (B-3)."""
    category: String
    affectedCIs: [ID!]
    relatedIncidents: [ID!]
    workaround: String
    """
    Chi crea sa che nessuna policy SLA copre il ticket e accetta che nasca
    senza SLA: la diagnostica di configurazione non lo conta.
    """
    acknowledgeNoSla: Boolean
  }

  input UpdateProblemInput {
    title: String
    description: String
    """Categoria del vocabolario del cliente (B-3)."""
    category: String
    # Priorità = Impatto × Urgenza (ITIL). Se passi impact/urgency la priorità è
    # ricalcolata; se passi solo priority, impact/urgency vengono riallineati.
    priority: String
    impact: String
    urgency: String
    rootCause: String
    workaround: String
    affectedUsers: Int
  }
  `
}
