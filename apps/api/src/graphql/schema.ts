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
    id: ID!
    tenantId: String!
    title: String!
    description: String
    type: String!
    risk: String!
    status: String!
    windowStart: String!
    windowEnd: String!
    createdAt: String!
    updatedAt: String!
    impactedCIs: [ConfigurationItem!]!
    relatedProblem: Problem
    causedIncidents: [Incident!]!
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
    title: String!
    description: String
    type: String!
    risk: String!
    windowStart: String!
    windowEnd: String!
    impactedCIIds: [ID!]
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
