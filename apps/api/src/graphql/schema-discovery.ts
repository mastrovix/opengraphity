export function discoverySDL(): string {
  return `
  # ── Discovery / Sync ──────────────────────────────────────────────────────────

  type SyncSource {
    id:                  ID!
    tenantId:            String!
    name:                String!
    connectorType:       String!
    config:              String!
    mappingRules:        String!
    scheduleCron:        String
    enabled:             Boolean!
    lastSyncAt:          String
    lastSyncStatus:      String
    lastSyncDurationMs:  Int
    createdAt:           String!
    updatedAt:           String!
  }

  type SyncRun {
    id:              ID!
    sourceId:        String!
    tenantId:        String!
    syncType:        String!
    status:          String!
    ciCreated:       Int!
    ciUpdated:       Int!
    ciUnchanged:     Int!
    ciStale:         Int!
    ciConflicts:     Int!
    relationsCreated: Int!
    relationsRemoved: Int!
    durationMs:      Float
    errorMessage:    String
    startedAt:       String!
    completedAt:     String
  }

  type SyncConflict {
    id:             ID!
    sourceId:       String!
    tenantId:       String!
    runId:          String!
    externalId:     String!
    ciType:         String!
    """locked_fields = un campo bloccato è cambiato alla sorgente; unknown_ci_type = il ci_type in arrivo non è un tipo di questo cliente, il CI NON è stato creato (ondata 6 · A-11)."""
    kind:           String!
    """Per unknown_ci_type: che cosa non si è risolto e cosa fare (creare il tipo, o aggiungere un alias nelle regole di mappatura)."""
    message:        String
    conflictFields: String!
    resolution:     String
    status:         String!
    discoveredCi:   String!
    existingCiId:   String!
    matchReason:    String!
    createdAt:      String!
    resolvedAt:     String
  }

  type SyncStats {
    totalSources:    Int!
    enabledSources:  Int!
    lastSyncAt:      String
    ciManaged:       Int!
    openConflicts:   Int!
    totalRuns:       Int!
    successRate:     Float!
  }

  type ConnectorInfo {
    type:            String!
    displayName:     String!
    supportedCITypes: [String!]!
    credentialFields: [ConnectorFieldDef!]!
    configFields:     [ConnectorFieldDef!]!
  }

  type ConnectorFieldDef {
    name:         String!
    label:        String!
    type:         String!
    required:     Boolean!
    placeholder:  String
    helpText:     String
    options:      [ConnectorFieldOption!]
    defaultValue: String
  }

  type ConnectorFieldOption {
    value: String!
    label: String!
  }

  type SyncRunsResult {
    items: [SyncRun!]!
    total: Int!
  }

  type SyncConflictsResult {
    items: [SyncConflict!]!
    total: Int!
  }

  type SyncConnectionTestResult {
    ok:      Boolean!
    message: String!
    details: String
  }

  type SyncChangeRecord {
    id:         ID!
    ciId:       String!
    sourceId:   String!
    tenantId:   String!
    changedAt:  String!
    changedFields: String!
    oldValues:  String!
    newValues:  String!
  }

  type SyncChangeRecordsResult {
    items: [SyncChangeRecord!]!
    total: Int!
  }

  input CreateSyncSourceInput {
    name:           String!
    connectorType:  String!
    credentials:    String!
    config:         String!
    mappingRules:   String
    scheduleCron:   String
    enabled:        Boolean
  }

  input UpdateSyncSourceInput {
    name:          String
    credentials:   String
    config:        String
    mappingRules:  String
    scheduleCron:  String
    enabled:       Boolean
  }
  `
}
