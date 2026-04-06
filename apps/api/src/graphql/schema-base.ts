import { cmdbSDL } from './schema-common.js'
import { enumTypeSDL } from './schema-enum.js'
import { incidentSDL } from './schema-incident.js'
import { problemSDL } from './schema-problem.js'
import { changeSDL } from './schema-change.js'
import { serviceRequestSDL } from './schema-service-request.js'
import { userTeamSDL } from './schema-user-team.js'
import { workflowSDL } from './schema-workflow.js'
import { notificationSDL } from './schema-notification.js'
import { reportSDL } from './schema-report.js'
import { dashboardSDL } from './schema-dashboard.js'
import { anomalySDL } from './schema-anomaly.js'
import { topologySDL } from './schema-topology.js'
import { discoverySDL } from './schema-discovery.js'
import { adminSDL } from './schema-admin.js'
import { monitoringSDL } from './schema-monitoring.js'
import { approvalSDL } from './schema-approval.js'
import { attachmentsSDL } from './schema-attachments.js'
import { commentsSDL } from './schema-comments.js'
import { knowledgeBaseSDL } from './schema-kb.js'
import { portalSDL } from './schema-portal.js'
import { fieldRulesSDL } from './schema-fieldRules.js'

export function buildBaseSDL(): string {
  return `#graphql

  type Query {
    # Incidents
    incidents(status: String, severity: String, limit: Int, offset: Int, filters: String, sortField: String, sortDirection: String): IncidentsResult!
    incident(id: ID!): Incident

    # Problems
    problems(limit: Int, offset: Int, status: String, priority: String, search: String, filters: String, sortField: String, sortDirection: String): ProblemsResult!
    problem(id: ID!): Problem

    # Changes
    changes(status: String, type: String, priority: String, search: String, limit: Int, offset: Int, filters: String, sortField: String, sortDirection: String): ChangesResult!
    change(id: ID!): Change
    changeTasks(changeId: ID!, taskType: String): [ChangeTask!]!
    changeImpactAnalysis(ciIds: [ID!]!): ImpactAnalysis!

    # Service Requests
    serviceRequests(status: String, priority: String, limit: Int, offset: Int, filters: String): [ServiceRequest!]!
    serviceRequest(id: ID!): ServiceRequest

    # CMDB — generic queries (typed CI queries come from dynamic schema)
    allCIs(limit: Int, offset: Int, type: String, environment: String, status: String, search: String, filters: String, sortField: String, sortDirection: String): AllCIsResult!
    ciById(id: ID!): CIBase
    blastRadius(id: ID!): [BlastRadiusItem!]!
    ciIncidents(ciId: ID!): [Incident!]!
    ciChanges(ciId: ID!): [Change!]!
    baseCIType: CITypeDefinition!
    ciTypes: [CITypeDefinition!]!
    itilTypes: [CITypeDefinition!]!
    itilTypeFields(typeId: ID!): [CIFieldDef!]!

    # Teams
    teams(filters: String): [Team!]!
    team(id: ID!): Team

    # Users
    me: User
    users: [User!]!
    user(id: ID!): User

    # Notification Channels
    notificationChannels: [NotificationChannel!]!

    # Notification Rules
    notificationRules: [NotificationRule!]!

    # Reports (AI conversations)
    reportConversations: [ReportConversation!]!
    reportConversation(id: ID!): ReportConversation

    # Custom Report Templates
    reportTemplates: [ReportTemplate!]!
    reportTemplate(id: ID!): ReportTemplate
    navigableEntities: [NavigableEntity!]!
    navigableRelations(entityType: String!, neo4jLabel: String!): [NavigableRelation!]!
    reachableEntities(fromNeo4jLabel: String!): [ReachableEntity!]!
    executeReport(templateId: ID!): ReportResult!
    previewReportSection(input: ReportSectionInput!): ReportSectionResult!

    # Dashboard
    myDashboards: [DashboardConfig!]!
    dashboard(id: ID!): DashboardConfig

    # Logs
    logs(level: String, module: String, search: String, limit: Int, offset: Int, filters: String): LogsResult!

    # Anomaly Detection
    anomalies(status: String, severity: String, ruleKey: String, limit: Int, offset: Int, filters: String, sortField: String, sortDirection: String): AnomaliesResult!
    anomaly(id: ID!): Anomaly
    anomalyStats: AnomalyStats!
    anomalyScanStatus: AnomalyScanStatus!

    # Topology
    topology(types: [String!], environment: String, status: String, selectedCiId: ID, maxHops: Int): TopologyData!

    # Workflow
    incidentWorkflow(incidentId: ID!): WorkflowInstance
    incidentWorkflowHistory(incidentId: ID!): [WorkflowStepExecution!]!
    incidentAvailableTransitions(incidentId: ID!): [WorkflowTransition!]!
    workflowDefinition(entityType: String!): WorkflowDefinition
    workflowDefinitionById(id: ID!): WorkflowDefinition
    workflowDefinitions(entityType: String): [WorkflowDefinition!]!

    # Enum Types
    enumTypes(scope: String): [EnumTypeDefinition!]!
    enumType(id: ID!): EnumTypeDefinition

    # Queue Stats (admin only)
    queueStats: [QueueStat!]!
    queueJobs(queueName: String!, status: String, limit: Int): [QueueJob!]!

    # Monitoring (admin only)
    systemHealth:  SystemHealth!
    systemMetrics: SystemMetrics!
    traceInfo:     TraceInfo!

    # Audit Log (admin only)
    auditLog(page: Int, pageSize: Int, action: String, entityType: String, fromDate: String, toDate: String): AuditEntriesResult!

    # Approval Workflow
    approvalRequests(status: String, entityType: String, page: Int, pageSize: Int): ApprovalRequestsResult!
    myPendingApprovals: [ApprovalRequest!]!

    # Attachments
    attachments(entityType: String!, entityId: String!): [Attachment!]!

    # Comments
    comments(entityType: String!, entityId: String!, includeInternal: Boolean): [EntityComment!]!

    # Knowledge Base
    kbArticles(search: String, category: String, status: String, page: Int, pageSize: Int): KBArticlesResult!
    kbArticle(id: ID!): KBArticle!
    kbArticleBySlug(slug: String!): KBArticle!
    kbCategories: [KBCategory!]!

    # Portal (Self-Service)
    myTickets(status: String, page: Int, pageSize: Int): MyTicketsResult!
    myTicket(id: ID!): MyTicketDetail!
    myTicketStats: MyTicketStats!

    # Field Rules (admin)
    fieldVisibilityRules(entityType: String!): [FieldVisibilityRule!]!
    fieldRequirementRules(entityType: String!, workflowStep: String): [FieldRequirementRule!]!

    # ITIL-CI Relation Rules
    itilCIRelationRules(itilType: String!): [ITILCIRelationRule!]!
    allITILCIRelationRules: [ITILCIRelationRule!]!

    # Discovery / Sync
    syncSources: [SyncSource!]!
    syncSource(id: ID!): SyncSource
    syncRuns(sourceId: ID!, limit: Int, offset: Int, sortField: String, sortDirection: String): SyncRunsResult!
    syncConflicts(sourceId: ID, status: String, limit: Int, offset: Int): SyncConflictsResult!
    syncStats(sourceId: ID): SyncStats!
    availableConnectors: [ConnectorInfo!]!
    syncChangeHistory(ciId: ID!, limit: Int, offset: Int): SyncChangeRecordsResult!
  }

  type AuthPayload {
    token:     String!
    expiresAt: String!
    user:      User!
  }

  type Mutation {
    # Auth
    login(email: String!, password: String!): AuthPayload!

    # Incidents
    createIncident(input: CreateIncidentInput!): Incident!
    updateIncident(id: ID!, input: UpdateIncidentInput!): Incident!
    resolveIncident(id: ID!, rootCause: String): Incident!
    assignIncidentToTeam(id: ID!, teamId: ID!): Incident!
    assignIncidentToUser(id: ID!, userId: ID): Incident!
    addIncidentComment(id: ID!, text: String!): Comment!
    addAffectedCI(incidentId: ID!, ciId: ID!, relationType: String): Incident!
    removeAffectedCI(incidentId: ID!, ciId: ID!): Incident!

    # Problems
    createProblem(input: CreateProblemInput!): Problem!
    updateProblem(id: ID!, input: UpdateProblemInput!): Problem!
    deleteProblem(id: ID!): Boolean!
    linkIncidentToProblem(problemId: ID!, incidentId: ID!): Problem!
    unlinkIncidentFromProblem(problemId: ID!, incidentId: ID!): Problem!
    linkChangeToProblem(problemId: ID!, changeId: ID!): Problem!
    addCIToProblem(problemId: ID!, ciId: ID!, relationType: String): Problem!
    removeCIFromProblem(problemId: ID!, ciId: ID!): Problem!
    assignProblemToTeam(problemId: ID!, teamId: ID!): Problem!
    assignProblemToUser(problemId: ID!, userId: ID!): Problem!
    executeProblemTransition(problemId: ID!, toStep: String!, notes: String): Problem!
    addProblemComment(problemId: ID!, text: String!): ProblemComment!

    # Changes
    createChange(input: CreateChangeInput!): Change!
    approveChange(id: ID!): Change!
    rejectChange(id: ID!, reason: String!): Change!
    deployChange(id: ID!): Change!
    failChange(id: ID!, reason: String!): Change!
    addAffectedCIToChange(changeId: ID!, ciId: ID!, relationType: String): Change!
    removeAffectedCIFromChange(changeId: ID!, ciId: ID!, reason: String!): Change!
    addChangeComment(changeId: ID!, text: String!): ChangeComment!
    saveDeploySteps(changeId: ID!, steps: [CreateDeployStepInput!]!): Change!
    saveChangeValidation(changeId: ID!, scheduledStart: String!, scheduledEnd: String!): Change!
    updateChangeTask(id: ID!, input: UpdateChangeTaskInput!): ChangeTask!
    updateAssessmentTask(taskId: ID!, input: UpdateAssessmentTaskInput!): ChangeTask!
    completeAssessmentTask(taskId: ID!, input: UpdateAssessmentTaskInput!): ChangeTask!
    rejectAssessmentTask(taskId: ID!, reason: String!): ChangeTask!
    assignDeployStepToTeam(stepId: ID!, teamId: ID!): ChangeTask!
    assignDeployStepToUser(stepId: ID!, userId: ID!): ChangeTask!
    assignDeployStepValidationTeam(stepId: ID!, teamId: ID!): ChangeTask!
    assignDeployStepValidationUser(stepId: ID!, userId: ID!): ChangeTask!
    updateDeployStepStatus(stepId: ID!, status: String!, notes: String, skipReason: String): ChangeTask!
    updateDeployStepValidation(stepId: ID!, status: String!, notes: String): ChangeTask!
    executeChangeTransition(instanceId: ID!, toStep: String!, notes: String): TransitionResult!
    completeChangeValidation(changeId: ID!, notes: String): ChangeTask!
    failChangeValidation(changeId: ID!): ChangeTask!
    assignAssessmentTaskTeam(taskId: ID!, teamId: ID!): ChangeTask!
    assignAssessmentTaskUser(taskId: ID!, userId: ID!): ChangeTask!

    # Service Requests
    createServiceRequest(input: CreateServiceRequestInput!): ServiceRequest!
    updateServiceRequest(id: ID!, input: UpdateServiceRequestInput!): ServiceRequest!
    completeServiceRequest(id: ID!): ServiceRequest!

    # Teams
    createTeam(input: CreateTeamInput!): Team!
    assignCIOwner(ciId: ID!, teamId: ID!): CIBase!
    assignCISupportGroup(ciId: ID!, teamId: ID!): CIBase!

    # Workflow
    addWorkflowStep(
      definitionId:      ID!
      name:              String!
      label:             String!
      type:              String!
      timerDelayMinutes: Int
      subWorkflowId:     String
    ): WorkflowDefinition!

    removeWorkflowStep(
      definitionId: ID!
      stepName:     String!
    ): WorkflowDefinition!

    updateWorkflowStep(
      definitionId: ID!
      stepName:     String!
      label:        String!
      enterActions: String
      exitActions:  String
    ): WorkflowStep!

    updateWorkflowTransition(
      definitionId: ID!
      transitionId: ID!
      input:        UpdateTransitionInput!
    ): WorkflowDefinition!

    saveWorkflowLayout(
      definitionId: ID!
      positions:    [StepPositionInput!]!
    ): Boolean!

    saveWorkflowChanges(
      definitionId: ID!
      transitions:  [TransitionChangeInput!]!
      positions:    [StepPositionInput!]!
    ): WorkflowDefinition!

    executeWorkflowTransition(
      instanceId: ID!
      toStep: String!
      notes: String
    ): TransitionResult!

    # Notification Channels
    createNotificationChannel(input: CreateNotificationChannelInput!): NotificationChannel!
    updateNotificationChannel(id: ID!, input: CreateNotificationChannelInput!): NotificationChannel!
    deleteNotificationChannel(id: ID!): Boolean!

    createNotificationRule(input: CreateNotificationRuleInput!): NotificationRule!
    updateNotificationRule(id: ID!, input: UpdateNotificationRuleInput!): NotificationRule!
    deleteNotificationRule(id: ID!): Boolean!
    testNotificationChannel(id: ID!): Boolean!

    # Slack account linking
    linkSlackAccount(slackId: String!): User!

    # Reports (AI conversations)
    askReport(question: String!, conversationId: ID): AskReportResult!
    deleteReportConversation(id: ID!): Boolean!

    # Custom Report Templates
    createReportTemplate(input: CreateReportTemplateInput!): ReportTemplate!
    updateReportTemplate(id: ID!, input: UpdateReportTemplateInput!): ReportTemplate!
    deleteReportTemplate(id: ID!): Boolean!
    addReportSection(templateId: ID!, input: ReportSectionInput!): ReportTemplate!
    updateReportSection(sectionId: ID!, input: ReportSectionInput!): ReportTemplate!
    removeReportSection(templateId: ID!, sectionId: ID!): ReportTemplate!
    reorderReportSections(templateId: ID!, sectionIds: [ID!]!): ReportTemplate!

    # Dashboard
    createDashboard(input: CreateDashboardInput!): DashboardConfig!
    updateDashboard(id: ID!, input: UpdateDashboardInput!): DashboardConfig!
    deleteDashboard(id: ID!): Boolean!
    addDashboardWidget(input: AddDashboardWidgetInput!): DashboardConfig!
    removeDashboardWidget(widgetId: ID!): DashboardConfig!
    updateDashboardWidget(widgetId: ID!, input: UpdateDashboardWidgetInput!): DashboardConfig!
    reorderDashboardWidgets(dashboardId: ID!, widgetIds: [ID!]!): DashboardConfig!

    # Anomaly Detection
    resolveAnomaly(id: ID!, resolutionStatus: ResolutionStatus!, note: String!): Anomaly!
    runAnomalyScanner: Boolean!

    # ITIL Designer
    updateITILType(id: ID!, input: UpdateITILTypeInput!): CITypeDefinition!
    createITILField(typeId: ID!, input: ITILFieldInput!): CITypeDefinition!
    updateITILField(typeId: ID!, fieldId: ID!, input: ITILFieldInput!): CITypeDefinition!
    deleteITILField(typeId: ID!, fieldId: ID!): CITypeDefinition!

    # ITIL-CI Relation Rules
    createITILCIRelationRule(itilType: String!, ciType: String!, relationType: String!, direction: String!, description: String): ITILCIRelationRule!
    deleteITILCIRelationRule(id: ID!): Boolean!

    # Discovery / Sync
    createSyncSource(input: CreateSyncSourceInput!): SyncSource!
    updateSyncSource(id: ID!, input: UpdateSyncSourceInput!): SyncSource!
    deleteSyncSource(id: ID!): Boolean!
    triggerSync(sourceId: ID!, syncType: String): SyncRun!
    resolveConflict(conflictId: ID!, resolution: String!): SyncConflict!
    testSyncConnection(sourceId: ID!): SyncConnectionTestResult!

    # Enum Types
    createEnumType(input: CreateEnumTypeInput!): EnumTypeDefinition!
    updateEnumType(id: ID!, input: UpdateEnumTypeInput!): EnumTypeDefinition!
    deleteEnumType(id: ID!): Boolean!

    # Approval Workflow
    createApprovalRequest(entityType: String!, entityId: String!, title: String!, description: String, approvers: [String!]!, approvalType: String, dueDate: String): ApprovalRequest!
    approveRequest(id: ID!, note: String): ApprovalRequest!
    rejectRequest(id: ID!, note: String!): ApprovalRequest!
    cancelApprovalRequest(id: ID!): ApprovalRequest!

    # Attachments
    deleteAttachment(id: ID!): Boolean!

    # Comments
    addComment(entityType: String!, entityId: String!, body: String!, isInternal: Boolean): EntityComment!
    updateComment(id: ID!, body: String!): EntityComment!
    deleteComment(id: ID!): Boolean!

    # Knowledge Base
    createKBArticle(title: String!, body: String!, category: String!, tags: [String!], status: String): KBArticle!
    updateKBArticle(id: ID!, title: String, body: String, category: String, tags: [String!]): KBArticle!
    deleteKBArticle(id: ID!): Boolean!
    rateKBArticle(id: ID!, helpful: Boolean!): KBArticle!

    # Queue Jobs (admin only)
    retryQueueJob(queueName: String!, jobId: ID!): Boolean!

    # Report Export
    exportReportPDF(templateId: ID!): String!
    exportReportExcel(templateId: ID!): String!

    # Field Rules (admin)
    createFieldVisibilityRule(entityType: String!, triggerField: String!, triggerValue: String!, targetField: String!, action: String!): FieldVisibilityRule!
    updateFieldVisibilityRule(id: ID!, triggerField: String, triggerValue: String, targetField: String, action: String): FieldVisibilityRule!
    deleteFieldVisibilityRule(id: ID!): Boolean!
    setFieldRequirement(entityType: String!, fieldName: String!, required: Boolean!, workflowStep: String): FieldRequirementRule!
    deleteFieldRequirement(id: ID!): Boolean!

    # Portal (Self-Service)
    createTicket(title: String!, description: String, priority: String, category: String!): MyTicket!
    addTicketComment(ticketId: ID!, body: String!): EntityComment!
    reopenTicket(ticketId: ID!): MyTicket!
  }

  # ── Domain enums ─────────────────────────────────────────────────────────────
  # NOTE: IncidentSeverity, IncidentStatus, ChangeStatus, ChangeType, ChangePriority,
  # ProblemStatus, ProblemPriority, ServiceRequestStatus, ServiceRequestPriority
  # are generated at runtime from the ITIL metamodel (scope: 'itil') by the schema
  # generator. They are NOT hardcoded here — see loadITILTypes + generateITILEnumsSDL.

  ${incidentSDL()}
  ${problemSDL()}
  ${changeSDL()}
  ${serviceRequestSDL()}
  ${userTeamSDL()}
  ${workflowSDL()}
  ${notificationSDL()}
  ${reportSDL()}
  ${dashboardSDL()}
  ${anomalySDL()}
  ${topologySDL()}
  ${discoverySDL()}
  ${adminSDL()}
  ${monitoringSDL()}
  ${cmdbSDL()}
  ${enumTypeSDL()}
  ${approvalSDL()}
  ${attachmentsSDL()}
  ${commentsSDL()}
  ${knowledgeBaseSDL()}
  ${portalSDL()}
  ${fieldRulesSDL()}
  `
}
