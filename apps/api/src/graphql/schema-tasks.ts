export function ticketTasksSDL(): string {
  return `#graphql

  """
  UN COMPITO DA FARE, appeso a un ticket (20 set 2026).

  Nasce da un'azione \`create_task\` all'ingresso in un passo del workflow:
  «Nuovo portatile» approvata fa partire «prepara la macchina» al Desk e
  «crea l'utenza» ai Sistemi. È generico — incident, problem, change e
  richieste di servizio lo usano allo stesso modo — a differenza dei cinque
  compiti delle change (assessment, piano, validazione, deploy, review), che
  restano quelli che sono.
  """
  type TicketTask {
    id:   ID!
    """Il numero leggibile, dalla stessa numerazione dei compiti di change (TASK00000042)."""
    code: String!
    title: String!
    description: String
    """waiting (aspetta un altro compito) | open | completed | cancelled."""
    state: String!
    """Il titolo del compito che sta aspettando, quando è in attesa."""
    afterTitle: String
    """
    Il tipo del TICKET a cui è appeso, e deve corrispondergli: un compito di
    tipo incident su una change è vietato. Non è modificabile — un compito
    nato sbagliato si annulla e se ne fa un altro.
    """
    entityType: String!
    entityId:   ID!
    """Il passo del workflow che l'ha creato."""
    stepName:   String!
    dueAt:      String
    teamId:     ID
    teamName:   String
    assigneeId:   ID
    assigneeName: String
    createdAt:     String!
    completedAt:   String
    completedById: ID
    cancelReason:  String
  }

  extend type Query {
    """I compiti di un ticket, dal primo creato."""
    ticketTasks(entityId: ID!): [TicketTask!]!
  }

  extend type Mutation {
    """Chiude un compito: il lavoro è fatto."""
    completeTicketTask(taskId: ID!, note: String): TicketTask!
    """
    Annulla un compito che non serve più, col motivo. Non si cancella: il
    registro di cosa è stato chiesto resta.
    """
    cancelTicketTask(taskId: ID!, reason: String!): TicketTask!
  }
`
}
