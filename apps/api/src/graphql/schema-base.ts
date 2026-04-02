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

    # Queue Stats (admin only)
    queueStats: [QueueStat!]!

    # Discovery / Sync
    syncSources: [SyncSource!]!
    syncSource(id: ID!): SyncSource
    syncRuns(sourceId: ID!, limit: Int, offset: Int, sortField: String, sortDirection: String): SyncRunsResult!
    syncConflicts(sourceId: ID, status: String, limit: Int, offset: Int): SyncConflictsResult!
    syncStats(sourceId: ID): SyncStats!
    availableConnectors: [ConnectorInfo!]!
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
    addAffectedCI(incidentId: ID!, ciId: ID!): Incident!
    removeAffectedCI(incidentId: ID!, ciId: ID!): Incident!

    # Problems
    createProblem(input: CreateProblemInput!): Problem!
    updateProblem(id: ID!, input: UpdateProblemInput!): Problem!
    deleteProblem(id: ID!): Boolean!
    linkIncidentToProblem(problemId: ID!, incidentId: ID!): Problem!
    unlinkIncidentFromProblem(problemId: ID!, incidentId: ID!): Problem!
    linkChangeToProblem(problemId: ID!, changeId: ID!): Problem!
    addCIToProblem(problemId: ID!, ciId: ID!): Problem!
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
    addAffectedCIToChange(changeId: ID!, ciId: ID!): Change!
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
    createITILField(typeId: ID!, input: ITILFieldInput!): CITypeDefinition!
    updateITILField(typeId: ID!, fieldId: ID!, input: ITILFieldInput!): CITypeDefinition!
    deleteITILField(typeId: ID!, fieldId: ID!): CITypeDefinition!

    # Discovery / Sync
    createSyncSource(input: CreateSyncSourceInput!): SyncSource!
    updateSyncSource(id: ID!, input: UpdateSyncSourceInput!): SyncSource!
    deleteSyncSource(id: ID!): Boolean!
    triggerSync(sourceId: ID!, syncType: String): SyncRun!
    resolveConflict(conflictId: ID!, resolution: String!): SyncConflict!
    testSyncConnection(sourceId: ID!): SyncConnectionTestResult!
  }

  # ── CMDB — interface & base types ────────────────────────────────────────────

  type CIRelation {
    ci: CIBase!
    relation: String!
  }

  interface CIBase {
    id: ID!
    name: String!
    type: String
    status: String
    environment: String
    description: String
    createdAt: String!
    updatedAt: String
    notes: String
    ownerGroup: Team
    supportGroup: Team
  }

  type AllCIsResult { items: [CIBase!]!, total: Int! }
  type BlastRadiusItem { ci: CIBase!, distance: Int!, parentId: String }

  # ── Metamodel types ──────────────────────────────────────────────────────────

  type CITypeDefinition {
    id: ID!
    name: String!
    label: String!
    icon: String
    color: String
    active: Boolean!
    validationScript: String
    fields: [CIFieldDef!]!
    relations: [CIRelationDef!]!
    systemRelations: [CISystemRelationDef!]!
  }

  type CIFieldDef {
    id: ID!
    name: String!
    label: String!
    fieldType: String!
    required: Boolean!
    defaultValue: String
    enumValues: [String!]!
    order: Int!
    validationScript: String
    visibilityScript: String
    defaultScript: String
    isSystem: Boolean!
  }

  type CIRelationDef {
    id: ID!
    name: String!
    label: String!
    relationshipType: String!
    targetType: String!
    cardinality: String!
    direction: String!
    order: Int!
  }

  type CISystemRelationDef {
    id: ID!
    name: String!
    label: String!
    relationshipType: String!
    targetEntity: String!
    required: Boolean!
    order: Int!
  }

  # ── Domain enums ─────────────────────────────────────────────────────────────
  # NOTE: IncidentSeverity, IncidentStatus, ChangeStatus, ChangeType, ChangePriority,
  # ProblemStatus, ProblemPriority, ServiceRequestStatus, ServiceRequestPriority
  # are generated at runtime from the ITIL metamodel (scope: 'itil') by the schema
  # generator. They are NOT hardcoded here — see loadITILTypes + generateITILEnumsSDL.

  # ── Incident ──────────────────────────────────────────────────────────────────

  type Incident {
    id: ID!
    tenantId: String!
    title: String!
    description: String
    severity: IncidentSeverity!
    status: IncidentStatus!
    createdAt: String!
    updatedAt: String!
    resolvedAt: String
    rootCause: String
    assignee: User
    assignedTeam: Team
    affectedCIs: [CIBase!]!
    causedByProblem: Problem
    workflowInstance:     WorkflowInstance
    workflowHistory:      [WorkflowStepExecution!]!
    availableTransitions: [WorkflowTransition!]!
    comments:             [Comment!]!
  }

  type Comment {
    id:        ID!
    text:      String!
    author:    User
    createdAt: String!
    updatedAt: String!
  }

  type Problem {
    id: ID!
    title: String!
    description: String
    priority: ProblemPriority!
    status: ProblemStatus!
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
    relatedIncidents: [Incident!]!
    relatedChanges: [Change!]!
    workflowInstance: WorkflowInstance
    availableTransitions: [WorkflowTransition!]!
    workflowHistory: [WorkflowStepExecution!]!
    comments: [ProblemComment!]!
  }

  type ProblemComment {
    id: ID!
    text: String!
    type: String!
    createdAt: String!
    updatedAt: String
    author: User
  }

  type ProblemsResult {
    items: [Problem!]!
    total: Int!
  }

  type Change {
    id:             ID!
    tenantId:       String!
    title:          String!
    description:    String
    type:           ChangeType!
    priority:       ChangePriority!
    status:         ChangeStatus!
    scheduledStart: String
    scheduledEnd:   String
    implementedAt:  String
    createdAt:      String!
    updatedAt:      String!
    assignedTeam:       Team
    assignee:           User
    affectedCIs:        [CIBase!]!
    relatedIncidents:   [Incident!]!
    changeTasks:        [ChangeTask!]!
    workflowInstance:   WorkflowInstance
    availableTransitions: [WorkflowTransition!]!
    workflowHistory:    [WorkflowStepExecution!]!
    createdBy:          User
    comments:           [ChangeComment!]!
    impactAnalysis:     ImpactAnalysis
  }

  type ImpactAnalysis {
    riskScore:     Int!
    riskLevel:     String!
    blastRadius:   [ImpactCI!]!
    openIncidents: [ImpactIncident!]!
    recentChanges: [ImpactChange!]!
    breakdown:     ImpactBreakdown!
  }

  type ImpactCI {
    id:          String!
    name:        String!
    type:        String!
    environment: String!
    distance:    Int!
  }

  type ImpactIncident {
    id:        String!
    title:     String!
    severity:  String!
    status:    String!
    ciName:    String!
    ciId:      String!
    createdAt: String!
    isOpen:    Boolean!
  }

  type ImpactChange {
    id:        String!
    title:     String!
    type:      String!
    status:    String!
    ciName:    String!
    ciId:      String!
    createdAt: String!
  }

  type ImpactBreakdown {
    productionCIs:  Int!
    blastRadiusCIs: Int!
    openIncidents:  Int!
    failedChanges:  Int!
    ongoingChanges: Int!
    scoreDetails:   String!
  }

  type ChangeComment {
    id:        ID!
    changeId:  String!
    text:      String!
    type:      String!
    createdBy: User
    createdAt: String!
  }

  type ChangeTask {
    id:                ID!
    taskType:          String!
    changeId:          String!
    status:            String!
    title:             String
    order:             Int
    description:       String
    notes:             String
    riskLevel:         String
    impactDescription: String
    mitigation:        String
    skipReason:        String
    completedAt:       String
    scheduledStart:    String
    scheduledEnd:      String
    durationDays:      Int
    hasValidation:     Boolean
    validationStatus:  String
    validationStart:   String
    validationEnd:     String
    validationNotes:   String
    type:              String
    rollbackPlan:      String
    createdAt:         String
    ci:                CIBase
    assignedTeam:      Team
    assignee:          User
    validationTeam:    Team
    validationUser:    User
  }

  type ServiceRequest {
    id: ID!
    tenantId: String!
    title: String!
    description: String
    status: ServiceRequestStatus!
    priority: ServiceRequestPriority!
    dueDate: String
    createdAt: String!
    updatedAt: String!
    completedAt: String
    requestedBy: User
    assignee: User
  }

  type Team {
    id: ID!
    tenantId: String!
    name: String!
    description: String
    type: String
    createdAt: String!
    members: [User!]!
    ownedCIs: [CIBase!]!
    supportedCIs: [CIBase!]!
  }

  type IncidentsResult {
    items: [Incident!]!
    total: Int!
  }

  type ChangesResult {
    items: [Change!]!
    total: Int!
  }

  type User {
    id: ID!
    tenantId: String!
    email: String!
    name: String!
    role: String!
    teamId: String
    slackId: String
    createdAt: String
    teams: [Team!]!
  }

  type NotificationChannel {
    id: ID!
    platform: String!
    name: String!
    webhookUrl: String
    channelId: String
    eventTypes: [String!]!
    active: Boolean!
    createdAt: String!
  }

  input UpdateTransitionInput {
    label:         String
    trigger:       String
    requiresInput: Boolean!
    inputField:    String
    condition:     String
    timerHours:    Int
  }

  input TransitionChangeInput {
    transitionId:  ID!
    label:         String
    trigger:       String
    requiresInput: Boolean!
    inputField:    String
    condition:     String
    timerHours:    Int
  }

  input StepPositionInput {
    stepId:    String!
    positionX: Float!
    positionY: Float!
  }

  input CreateNotificationChannelInput {
    platform: String!
    name: String!
    webhookUrl: String
    channelId: String
    eventTypes: [String!]!
  }

  input CreateIncidentInput {
    title: String!
    description: String
    severity: IncidentSeverity!
    affectedCIIds: [ID!]
  }

  input UpdateIncidentInput {
    title: String
    description: String
    severity: IncidentSeverity
    status: IncidentStatus
  }

  input CreateProblemInput {
    title: String!
    description: String
    priority: ProblemPriority!
    affectedCIs: [ID!]
    relatedIncidents: [ID!]
    workaround: String
  }

  input UpdateProblemInput {
    title: String
    description: String
    priority: ProblemPriority
    rootCause: String
    workaround: String
    affectedUsers: Int
  }

  input CreateChangeInput {
    title:              String!
    description:        String
    type:               ChangeType!
    priority:           ChangePriority!
    affectedCIIds:      [ID!]
    relatedIncidentIds: [ID!]
  }

  input CreateDeployStepInput {
    order:            Int!
    title:            String!
    description:      String
    scheduledStart:   String!
    durationDays:     Int!
    hasValidation:    Boolean!
    validationStart:  String
    validationEnd:    String
    assignedTeamId:   ID
    validationTeamId: ID
  }

  input UpdateChangeTaskInput {
    rollbackPlan: String
  }

  input UpdateAssessmentTaskInput {
    riskLevel:         String!
    impactDescription: String!
    mitigation:        String
    notes:             String
    assignedTeamId:    ID
    assignedUserId:    ID
  }

  input UpdateServiceRequestInput {
    title: String
    description: String
    status: ServiceRequestStatus
    priority: ServiceRequestPriority
    dueDate: String
  }

  input CreateServiceRequestInput {
    title: String!
    description: String
    priority: ServiceRequestPriority!
    dueDate: String
  }

  input CreateTeamInput {
    name: String!
    description: String
  }

  # ── Workflow types ─────────────────────────────────────────────────────────

  type WorkflowInstance {
    id:          ID!
    currentStep: String!
    status:      String!
    createdAt:   String!
    updatedAt:   String!
  }

  type WorkflowTransition {
    toStep:        String!
    label:         String!
    requiresInput: Boolean!
    inputField:    String
    condition:     String
  }

  type WorkflowStepExecution {
    id:          ID!
    stepName:    String!
    enteredAt:   String!
    exitedAt:    String
    durationMs:  Int
    triggeredBy: String!
    triggerType: String!
    notes:       String
  }

  type TransitionResult {
    success:  Boolean!
    error:    String
    instance: WorkflowInstance
  }

  type WorkflowStep {
    id:           ID!
    name:         String!
    label:        String!
    type:         String!
    enterActions: String
    exitActions:  String
  }

  type WorkflowTransitionDef {
    id:            ID!
    fromStepName:  String!
    toStepName:    String!
    trigger:       String!
    label:         String!
    requiresInput: Boolean!
    inputField:    String
    condition:     String
    timerHours:    Int
  }

  type WorkflowDefinition {
    id:          ID!
    name:        String!
    entityType:  String!
    version:     Int!
    active:      Boolean!
    steps:       [WorkflowStep!]!
    transitions: [WorkflowTransitionDef!]!
  }

  # ── Custom Report Templates ────────────────────────────────────────────────

  type ReportTemplate {
    id: ID!
    name: String!
    description: String
    icon: String
    visibility: String!
    createdBy: User
    sharedWith: [Team!]!
    sections: [ReportSection!]!
    scheduleEnabled: Boolean!
    scheduleCron: String
    scheduleChannelId: String
    createdAt: String!
    updatedAt: String
  }

  type ReportNode {
    id: ID!
    entityType: String!
    neo4jLabel: String!
    label: String!
    isResult: Boolean!
    isRoot: Boolean!
    positionX: Float!
    positionY: Float!
    filters: String
    selectedFields: [String!]!
  }

  type ReportEdge {
    id: ID!
    sourceNodeId: ID!
    targetNodeId: ID!
    relationshipType: String!
    direction: String!
    label: String!
  }

  type ReportSection {
    id: ID!
    order: Int!
    title: String!
    chartType: String!
    groupByNodeId: String
    groupByField: String
    metric: String!
    metricField: String
    limit: Int
    sortDir: String
    nodes: [ReportNode!]!
    edges: [ReportEdge!]!
  }

  type NavigableEntity {
    entityType: String!
    label: String!
    neo4jLabel: String!
    fields: [NavigableField!]!
    relations: [NavigableRelation!]!
  }

  type ReachableEntity {
    entityType: String!
    label: String!
    neo4jLabel: String!
    relationshipType: String!
    direction: String!
    count: Int!
    fields: [NavigableField!]!
  }

  type NavigableField {
    name: String!
    label: String!
    fieldType: String!
    enumValues: [String!]!
  }

  type NavigableRelation {
    relationshipType: String!
    direction: String!
    label: String!
    targetEntityType: String!
    targetLabel: String!
    targetNeo4jLabel: String!
  }

  type ReportResult {
    sections: [ReportSectionResult!]!
  }

  type ReportSectionResult {
    sectionId: ID!
    title: String!
    chartType: String!
    data: String!
    total: Int
    error: String
  }

  input CreateReportTemplateInput {
    name: String!
    description: String
    icon: String
    visibility: String!
    sharedWithTeamIds: [ID!]
    scheduleEnabled: Boolean
    scheduleCron: String
    scheduleChannelId: String
  }

  input UpdateReportTemplateInput {
    name: String
    description: String
    icon: String
    visibility: String
    sharedWithTeamIds: [ID!]
    scheduleEnabled: Boolean
    scheduleCron: String
    scheduleChannelId: String
  }

  input ReportNodeInput {
    id: String!
    entityType: String!
    neo4jLabel: String!
    label: String!
    isResult: Boolean!
    isRoot: Boolean!
    positionX: Float!
    positionY: Float!
    filters: String
    selectedFields: [String!]
  }

  input ReportEdgeInput {
    id: String!
    sourceNodeId: String!
    targetNodeId: String!
    relationshipType: String!
    direction: String!
    label: String!
  }

  input ReportSectionInput {
    title: String!
    chartType: String!
    groupByNodeId: String
    groupByField: String
    metric: String!
    metricField: String
    limit: Int
    sortDir: String
    nodes: [ReportNodeInput!]!
    edges: [ReportEdgeInput!]!
  }

  # ── AI Report Conversations ────────────────────────────────────────────────

  type ReportConversation {
    id:        ID!
    title:     String!
    createdAt: String!
    updatedAt: String!
    messages:  [ReportMessage!]!
  }

  type ReportMessage {
    id:        ID!
    role:      String!
    content:   String!
    createdAt: String!
  }

  type AskReportResult {
    message:        ReportMessage!
    conversationId: ID!
  }

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

  # ── Dashboard Configuration ────────────────────────────────────────────────

  type DashboardConfig {
    id: ID!
    name: String!
    isDefault: Boolean!
    isPersonal: Boolean!
    visibility: String!
    createdBy: User
    sharedWith: [Team!]!
    createdAt: String!
    updatedAt: String
    widgets: [DashboardWidget!]!
  }

  type DashboardWidget {
    id: ID!
    order: Int!
    colSpan: Int!
    reportTemplateId: ID!
    reportSectionId: ID!
    reportTemplate: ReportTemplate
    reportSection: ReportSection
    data: String
    error: String
  }

  input CreateDashboardInput {
    name: String!
    visibility: String!
    sharedWithTeamIds: [ID!]
  }

  input UpdateDashboardInput {
    name: String
    visibility: String
    sharedWithTeamIds: [ID!]
    isDefault: Boolean
  }

  input AddDashboardWidgetInput {
    dashboardId: ID!
    reportTemplateId: ID!
    reportSectionId: ID!
    colSpan: Int!
    order: Int
  }

  input UpdateDashboardWidgetInput {
    colSpan: Int
    order: Int
  }

  # ── Anomaly Detection ──────────────────────────────────────────────────────

  enum ResolutionStatus {
    resolved
    false_positive
    accepted_risk
  }

  type Anomaly {
    id:               ID!
    ruleKey:          String!
    title:            String!
    severity:         String!
    status:           String!
    entityId:         String!
    entityType:       String!
    entitySubtype:    String!
    entityName:       String!
    description:      String!
    detectedAt:       String!
    resolvedAt:       String
    resolutionStatus: String
    resolutionNote:   String
    resolvedBy:       String
    tenantId:         String!
  }

  type AnomaliesResult {
    items: [Anomaly!]!
    total: Int!
  }

  type AnomalyStats {
    total:         Int!
    open:          Int!
    critical:      Int!
    high:          Int!
    medium:        Int!
    low:           Int!
    falsePositive: Int!
    acceptedRisk:  Int!
  }

  type AnomalyScanStatus {
    lastScanAt:  String
    totalScans:  Int!
  }

  type TopologyNode {
    id:            ID!
    name:          String!
    type:          String!
    status:        String!
    environment:   String
    ownerGroup:    String
    incidentCount: Int!
    changeCount:   Int!
  }

  type TopologyEdge {
    source: ID!
    target: ID!
    type:   String!
  }

  type TopologyData {
    nodes:     [TopologyNode!]!
    edges:     [TopologyEdge!]!
    truncated: Boolean!
  }

  type NotificationRule {
    id:               ID!
    eventType:        String!
    enabled:          Boolean!
    severityOverride: String!
    titleKey:         String!
    channels:         [String!]!
    target:           String!
    conditions:       String
    isSeed:           Boolean!
  }

  input CreateNotificationRuleInput {
    eventType:        String!
    enabled:          Boolean
    severityOverride: String
    titleKey:         String!
    channels:         [String!]!
    target:           String!
  }

  input UpdateNotificationRuleInput {
    enabled:          Boolean
    severityOverride: String
    channels:         [String!]
    target:           String
  }

  input ITILFieldInput {
    name:        String!
    label:       String!
    fieldType:   String!
    required:    Boolean
    enumValues:  [String!]
    order:       Int
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
    durationMs:      Int
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
