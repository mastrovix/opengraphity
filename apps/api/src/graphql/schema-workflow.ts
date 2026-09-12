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
    # Lo SCOPO del passo: che ruolo ha nel processo (approvazione, finestra di
    # rilascio, analisi…). È quello che le guardie e le transizioni automatiche
    # riconoscono, così un passo rinominato dal cliente continua a funzionare.
    # Vocabolario chiuso (WORKFLOW_STEP_PURPOSES); null = non dichiarato, ed è
    # legittimo: nessuno scopo viene indovinato dal nome.
    purpose:             String
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
    # Scopo del passo (vocabolario chiuso WORKFLOW_STEP_PURPOSES).
    # Assente/null = non mandato, lo scopo salvato resta com'è.
    # Stringa vuota = TOLTO: un passo senza scopo è legittimo, e il
    # disegnatore deve poterlo riportare a «nessuno».
    purpose:      String
  }

  """
  I tipi di evento che i workflow del tenant possono DAVVERO produrre, derivati
  dai suoi passi (non da una lista di costanti). Serve al form delle regole di
  notifica e agli abbonamenti dei webhook in uscita: prima offrivano sei
  costanti, e abbonarsi al proprio passo era impossibile.
  """
  type WorkflowEventType {
    "Il tipo di evento pubblicato (es. incident.step_entered, incident.assigned)."
    eventType:   String!
    "Entità del workflow (incident, problem, …); null per gli eventi che non nascono da un passo."
    entityType:  String
    "Nome del passo che lo produce; null per il tipo stabile e per gli eventi di prodotto."
    stepName:    String
    "Etichetta del passo, da mostrare accanto al tipo."
    stepLabel:   String
    "Scopo dichiarato del passo; null se il cliente non l'ha assegnato."
    stepPurpose: String
    "Categoria del passo (active | waiting | resolved | closed | …)."
    stepCategory: String
    "Vero se è il tipo STABILE del passo (quello che non cambia con una rinomina)."
    stable:      Boolean!
  }
  `
}
