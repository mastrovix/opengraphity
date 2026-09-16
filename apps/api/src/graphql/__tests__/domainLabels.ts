/**
 * L'elenco delle label di dominio — quelle che portano `tenant_id` — in **un
 * posto solo**.
 *
 * `tenantScoping.test.ts` (come si legge) e `tenantOnCreate.test.ts` (come si
 * scrive) dichiaravano entrambi «stesso elenco dell'altro», e i due elenchi
 * erano già divergenti: `WorkflowStepExecution` e `Comment` solo nel secondo,
 * `CIFieldDefinition`/`CIRelationDefinition`/`CISystemRelationDefinition` solo
 * nel primo dopo l'ondata 8. Due liste che si dichiarano uguali e non lo sono
 * fanno un punto cieco a testa (D-18): da qui in avanti la lista è questa.
 *
 * I tipi del metamodello possono essere **condivisi** col tenant `system`: il
 * pattern ammesso in lettura è `WHERE x.tenant_id IN [$tenantId, 'system']`.
 */
export const DOMAIN_LABELS = [
  'Incident', 'Problem', 'Change', 'ServiceRequest', 'KBArticle',
  'Team', 'User', 'Role', 'SlackInstallation',
  'AssessmentTask', 'DeployPlanTask', 'ValidationTest', 'DeploymentTask', 'ReviewTask', 'ChangeApproval',
  'WorkflowInstance', 'WorkflowDefinition', 'WorkflowStep', 'WorkflowStepExecution',
  'NotificationChannel', 'NotificationRule', 'OutboundWebhook', 'InboundWebhook', 'ApiKey',
  'SyncSource', 'SyncRun',
  'ReportTemplate', 'ReportSection', 'ReportConversation', 'DashboardConfig', 'DashboardWidget', 'CustomWidget',
  'Anomaly', 'AnomalyConfig', 'AutoTrigger', 'BusinessRule', 'SLAPolicyNode', 'OLAContract', 'SLAStatus',
  'Attachment', 'EntityComment', 'Comment', 'AuditEntry', 'ApprovalRequest', 'InternalMessage', 'Notification',
  'CIGroup', 'ConfigurationItem',
  // Metamodello: i tipi, i loro campi, le loro relazioni. I tre in coda erano
  // il punto cieco dichiarato di D-18.
  'EnumTypeDefinition', 'CITypeDefinition',
  'CIFieldDefinition', 'CIRelationDefinition', 'CISystemRelationDefinition',
  'FieldVisibilityRule', 'FieldRequirementRule', 'TicketCIExclusion', 'ServiceCatalogItem', 'AssessmentQuestion',
  'Event', 'CIAlias', 'EventHistoryEntry',
  'ServiceMap', 'ServiceHealthEntry',
  /**
   * Le label trovate DAL VIVO sul grafo con `tenant_id` e non ancora
   * nell'elenco (revisione totale · A-20): nessuna verifica meccanica le
   * copriva, quindi un MATCH senza tenant su una di queste passava il lint.
   * Ricavate con `CALL db.labels()` + `n.tenant_id IS NOT NULL` su c-test.
   * I tipi CI concreti (Server, Database, Application…) NON stanno qui:
   * portano tutti `:ConfigurationItem`, che è già in elenco.
   */
  'ServiceCalendar', 'DomainMatrix', 'BusinessApplication', 'BusinessCapability',
  'AnomalyRuleConfig', 'AnswerOption', 'AssessmentResponse', 'ChangeAuditEntry',
  'ChangeCatalogCategory', 'StandardChangeCatalogEntry', 'KBArticleVersion',
  'ReportNode', 'ReportMessage', 'InAppNotification', 'TicketTeamSegment',
  'LogEntry', 'Counter',
  // Il conflitto della sincronizzazione e i record di cambiamento: il giro a
  // mano li aveva visti fuori elenco.
  'SyncConflict', 'SyncChangeRecord',
] as const
