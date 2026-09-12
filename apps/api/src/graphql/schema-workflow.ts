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

  type TransitionResult {
    success:  Boolean!
    error:    String
    instance: WorkflowInstance
    # Side-effect actions (SLA start, events, timers, …) that FAILED after the
    # transition was persisted. Non-empty = the step is not fully applied.
    actionErrors: [String!]
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
    durationMs:  Float
    triggeredBy: String!
    triggerType: String!
    notes:       String
  }

  type WorkflowStep {
    id:                  ID!
    name:                String!
    label:               String!
    type:                String!
    enterActions:        String
    exitActions:         String
    timerDelayMinutes:   Int
    subWorkflowId:       String
    isInitial:           Boolean!
    isTerminal:          Boolean!
    isOpen:              Boolean!
    category:            String
    order:               Int!
    # Quante istanze di workflow si trovano ORA su questo step. Finché è > 0 lo
    # step non si può eliminare: le istanze resterebbero senza step corrente
    # (ticket che non transizionano più). Il disegnatore lo legge per dire
    # perché il bottone «Elimina step» è spento, invece di offrirlo e rompere.
    currentInstances:    Int!
    # Posizione salvata dal designer (saveWorkflowChanges.positions); null se
    # lo step non è mai stato disposto a mano → il web usa il layout di default.
    positionX:           Float
    positionY:           Float
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
    sourceHandle:  String
    targetHandle:  String
  }

  type WorkflowDefinition {
    id:             ID!
    name:           String!
    entityType:     String!
    category:       String
    changeSubtype:  String
    version:        Int!
    active:         Boolean!
    steps:          [WorkflowStep!]!
    transitions:    [WorkflowTransitionDef!]!
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

  input StepChangeInput {
    stepName:     String!
    label:        String!
    enterActions: String
    exitActions:  String
    isInitial:    Boolean
    isTerminal:   Boolean
    isOpen:       Boolean
    category:     String
  }
  `
}
