export function workflowSDL(): string {
  return `
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
  `
}
