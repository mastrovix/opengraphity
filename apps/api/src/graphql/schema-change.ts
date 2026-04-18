export function changeSDL(): string {
  return `
  # ── Change Management (RFC-based) ─────────────────────────────────────────────

  type Change {
    id:                   ID!
    tenantId:             String!
    code:                 String!
    title:                String!
    description:          String
    requester:            User
    changeOwner:          User
    aggregateRiskScore:   Int
    approvalRoute:        String
    approvalStatus:       String
    approvalBy:           User
    approvalAt:           String
    createdAt:            String!
    updatedAt:            String!
    workflowInstance:     WorkflowInstance
    availableTransitions: [WorkflowTransition!]!
    workflowHistory:      [WorkflowStepExecution!]!
  }

  type ChangeAffectedCI {
    ci:                CIBase!
    ciPhase:           String!
    riskScore:         Int
    assessmentOwner:   AssessmentTask
    assessmentSupport: AssessmentTask
    deployPlan:        DeployPlanTask
    validation:        ValidationTest
    deployment:        DeploymentTask
    review:            ReviewTask
  }

  type AssessmentTask {
    id:            ID!
    code:          String!
    responderRole: String!
    status:        String!
    score:         Int
    completedBy:   User
    completedAt:   String
    createdAt:     String!
    assignedTeam:  Team
    assignee:      User
    responses:     [AssessmentResponseDetail!]!
  }

  type AssessmentResponseDetail {
    question:       AssessmentQuestion!
    selectedOption: AnswerOption!
    answeredBy:     User
    answeredAt:     String!
  }

  type AssessmentQuestion {
    id:        ID!
    text:      String!
    category:  String!
    isCore:    Boolean!
    isActive:  Boolean!
    createdAt: String!
    options:   [AnswerOption!]!
  }

  type AssessmentQuestionWithWeight {
    question:  AssessmentQuestion!
    weight:    Int!
    sortOrder: Int!
  }

  type AnswerOption {
    id:        ID!
    label:     String!
    score:     Int!
    sortOrder: Int!
  }

  type ValidationTest {
    id:       ID!
    code:     String!
    status:   String!
    result:   String
    testedBy: User
    testedAt: String
  }

  type TimeWindow {
    start: String!
    end:   String!
  }

  type DeployStep {
    title:            String!
    validationWindow: TimeWindow!
    releaseWindow:    TimeWindow!
  }

  type DeployPlanTask {
    id:           ID!
    code:         String!
    status:       String!
    steps:        [DeployStep!]!
    assignedTeam: Team
    assignee:     User
    completedBy:  User
    completedAt:  String
    createdAt:    String!
  }

  type DeploymentTask {
    id:         ID!
    code:       String!
    status:     String!
    deployedBy: User
    deployedAt: String
  }

  type ReviewTask {
    id:         ID!
    code:       String!
    status:     String!
    result:     String
    reviewedBy: User
    reviewedAt: String
  }

  type ChangeAuditEntry {
    timestamp: String!
    action:    String!
    actor:     User
    detail:    String
  }

  type MyTask {
    id:         ID!
    code:       String!
    kind:       String!
    role:       String!
    action:     String!
    status:     String!
    changeId:   ID!
    changeCode: String!
    ciId:       ID!
    ciName:     String!
    phase:      String!
    createdAt:  String!
  }

  type MyTasksResult {
    assignedToMe: [MyTask!]!
    unassigned:   [MyTask!]!
  }

  type ChangeList {
    items: [Change!]!
    total: Int!
  }

  type CITypeAssignment {
    ciTypeId:   ID!
    ciTypeName: String!
    weight:     Int!
    sortOrder:  Int!
  }

  input CreateChangeInput {
    title:         String!
    description:   String
    changeOwner:   ID
    affectedCIIds: [ID!]!
  }

  input AnswerOptionInput {
    label:     String!
    score:     Int!
    sortOrder: Int!
  }

  input CreateQuestionInput {
    text:     String!
    category: String!
    isCore:   Boolean!
    options:  [AnswerOptionInput!]!
  }

  input UpdateQuestionInput {
    text:     String
    category: String
    isCore:   Boolean
    isActive: Boolean
    options:  [AnswerOptionInput!]
  }

  input TimeWindowInput {
    start: String!
    end:   String!
  }

  input DeployStepInput {
    title:            String!
    validationWindow: TimeWindowInput!
    releaseWindow:    TimeWindowInput!
  }

  type ImpactedCI {
    ci:         CIBase!
    distance:   Int!
    affectedBy: CIBase!
    impactPath: [String!]!
  }

  type TaskDetail {
    id:         ID!
    code:       String!
    kind:       String!
    changeId:   ID!
    changeCode: String!
    changeTitle: String!
    changePhase: String!
    changeDescription: String
    ciId:       ID!
    ciName:     String!
    ciType:     String
    ciEnv:      String
  }

  extend type Query {
    changes(currentStep: String, limit: Int, offset: Int): ChangeList!
    change(id: ID!): Change
    changeAffectedCIs(changeId: ID!): [ChangeAffectedCI!]!
    changeAuditTrail(changeId: ID!): [ChangeAuditEntry!]!
    changeImpactedCIs(changeId: ID!, depth: Int): [ImpactedCI!]!
    taskById(id: ID!): TaskDetail
    assessmentQuestionCatalog(category: String): [AssessmentQuestionWithWeight!]!
    assessmentQuestionsAdmin: [AssessmentQuestion!]!
    questionCITypeAssignments(questionId: ID!): [CITypeAssignment!]!
    myTasks: MyTasksResult!
  }

  extend type Mutation {
    createChange(input: CreateChangeInput!): Change!
    addCIToChange(changeId: ID!, ciId: ID!): ChangeAffectedCI!
    removeCIFromChange(changeId: ID!, ciId: ID!): Boolean!
    submitAssessmentResponse(taskId: ID!, questionId: ID!, optionId: ID!): AssessmentTask!
    completeAssessmentTask(taskId: ID!): AssessmentTask!
    assignAssessmentTaskToTeam(taskId: ID!, teamId: ID!): AssessmentTask!
    assignAssessmentTaskToUser(taskId: ID!, userId: ID!): AssessmentTask!
    saveDeployPlan(taskId: ID!, steps: [DeployStepInput!]!): DeployPlanTask!
    completeDeployPlanTask(taskId: ID!): DeployPlanTask!
    executeChangeTransition(changeId: ID!, toStep: String!, notes: String): Change!
    completeValidationTest(changeId: ID!, ciId: ID!, result: String!): ValidationTest!
    completeDeployment(changeId: ID!, ciId: ID!): DeploymentTask!
    completeReview(changeId: ID!, ciId: ID!, result: String!): ReviewTask!
    createAssessmentQuestion(input: CreateQuestionInput!): AssessmentQuestion!
    updateAssessmentQuestion(id: ID!, input: UpdateQuestionInput!): AssessmentQuestion!
    deleteAssessmentQuestion(id: ID!): Boolean!
    assignQuestionToCIType(questionId: ID!, ciTypeId: ID!, weight: Int!, sortOrder: Int!): Boolean!
    removeQuestionFromCIType(questionId: ID!, ciTypeId: ID!): Boolean!
    setQuestionCore(questionId: ID!, isCore: Boolean!): AssessmentQuestion!
    sendTaskReminder(taskId: ID!, userId: ID!): Boolean!
    reopenAssessmentTask(taskId: ID!, reason: String!): AssessmentTask!
    reopenDeployPlanTask(taskId: ID!, reason: String!): DeployPlanTask!
    reopenValidationTest(id: ID!, reason: String!): ValidationTest!
    reopenDeploymentTask(id: ID!, reason: String!): DeploymentTask!
    reopenReviewTask(id: ID!, reason: String!): ReviewTask!
  }
  `
}
