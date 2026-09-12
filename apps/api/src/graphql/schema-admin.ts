export function adminSDL(): string {
  return `
  # ── Admin (Logs, Queue) ────────────────────────────────────────────────────

  type LogEntry {
    id:        ID!
    timestamp: String!
    level:     String!
    module:    String
    message:   String!
    data:      String
  }

  type LogsResult {
    entries: [LogEntry!]!
    total:   Int!
  }

  type QueueJobCounts {
    waiting:   Int!
    active:    Int!
    completed: Int!
    failed:    Int!
    delayed:   Int!
    paused:    Int!
  }

  """
  Una coda BullMQ del registro unico (lib/queueRegistry.ts): tutte le code
  della piattaforma, comprese quelle dell'Event Management, dei Servizi
  monitorati e dei consumer di dominio.
  """
  type QueueStat {
    name:   String!
    """
    Sottosistema, per raggruppare senza conoscere i nomi delle code:
    events (allarmi) | services (servizi monitorati) | itsm (ticket, workflow,
    SLA, notifiche) | platform (integrazioni, report, discovery, embedding, manutenzione).
    """
    group: String!
    """
    true se un job fallito si può rimettere in coda con retryQueueJob. false
    per le code dei consumer di dominio (notification-service, sla-engine,
    escalation-consumer, service-impact-consumer): un evento di dominio
    esaurito non si rigioca dalla console, si ripubblica dall'azione di origine.
    """
    retryable: Boolean!
    counts: QueueJobCounts!
  }

  type QueueJob {
    id:           ID!
    name:         String!
    queueName:    String!
    status:       String!
    data:         String!
    timestamp:    String!
    processedOn:  String
    finishedOn:   String
    failedReason: String
    stacktrace:   [String!]!
    attemptsMade: Int!
    maxAttempts:  Int!
    returnValue:  String
  }

  # ── Audit Log ─────────────────────────────────────────────────────────────────

  type AuditEntry {
    id:         ID!
    userId:     String!
    userEmail:  String!
    action:     String!
    entityType: String!
    entityId:   String!
    details:    String
    ipAddress:  String
    createdAt:  String!
  }

  type AuditEntriesResult {
    items: [AuditEntry!]!
    total: Int!
  }

  "Un'azione presente nel registro di audit e quante voci la portano."
  type AuditActionCount {
    action: String!
    count:  Int!
  }
  `
}
