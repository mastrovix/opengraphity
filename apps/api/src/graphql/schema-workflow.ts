export function workflowSDL(): string {
  return `
  # ── Workflow types ─────────────────────────────────────────────────────────

  """
  L'esito di provisionTenantData: cosa è stato creato e cosa manca ancora.
  Un elenco "remainingGaps" vuoto significa che il cliente è usabile.
  """
  type TenantProvisioning {
    """I ruoli di fabbrica creati adesso (quelli che c'erano non sono stati toccati)."""
    rolesCreated:             [String!]!
    dashboardCreated:         Boolean!
    notificationRulesCreated: Int!
    """Le matrici di dominio create adesso (quelle che c'erano non sono state toccate)."""
    matricesCreated:          [String!]!
    """I workflow esaminati (creati o già presenti: la mutation non sovrascrive)."""
    workflows:                [String!]!
    remainingGaps:            [ProvisioningGap!]!
  }

  type WorkflowInstance {
    id:          ID!
    currentStep: String!
    status:      String!
    createdAt:   String!
    updatedAt:   String!
  }

  type TransitionErrorParam {
    name:  String!
    value: String!
  }

  type TransitionResult {
    success:  Boolean!
    error:    String
    # Chiave i18n della frase (sotto errors.) e i suoi parametri: il client
    # compone il messaggio nella lingua di chi guarda; \`error\` resta per i log.
    errorKey:    String
    errorParams: [TransitionErrorParam!]
    instance: WorkflowInstance
    # Side-effect actions (SLA start, events, timers, …) that FAILED after the
    # transition was persisted. Non-empty = the step is not fully applied.
    actionErrors: [String!]
  }

  """Il nome di un passo e la sua etichetta, per lingua: serve solo a leggere uno stato."""
  type WorkflowStepLabel {
    name:   String!
    label:  String!
    labels: [LocalizedLabel!]!
  }

  type WorkflowTransition {
    toStep:        String!
    label:         String!
    # Traduzioni dell'etichetta (giro del 14 set 2026, #22): chi mostra
    # l'etichetta sceglie la lingua di chi guarda, altrimenti \`label\`.
    labels:        [LocalizedLabel!]!
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
    # Traduzioni dell'etichetta (giro del 14 set 2026, #22): chi mostra
    # l'etichetta sceglie la lingua di chi guarda, altrimenti \`label\`.
    labels:        [LocalizedLabel!]!
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
    # La SCADENZA del passo (JSON: after, unit, calendar_id, to_step, set_fields):
    # dopo quanto tempo nel passo il ticket si sposta da solo, e dove. null = nessuna.
    deadline:            String
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
    # Traduzioni dell'etichetta (giro del 14 set 2026, #22): chi mostra
    # l'etichetta sceglie la lingua di chi guarda, altrimenti \`label\`.
    labels:        [LocalizedLabel!]!
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
    # La scadenza del passo (JSON). Assente/null = invariata; stringa vuota = tolta.
    deadline:     String
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
