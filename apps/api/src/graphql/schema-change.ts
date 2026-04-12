export function changeSDL(): string {
  return `
  # ── Change ────────────────────────────────────────────────────────────────────

  type Change {
    id:             ID!
    number:         String!
    tenantId:       String!
    title:          String!
    description:    String
    type:           String!
    priority:       String!
    status:         String!
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
    number:    String!
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
    number:    String!
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

  type ChangesResult {
    items: [Change!]!
    total: Int!
  }

  type TransitionResult {
    success:  Boolean!
    error:    String
    instance: WorkflowInstance
  }

  input CreateChangeInput {
    title:              String!
    description:        String
    type:               String!
    priority:           String!
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
  `
}
