export const typeDefs = `#graphql

  type Query {
    # Incidents
    incidents(status: String, severity: String, limit: Int, offset: Int): [Incident!]!
    incident(id: ID!): Incident

    # Problems
    problems(status: String, limit: Int, offset: Int): [Problem!]!
    problem(id: ID!): Problem

    # Changes
    changes(status: String, type: String, limit: Int, offset: Int): [Change!]!
    change(id: ID!): Change
    changeImpactAnalysis(ciIds: [ID!]!): ImpactAnalysis!

    # Service Requests
    serviceRequests(status: String, priority: String, limit: Int, offset: Int): [ServiceRequest!]!
    serviceRequest(id: ID!): ServiceRequest

    # CMDB
    configurationItems(type: String, search: String, limit: Int, offset: Int): [ConfigurationItem!]!
    configurationItem(id: ID!): ConfigurationItem
    blastRadius(ciId: ID!, depth: Int): [ConfigurationItem!]!

    # Teams
    teams: [Team!]!
    team(id: ID!): Team

    # Users
    me: User
    users: [User!]!

    # Workflow
    incidentWorkflow(incidentId: ID!): WorkflowInstance
    incidentWorkflowHistory(incidentId: ID!): [WorkflowStepExecution!]!
    incidentAvailableTransitions(incidentId: ID!): [WorkflowTransition!]!
    workflowDefinition(entityType: String!): WorkflowDefinition
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
    assignIncidentToUser(id: ID!, userId: ID!): Incident!
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

    # CMDB
    createConfigurationItem(input: CreateCIInput!): ConfigurationItem!
    updateConfigurationItem(id: ID!, input: UpdateCIInput!): ConfigurationItem!
    updateCIFields(id: ID!, input: UpdateCIFieldsInput!): ConfigurationItem!
    addCIDependency(fromId: ID!, toId: ID!, type: String!): Boolean!

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

    # Teams
    createTeam(input: CreateTeamInput!): Team!
    assignCIOwner(ciId: ID!, teamId: ID!): ConfigurationItem!
    assignCISupportGroup(ciId: ID!, teamId: ID!): ConfigurationItem!
  }

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
    affectedCIs: [ConfigurationItem!]!
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
    affectedCIs:        [ConfigurationItem!]!
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
    ci:                ConfigurationItem
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
    createdAt: String!
  }

  type CIRelation {
    ci: ConfigurationItem!
    relationType: String!
  }

  type ConfigurationItem {
    id: ID!
    tenantId: String!
    name: String!
    type: String!
    status: String!
    environment: String!
    createdAt: String!
    updatedAt: String!
    dependencies: [ConfigurationItem!]!
    dependents: [ConfigurationItem!]!
    dependenciesWithType: [CIRelation!]!
    dependentsWithType: [CIRelation!]!
    owner: Team
    supportGroup: Team
    ipAddress: String
    location: String
    vendor: String
    version: String
    port: Int
    url: String
    region: String
    expiryDate: String
    notes: String
  }

  type User {
    id: ID!
    tenantId: String!
    email: String!
    name: String!
    role: String!
    teamId: String
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

  input CreateCIInput {
    name: String!
    type: String!
    status: String!
    environment: String!
  }

  input UpdateCIInput {
    name: String
    status: String
    environment: String
  }

  input UpdateCIFieldsInput {
    name: String
    status: String
    environment: String
    ipAddress: String
    location: String
    vendor: String
    version: String
    port: Int
    url: String
    region: String
    expiryDate: String
    notes: String
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

  input CreateTeamInput {
    name: String!
    description: String
  }
`
