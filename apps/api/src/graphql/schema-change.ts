export function changeSDL(): string {
  return `
  # ── Change Management (RFC-based) ─────────────────────────────────────────────

  type Change {
    id:                   ID!
    tenantId:             String!
    code:                 String!
    """Lo stesso valore di code, sotto il nome che hanno incident, problem e richieste."""
    number:               String!
    title:                String!
    why:                  String
    what:                 String
    requester:            User
    changeOwner:          User
    aggregateRiskScore:   Int
    # Priorità ITIL derivata e memorizzata: tipo × rischio.
    priority:             String
    approvalRoute:        String
    changeType:           String
    approvalStatus:       String
    approvalBy:           User
    approvalAt:           String
    createdAt:            String!
    updatedAt:            String!
    workflowInstance:     WorkflowInstance
    availableTransitions: [WorkflowTransition!]!
    workflowHistory:      [WorkflowStepExecution!]!
    # Incident e Problem che questa change risolve (relazione RESOLVED_BY),
    # tipicamente creati via "Richiedi Change".
    resolvesIncidents:    [LinkedTicketRef!]!
    resolvesProblems:     [LinkedTicketRef!]!
    # Requisiti di approvazione (Change Manager + un owner group per CI affected).
    approvals:            [ChangeApproval!]!
    # Valorizzato SOLO dal risultato di executeChangeTransition: azioni di step
    # (SLA, eventi, timer) fallite DOPO che la transizione è stata persistita.
    actionErrors:         [String!]
  }

  # Un requisito di approvazione della change.
  type ChangeApproval {
    kind:           String!   # change_manager | owner_group
    teamId:         ID
    teamName:       String
    status:         String!   # pending | approved
    approvedByName: String
    approvedAt:     String
    canApprove:     Boolean!  # l'utente corrente può approvare questo requisito
    onBehalf:       Boolean!  # vero quando l'utente approva come admin a nome di un team di cui non fa parte
  }

  # Riferimento leggero a un ticket collegato alla change.
  type LinkedTicketRef {
    id:       ID!
    number:   String!
    title:    String!
    status:   String!
    severity: String
    priority: String
    # false quando il link è stato creato automaticamente (RESOLVED_BY auto):
    # non può essere scollegato, la sola rimozione è eliminare la change.
    removable: Boolean
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

  """Una finestra pianificata nel calendario, col suo task e il suo CI."""
  type ChangeCalendarEntry {
    changeId:    ID!
    code:        String!
    title:       String!
    changeType:  String
    priority:    String
    """Il passo in cui la change si trova adesso: dice se la finestra e ancora davanti o gia passata."""
    currentStep: String
    """Il tipo di finestra: validation oppure release."""
    kind:        String!
    start:       String!
    end:         String!
    stepTitle:   String!
    taskCode:    String
    ciId:        ID!
    ciName:      String!
  }

  type ChangeCalendar {
    entries: [ChangeCalendarEntry!]!
    """
    Quanti piani portano passi con date inservibili (vuote, illeggibili o a
    rovescio): non si possono mettere in calendario, e tacerli farebbe leggere
    il calendario come completo.
    """
    unreadablePlans: Int!
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
    """Il dettaglio in inglese; con detailKey la frase si compone nella lingua di chi legge."""
    detail:    String
    detailKey:    String
    """I dati della frase, JSON."""
    detailParams: String
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
    why:           String!
    what:          String!
    changeOwner:   ID
    affectedCIIds: [ID!]!
    changeType:    String
    # Se valorizzato, la change nasce come RFC risolutiva di quel problem:
    # viene collegata (RESOLVED_BY) e il problem avanza a "change_requested".
    problemId:     ID
    # Come sopra ma per un incident: la change viene collegata (RESOLVED_BY);
    # l'incident non ha uno step "change_requested", quindi resta dov'è e si
    # risolve automaticamente quando la change arriva a "closed".
    incidentId:    ID
  }

  """
  Un'opzione di risposta. Con «id» è l'opzione che esiste già (etichetta,
  punteggio e ordine si aggiornano e le risposte date restano attaccate);
  senza «id» è nuova. Revisione totale · B-2: prima ogni salvataggio
  cancellava e ricreava le opzioni, e le risposte già date sparivano.
  """
  input AnswerOptionInput {
    id:       ID
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
    """
    «filters»: il JSON del costruttore di filtri, come per incident e problem
    (revisione totale · F-8). Serve alla ricerca della modale «collega
    ticket», che prima caricava le 50 più recenti e filtrava nel browser, e
    all'export CSV, che ora ripete i filtri di schermo.
    """
    changes(currentStep: String, priority: String, limit: Int, offset: Int, filters: String, sortField: String, sortDirection: String): ChangeList!
    change(id: ID!): Change
    """
    IL CALENDARIO DELLE CHANGE (17 set 2026): tutte le finestre pianificate che
    cadono nell'intervallo, una voce per finestra.

    Non esisteva modo di chiedere «cosa va in produzione questa settimana»: le
    finestre stanno nei passi del piano di rilascio, cioè in un JSON su un nodo
    attaccato al CI impattato, quindi non erano né filtrabili né ordinabili. Qui
    l'intervallo si applica una volta sola, sul server.

    «from» e «to» sono ISO 8601 con offset esplicito, come le finestre stesse.
    Una voce entra se la sua finestra SI SOVRAPPONE all'intervallo, non se è
    contenuta: un rilascio che comincia domenica e finisce lunedì appartiene a
    entrambe le settimane, e sparire da una delle due sarebbe peggio che
    comparire in due.
    """
    changeCalendar(from: String!, to: String!): ChangeCalendar!
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
    # Eliminazione logica della change: la marca come deleted, sparisce dagli
    # elenchi e i suoi collegamenti (RESOLVED_BY) non sono più mostrati.
    deleteChange(id: ID!): Boolean!
    addCIToChange(changeId: ID!, ciId: ID!): ChangeAffectedCI!
    removeCIFromChange(changeId: ID!, ciId: ID!): Boolean!
    submitAssessmentResponse(taskId: ID!, questionId: ID!, optionId: ID!): AssessmentTask!
    completeAssessmentTask(taskId: ID!): AssessmentTask!
    assignAssessmentTaskToTeam(taskId: ID!, teamId: ID!): AssessmentTask!
    """userId null = togli l'assegnazione: l'attività torna al solo team (revisione totale · F-4)."""
    assignAssessmentTaskToUser(taskId: ID!, userId: ID): AssessmentTask!
    """userId null = togli l'assegnazione (revisione totale · F-4)."""
    assignDeployPlanTaskToUser(taskId: ID!, userId: ID): DeployPlanTask!
    saveDeployPlan(taskId: ID!, steps: [DeployStepInput!]!): DeployPlanTask!
    completeDeployPlanTask(taskId: ID!): DeployPlanTask!
    executeChangeTransition(changeId: ID!, toStep: String!, notes: String): Change!
    # Collega/scollega un ticket (entityType: incident|problem) alla change.
    linkResolvedTicket(changeId: ID!, entityType: String!, entityId: ID!): Change!
    unlinkResolvedTicket(changeId: ID!, entityType: String!, entityId: ID!): Change!
    # Approvazione multi-parte: approva/rigetta il requisito di un team.
    approveChangeApproval(changeId: ID!, teamId: ID!, note: String): Change!
    # Rigetta: riporta la change ad assessment riaprendo i task scelti
    # (reopenAll=true → tutti; altrimenti quelli in reopenTaskIds).
    rejectChangeApproval(changeId: ID!, teamId: ID!, note: String!, reopenAll: Boolean, reopenTaskIds: [ID!]): Change!
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
