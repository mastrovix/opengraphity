export function buildBaseSDL(): string {
  return `#graphql

  type Query {
    # Incidents
    incidents(status: String, severity: String, limit: Int, offset: Int): IncidentsResult!
    incident(id: ID!): Incident

    # Problems
    problems(status: String, limit: Int, offset: Int): [Problem!]!
    problem(id: ID!): Problem

    # Changes
    changes(status: String, type: String, priority: String, search: String, limit: Int, offset: Int): ChangesResult!
    change(id: ID!): Change
    changeImpactAnalysis(ciIds: [ID!]!): ImpactAnalysis!

    # Service Requests
    serviceRequests(status: String, priority: String, limit: Int, offset: Int): [ServiceRequest!]!
    serviceRequest(id: ID!): ServiceRequest

    # CMDB — generic queries (typed CI queries come from dynamic schema)
    allCIs(limit: Int, offset: Int, type: String, environment: String, status: String, search: String): AllCIsResult!
    ciById(id: ID!): CIBase
    blastRadius(id: ID!): [BlastRadiusItem!]!
    ciIncidents(ciId: ID!): [Incident!]!
    ciChanges(ciId: ID!): [Change!]!
    baseCIType: CITypeDefinition!
    ciTypes: [CITypeDefinition!]!

    # Teams
    teams: [Team!]!
    team(id: ID!): Team

    # Users
    me: User
    users: [User!]!
    user(id: ID!): User

    # Notification Channels
    notificationChannels: [NotificationChannel!]!

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

    # Logs
    logs(level: String, module: String, search: String, limit: Int, offset: Int): LogsResult!

    # Workflow
    incidentWorkflow(incidentId: ID!): WorkflowInstance
    incidentWorkflowHistory(incidentId: ID!): [WorkflowStepExecution!]!
    incidentAvailableTransitions(incidentId: ID!): [WorkflowTransition!]!
    workflowDefinition(entityType: String!): WorkflowDefinition
    workflowDefinitionById(id: ID!): WorkflowDefinition
    workflowDefinitions(entityType: String): [WorkflowDefinition!]!
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
    resolveProblem(id: ID!, resolution: String!): Problem!
    linkIncidentToProblem(incidentId: ID!, problemId: ID!): Problem!

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
    updateAssessmentTask(taskId: ID!, input: UpdateAssessmentTaskInput!): AssessmentTask!
    completeAssessmentTask(taskId: ID!, input: UpdateAssessmentTaskInput!): AssessmentTask!
    rejectAssessmentTask(taskId: ID!, reason: String!): AssessmentTask!
    assignDeployStepToTeam(stepId: ID!, teamId: ID!): DeployStep!
    assignDeployStepToUser(stepId: ID!, userId: ID!): DeployStep!
    assignDeployStepValidationTeam(stepId: ID!, teamId: ID!): DeployStep!
    assignDeployStepValidationUser(stepId: ID!, userId: ID!): DeployStep!
    updateDeployStepStatus(stepId: ID!, status: String!, notes: String, skipReason: String): DeployStep!
    updateDeployStepValidation(stepId: ID!, status: String!, notes: String): DeployStep!
    executeChangeTransition(instanceId: ID!, toStep: String!, notes: String): TransitionResult!
    completeChangeValidation(changeId: ID!, notes: String): ChangeValidation!
    failChangeValidation(changeId: ID!): ChangeValidation!
    assignAssessmentTaskTeam(taskId: ID!, teamId: ID!): AssessmentTask!
    assignAssessmentTaskUser(taskId: ID!, userId: ID!): AssessmentTask!

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
    ): WorkflowStep!

    updateWorkflowTransition(
      definitionId:  ID!
      transitionId:  ID!
      label:         String!
      requiresInput: Boolean!
      inputField:    String
    ): WorkflowTransitionDef!

    executeWorkflowTransition(
      instanceId: ID!
      toStep: String!
      notes: String
    ): TransitionResult!

    # Notification Channels
    createNotificationChannel(input: CreateNotificationChannelInput!): NotificationChannel!
    updateNotificationChannel(id: ID!, input: CreateNotificationChannelInput!): NotificationChannel!
    deleteNotificationChannel(id: ID!): Boolean!
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
  }

  # ── CMDB — interface & base types ────────────────────────────────────────────

  type CIRelation {
    ci: CIBase!
    relation: String!
  }

  interface CIBase {
    id: ID!
    name: String!
    type: String!
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

  # ── Incident ──────────────────────────────────────────────────────────────────

  type Incident {
    id: ID!
    tenantId: String!
    title: String!
    description: String
    severity: String!
    status: String!
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
    tenantId: String!
    title: String!
    description: String
    status: String!
    impact: String!
    rootCause: String
    workaround: String
    createdAt: String!
    updatedAt: String!
    resolvedAt: String
    relatedIncidents: [Incident!]!
    resolvedByChange: Change
  }

  type Change {
    id:             ID!
    tenantId:       String!
    title:          String!
    description:    String
    type:           String!
    priority:       String!
    status:         String!
    rollbackPlan:   String!
    scheduledStart: String
    scheduledEnd:   String
    implementedAt:  String
    createdAt:      String!
    updatedAt:      String!
    assignedTeam:       Team
    assignee:           User
    affectedCIs:        [CIBase!]!
    relatedIncidents:   [Incident!]!
    deploySteps:        [DeployStep!]!
    assessmentTasks:    [AssessmentTask!]!
    validation:         ChangeValidation
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

  type DeployStep {
    id:               ID!
    changeId:         String!
    order:            Int!
    title:            String!
    description:      String
    status:           String!
    scheduledStart:   String!
    durationDays:     Int!
    scheduledEnd:     String!
    hasValidation:    Boolean!
    validationStart:  String
    validationEnd:    String
    validationStatus: String
    validationNotes:  String
    skipReason:       String
    notes:            String
    completedAt:      String
    createdAt:        String!
    assignedTeam:     Team
    assignee:         User
    validationTeam:   Team
    validationUser:   User
  }

  type AssessmentTask {
    id:                ID!
    changeId:          String!
    status:            String!
    riskLevel:         String
    impactDescription: String
    mitigation:        String
    notes:             String
    completedAt:       String
    createdAt:         String!
    ci:                CIBase
    assignedTeam:      Team
    assignee:          User
  }

  type ChangeValidation {
    id:             ID!
    changeId:       String!
    type:           String!
    scheduledStart: String!
    scheduledEnd:   String!
    status:         String!
    notes:          String
    completedAt:    String
    assignedTeam:   Team
    assignee:       User
  }

  type ServiceRequest {
    id: ID!
    tenantId: String!
    title: String!
    description: String
    status: String!
    priority: String!
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
    severity: String!
    affectedCIIds: [ID!]
  }

  input UpdateIncidentInput {
    title: String
    description: String
    severity: String
    status: String
  }

  input CreateProblemInput {
    title: String!
    description: String
    impact: String!
  }

  input UpdateProblemInput {
    title: String
    description: String
    status: String
    rootCause: String
    workaround: String
  }

  input CreateChangeInput {
    title:              String!
    description:        String
    type:               String!
    priority:           String!
    rollbackPlan:       String!
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
    status: String
    priority: String
    dueDate: String
  }

  input CreateServiceRequestInput {
    title: String!
    description: String
    priority: String!
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
`
}
