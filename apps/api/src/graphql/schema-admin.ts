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

  type QueueStat {
    name:   String!
    counts: QueueJobCounts!
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
  `
}
