import { cmdbSDL } from './schema-common.js'
import { enumTypeSDL } from './schema-enum.js'
import { domainMatrixSDL } from './schema-domainMatrix.js'
import { incidentSDL } from './schema-incident.js'
import { problemSDL } from './schema-problem.js'
import { changeSDL } from './schema-change.js'
import { impactSDL } from './schema-impact.js'
import { serviceRequestSDL } from './schema-service-request.js'
import { userTeamSDL } from './schema-user-team.js'
import { workflowSDL } from './schema-workflow.js'
import { notificationSDL } from './schema-notification.js'
import { reportSDL } from './schema-report.js'
import { olaSDL } from './schema-ola.js'
import { dashboardSDL } from './schema-dashboard.js'
import { anomalySDL } from './schema-anomaly.js'
import { organizationSDL } from './schema-organization.js'
import { rolesSDL } from './schema-roles.js'
import { slackSDL } from './schema-slack.js'
import { loginSDL } from './schema-login.js'
import { topologySDL } from './schema-topology.js'
import { discoverySDL } from './schema-discovery.js'
import { adminSDL } from './schema-admin.js'
import { monitoringSDL } from './schema-monitoring.js'
import { approvalSDL } from './schema-approval.js'
import { attachmentsSDL } from './schema-attachments.js'
import { commentsSDL } from './schema-comments.js'
import { customFieldsSDL } from './schema-customFields.js'
import { knowledgeBaseSDL } from './schema-kb.js'
import { portalSDL } from './schema-portal.js'
import { fieldRulesSDL } from './schema-fieldRules.js'
import { automationSchema } from './schema-automation.js'
import { integrationsSchema } from './schema-integrations.js'
import { collaborationSchema } from './schema-collaboration.js'
import { whatifSDL } from './schema-whatif.js'
import { similaritySDL } from './schema-similarity.js'
import { eventsSDL } from './schema-events.js'
import { servicesSDL } from './schema-services.js'

export function buildBaseSDL(): string {
  return `#graphql

  type Query {
    # Incidents
    incidents(status: String, severity: String, limit: Int, offset: Int, filters: String, sortField: String, sortDirection: String): IncidentsResult!
    incident(id: ID!): Incident

    # Problems
    problems(limit: Int, offset: Int, status: String, priority: String, search: String, filters: String, sortField: String, sortDirection: String): ProblemsResult!
    problem(id: ID!): Problem
    knownErrors(search: String): [Problem!]!

    # Service Requests
    serviceRequests(status: String, priority: String, limit: Int, offset: Int, filters: String, sortField: String, sortDirection: String): [ServiceRequest!]!
    serviceRequest(id: ID!): ServiceRequest
    serviceCatalogItems(activeOnly: Boolean): [ServiceCatalogItem!]!

    # CMDB — generic queries (typed CI queries come from dynamic schema)
    allCIs(limit: Int, offset: Int, type: String, environment: String, status: String, search: String, ciTypes: [String], excludeCiTypes: [String], filters: String, sortField: String, sortDirection: String): AllCIsResult!
    ciById(id: ID!): CIBase
    blastRadius(id: ID!): [BlastRadiusItem!]!
    ciIncidents(ciId: ID!): [Incident!]!
    ciChanges(ciId: ID!): [Change!]!
    ciProblems(ciId: ID!): [Problem!]!
    ciServiceRequests(ciId: ID!): [ServiceRequest!]!
    # Dynamic CI Group members: manual (HAS_MEMBER) or dynamic (live criteria).
    # I gruppi dinamici sono troncati lato server (MEMBERS_LIMIT): total/truncated
    # rendono il taglio visibile invece di far passare 500 per il conteggio reale.
    ciGroupMembers(groupId: ID!): CIGroupMembersResult!
    baseCIType: CITypeDefinition!
    ciTypes: [CITypeDefinition!]!
    itilTypes: [CITypeDefinition!]!
    itilTypeFields(typeId: ID!): [CIFieldDef!]!

    # Teams
    teams(filters: String, sortField: String, sortDirection: String): [Team!]!
    team(id: ID!): Team

    # Users
    me: User
    users(sortField: String, sortDirection: String): [User!]!
    user(id: ID!): User

    # Notification Channels
    notificationChannels: [NotificationChannel!]!

    # Notification Rules
    notificationRules: [NotificationRule!]!
    "Canali instradabili per tipo di evento: sorgente unica per l'interfaccia delle regole (D3.1)."
    notificationRouting: NotificationRouting!
    """
    I tipi di evento che i workflow di QUESTO tenant possono produrre, derivati
    dai suoi passi (D-22): il form delle regole e gli abbonamenti dei webhook in
    uscita non offrono più sei costanti, ma ciò che esiste davvero. Senza
    entityType li elenca tutti.
    """
    workflowEventTypes(entityType: String): [WorkflowEventType!]!

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

    # Dashboard
    myDashboards: [DashboardConfig!]!
    myDashboard: DashboardConfig
    dashboard(id: ID!): DashboardConfig
    customWidgets(dashboardId: ID!): [CustomWidget!]!
    widgetData(widgetId: ID!): WidgetDataResult!
    widgetDataPreview(entityType: String!, metric: String!, groupByField: String, filterField: String, filterValue: String, timeRange: String): WidgetDataResult!

    # Logs
    logs(limit: Int, offset: Int, filters: String, sortField: String, sortDirection: String): LogsResult!

    # Anomaly Detection
    anomalies(limit: Int, offset: Int, filters: String, sortField: String, sortDirection: String): AnomaliesResult!
    anomaly(id: ID!): Anomaly
    anomalyStats: AnomalyStats!
    anomalyScanStatus: AnomalyScanStatus!

    # Topology
    topology(types: [String!], environment: String, status: String, selectedCiId: ID, maxHops: Int): TopologyData!

    # Workflow
    """
    Cosa manca a questo cliente per essere usabile: dashboard, regole di
    notifica, matrici di dominio, workflow attivi per le cinque entità. Lista
    vuota = completo. Admin.

    Il prodotto lo sapeva già (ondata 8) ma lo diceva solo a chi lanciava
    "migrate --status": un tenant incompleto restava incompleto finché qualcuno
    non apriva un ticket e vedeva l'errore.
    """
    tenantProvisioningGaps: [ProvisioningGap!]!
    incidentWorkflow(incidentId: ID!): WorkflowInstance
    incidentWorkflowHistory(incidentId: ID!): [WorkflowStepExecution!]!
    incidentAvailableTransitions(incidentId: ID!): [WorkflowTransition!]!
    workflowDefinition(entityType: String!): WorkflowDefinition
    workflowDefinitionById(id: ID!): WorkflowDefinition
    workflowDefinitions(entityType: String): [WorkflowDefinition!]!

    # Enum Types
    enumTypes(scope: String): [EnumTypeDefinition!]!
    enumType(id: ID!): EnumTypeDefinition

    # Queue Stats (admin only)
    queueStats: [QueueStat!]!
    queueJobs(queueName: String!, status: String, limit: Int): [QueueJob!]!

    # Monitoring (admin only)
    systemHealth:  SystemHealth!
    systemMetrics: SystemMetrics!
    traceInfo:     TraceInfo!

    # Audit Log (admin only)
    auditLog(page: Int, pageSize: Int, filters: String, sortField: String, sortDirection: String): AuditEntriesResult!
    """
    Le azioni presenti nel registro di audit del tenant, con il numero di voci.
    La pagina le offre in tendina: dopo il taglio di vocabolario dell'ondata 4
    (transizioni sotto <entità>.step_entered, prima sotto il nome del passo) le
    voci storiche non sono state riscritte, e questa lista le mostra comunque.
    """
    auditActions: [AuditActionCount!]!

    # Approval Workflow
    approvalRequests(page: Int, pageSize: Int, filters: String, sortField: String, sortDirection: String): ApprovalRequestsResult!
    myPendingApprovals: [ApprovalRequest!]!

    # Attachments
    attachments(entityType: String!, entityId: String!): [Attachment!]!

    # Global search (topbar search box) — \`limit\` = max results per category
    globalSearch(query: String!, limit: Int): GlobalSearchResults!
    """Campi filtrabili (scalari ed enum) di un tipo dello schema — sostituisce l'introspezione lato client."""
    entityFilterFields(typeName: String!): [EntityFilterField!]!

    # Comments
    comments(entityType: String!, entityId: String!, includeInternal: Boolean): [EntityComment!]!

    # Knowledge Base
    kbArticles(search: String, category: String, status: String, page: Int, pageSize: Int): KBArticlesResult!
    kbArticle(id: ID!): KBArticle!
    kbArticleBySlug(slug: String!): KBArticle!
    kbCategories(language: String): [KBCategory!]!
    kbArticleVersions(articleId: ID!): [KBArticleVersion!]!

    # OLA / UC + SLA reporting
    olaContracts(type: String): [OLAContract!]!
    slaReport(windowDays: Int): SLAReport!

    # Portal (Self-Service)
    "\`status\` è una CLASSE di stato (open | in_progress | resolved | closed), tradotta nei nomi dei passi del workflow del tenant — mai un nome di passo (B0-3)."
    # language: la lingua di chi guarda, per le etichette dei passi (giro del 14 set 2026).
    myTickets(status: String, page: Int, pageSize: Int, language: String): MyTicketsResult!
    myTicket(id: ID!, language: String): MyTicketDetail!
    ticketCategories(language: String): [TicketCategory!]!
    "Le severità che l'utente finale sceglie nel portale, nella lingua chiesta (verifica «Cosa resta cablato», ondata 1)."
    portalSeverityChoices(language: String): [PortalSeverityChoice!]!
    "I campi personalizzati offerti all'utente finale per incident o service_request (ondata 4)."
    portalCustomFields(entityType: String!): [CustomFieldValue!]!
    "La scelta dell'amministratore com'è salvata; null = non ancora dichiarata."
    portalSeverityOptions: [PortalSeverityOption!]
    myTicketStats: MyTicketStats!

    # Field Rules (admin)
    fieldVisibilityRules(entityType: String!): [FieldVisibilityRule!]!
    fieldRequirementRules(entityType: String!, workflowStep: String): [FieldRequirementRule!]!

    # Tipi di CI esclusi per tipo di ticket (CM-8). Senza argomento: tutti i tipi di ticket.
    ticketCIExclusions(ticketType: String): [TicketCIExclusions!]!

    # What-if Planning
    whatIfAnalysis(ciId: ID!, action: String!, depth: Int): WhatIfResult!

    # Semantic similarity (vector search)
    similarIncidents(incidentId: ID!, limit: Int): SimilarIncidentsResult!
    suggestedArticles(incidentId: ID!, limit: Int): SuggestedArticlesResult!
    # AI triage suggestion for an incident draft (explicit, never auto-applied)
    triageSuggestion(title: String!, description: String, ciIds: [ID!]): TriageSuggestion!
    # Post-incident AI (explicit, drafts only)
    resolutionDraft(incidentId: ID!): ResolutionDraft!
    problemCandidates: [ProblemCandidate!]!
    whatIfCompare(scenarios: [WhatIfScenarioInput!]!): [WhatIfResult!]!

    # Discovery / Sync
    syncSources: [SyncSource!]!
    syncSource(id: ID!): SyncSource
    syncRuns(sourceId: ID!, limit: Int, offset: Int, sortField: String, sortDirection: String): SyncRunsResult!
    syncConflicts(sourceId: ID, status: String, limit: Int, offset: Int): SyncConflictsResult!
    syncStats(sourceId: ID): SyncStats!
    availableConnectors: [ConnectorInfo!]!
    syncChangeHistory(ciId: ID!, limit: Int, offset: Int): SyncChangeRecordsResult!

    """
    Le lingue del prodotto e quella predefinita di QUESTO cliente. Aperta a
    tutti: il client la chiede all'avvio per sapere in che lingua mostrarsi a
    chi non ha ancora scelto.
    """
    tenantLanguageSettings: TenantLanguageSettings!

    """Il fuso orario del cliente e le zone che il runtime conosce."""
    tenantTimezoneSettings: TenantTimezoneSettings!

    """I calendari di servizio con nome: ogni policy SLA e ogni contratto OLA/UC in orario di servizio ne sceglie uno."""
    serviceCalendars: [ServiceCalendar!]!
    "Quanti giorni si conservano le notifiche della campanella (null = non scelto: la pulizia salta questa organizzazione)."
    tenantInAppRetentionDays: Int

    """Le notifiche in-app della persona collegata, dalla più recente (F10)."""
    myNotifications(limit: Int): [InAppNotification!]!
  }

  """
  Una notifica del pannello, salvata (revisione del 14 set 2026 · F10): prima
  viveva nella memoria di un processo e del browser.
  """
  type InAppNotification {
    id:            ID!
    type:          String!
    """Chiave i18n del titolo."""
    title:         String!
    titleFallback: String
    message:       String!
    """Chiave i18n del messaggio e i suoi dati (JSON), quando il messaggio si compone nella lingua di chi legge."""
    messageKey:    String
    messageParams: String
    severity:      String
    entityId:      String
    entityType:    String
    timestamp:     String!
    read:          Boolean!
  }

  """
  L'orario lavorativo delle policy SLA e dei contratti OLA «in orario
  lavorativo»: giorni (0 = domenica … 6 = sabato), fascia HH:MM nel fuso della
  policy e festività YYYY-MM-DD. Prima erano le 08–18 dal lunedì al venerdì per
  ogni cliente.
  """
  type ServiceCalendar {
    id:       ID!
    name:     String!
    days:     [Int!]!
    start:    String!
    end:      String!
    holidays: [String!]!
    """I nomi delle policy SLA che contano con questo calendario."""
    usedBySlaPolicies:  [String!]!
    """I nomi dei contratti OLA/UC che contano con questo calendario."""
    usedByOlaContracts: [String!]!
    """Le scadenze dei passi di workflow che contano con questo calendario («Workflow · Passo»)."""
    usedByWorkflowSteps: [String!]!
  }

  input ServiceCalendarInput {
    days:     [Int!]!
    start:    String!
    end:      String!
    holidays: [String!]!
  }

  """
  Il fuso orario del cliente: da qui dipendono scadenze SLA/OLA in orario
  lavorativo, ora del digest e le date nei testi generati. Si sceglie dalla
  pagina Organizzazione (prima solo con uno script).
  """
  type TenantTimezoneSettings {
    """Zona IANA; null = non configurato, e la diagnostica lo dice come errore."""
    timezone:  String
    available: [String!]!
  }

  """
  In che lingua si legge questo cliente.

  La scelta e configurazione — un'azienda italiana la vuole italiana, la stessa
  installazione per un cliente irlandese la vuole inglese — e prima era una
  costante nel codice: cambiarla voleva dire ricompilare. L'elenco invece resta
  codice: sono i file di traduzione spediti nel bundle.
  """
  type TenantLanguageSettings {
    """Le lingue in cui il prodotto e tradotto. Non configurabili: aggiungerne una e scrivere un file."""
    available:       [String!]!
    """
    La lingua predefinita del cliente: quella che legge chi non ha scelto, e il
    ripiego di un'etichetta scritta in una lingua sola. \`null\` = non
    configurata, che e diverso da «configurata sulla prima»: il primo caso la
    diagnostica lo dice all'admin.
    """
    defaultLanguage: String
    """La lingua che si usa finche non se ne configura una. Sempre una di \`available\`."""
    fallback:        String!
  }


  type Mutation {
    # Auth

    """
    Configura la lingua predefinita del cliente (admin). Rifiuta una lingua in
    cui il prodotto non e tradotto, invece di ripiegare in silenzio su un'altra.
    """
    setTenantDefaultLanguage(language: String!): TenantLanguageSettings!

    """Configura il fuso orario del cliente (admin). Rifiuta una zona IANA sconosciuta."""
    setTenantTimezone(timezone: String!): TenantTimezoneSettings!

    """Crea un calendario di servizio con nome (admin). Rifiuta un calendario incoerente dicendo perché."""
    createServiceCalendar(name: String!, calendar: ServiceCalendarInput!): ServiceCalendar!
    """Modifica nome o orari di un calendario (admin). Gli SLA già partiti conservano le loro scadenze."""
    updateServiceCalendar(id: ID!, name: String, calendar: ServiceCalendarInput): ServiceCalendar!
    """Elimina un calendario (admin). Rifiutato se una policy o un contratto lo usa, con i loro nomi."""
    deleteServiceCalendar(id: ID!): Boolean!
    "Sceglie per quanti giorni si conservano le notifiche della campanella (admin, 1–3650)."
    setTenantInAppRetentionDays(days: Int!): Int!

    """Segna letta una notifica della persona collegata."""
    markNotificationRead(id: ID!): Boolean!
    """Segna lette tutte le notifiche della persona collegata. Ritorna quante."""
    markAllNotificationsRead: Int!
    """Nasconde tutte le notifiche della persona collegata dal suo pannello. Ritorna quante."""
    dismissAllNotifications: Int!

    # Incidents
    createIncident(input: CreateIncidentInput!): Incident!
    setIncidentMajor(id: ID!, major: Boolean!): Incident!
    updateIncident(id: ID!, input: UpdateIncidentInput!): Incident!
    resolveIncident(id: ID!, rootCause: String): Incident!
    assignIncidentToTeam(id: ID!, teamId: ID!): Incident!
    assignIncidentToUser(id: ID!, userId: ID): Incident!
    addIncidentComment(id: ID!, text: String!, isInternal: Boolean): Comment!
    addAffectedCI(incidentId: ID!, ciId: ID!): Incident!
    removeAffectedCI(incidentId: ID!, ciId: ID!): Incident!

    # Problems
    createProblem(input: CreateProblemInput!): Problem!
    updateProblem(id: ID!, input: UpdateProblemInput!): Problem!
    deleteProblem(id: ID!): Boolean!
    linkIncidentToProblem(problemId: ID!, incidentId: ID!): Problem!
    unlinkIncidentFromProblem(problemId: ID!, incidentId: ID!): Problem!
    # Collega/scollega ticket dello stesso tipo (RELATED_TO). entityType: incident|problem.
    linkRelatedTicket(entityType: String!, entityId: ID!, otherId: ID!): Boolean!
    unlinkRelatedTicket(entityType: String!, entityId: ID!, otherId: ID!): Boolean!
    addCIToProblem(problemId: ID!, ciId: ID!): Problem!
    removeCIFromProblem(problemId: ID!, ciId: ID!): Problem!
    assignProblemToTeam(problemId: ID!, teamId: ID!): Problem!
    assignProblemToUser(problemId: ID!, userId: ID!): Problem!
    executeProblemTransition(problemId: ID!, toStep: String!, notes: String): Problem!
    addProblemComment(problemId: ID!, text: String!, isInternal: Boolean): ProblemComment!

    # Service Requests
    createServiceRequest(input: CreateServiceRequestInput!): ServiceRequest!
    """Collega un CI alla richiesta (CM-8). Rifiutato se il tipo del CI è escluso per le richieste."""
    addCIToServiceRequest(requestId: ID!, ciId: ID!): ServiceRequest!
    removeCIFromServiceRequest(requestId: ID!, ciId: ID!): ServiceRequest!
    createServiceCatalogItem(input: CreateServiceCatalogItemInput!): ServiceCatalogItem!
    updateServiceCatalogItem(id: ID!, input: UpdateServiceCatalogItemInput!): ServiceCatalogItem!
    updateServiceRequest(id: ID!, input: UpdateServiceRequestInput!): ServiceRequest!
    assignServiceRequestToUser(id: ID!, userId: ID): ServiceRequest!

    # CMDB
    updateCIFields(id: ID!, input: UpdateCIFieldsInput!): CIBase!

    # Teams
    createTeam(input: CreateTeamInput!): Team!
    updateTeam(id: ID!, input: UpdateTeamInput!): Team!
    # teamId null → rimuove l'assegnazione (OWNED_BY / SUPPORTED_BY)
    assignCIOwner(ciId: ID!, teamId: ID): CIBase!
    assignCISupportGroup(ciId: ID!, teamId: ID): CIBase!
    addCIRelationship(sourceId: ID!, targetId: ID!, relationType: String!): Boolean!
    removeCIRelationship(sourceId: ID!, targetId: ID!, relationType: String!): Boolean!

    # Workflow
    """
    Crea quello che manca a questo cliente: dashboard, regole di notifica,
    matrici di dominio e le definizioni di workflow delle cinque entità.
    Idempotente e **non distruttiva**: una definizione che esiste già viene
    saltata, non riallineata al seme.

    Era l'uscita che non c'era: nello SDL non esisteva nessuna mutation che
    creasse una WorkflowDefinition, quindi un tenant senza workflow non ne
    usciva dall'interfaccia — ogni apertura di ticket si fermava e il rimedio
    era una migrazione da riga di comando. Admin.
    """
    provisionTenantData: TenantProvisioning!

    addWorkflowStep(
      definitionId:      ID!
      name:              String!
      label:             String!
      type:              String!
      timerDelayMinutes: Int
      subWorkflowId:     String
    ): WorkflowDefinition!

    removeWorkflowStep(
      definitionId: ID!
      stepName:     String!
    ): WorkflowDefinition!

    updateWorkflowStep(
      definitionId: ID!
      stepName:     String!
      label:        String!
      enterActions: String
      exitActions:  String
      # Scopo del passo: assente = non cambia, "" = tolto, altrimenti deve
      # stare in WORKFLOW_STEP_PURPOSES (vedi StepChangeInput.purpose).
      purpose:      String
    ): WorkflowStep!

    addWorkflowTransition(
      definitionId: ID!
      fromStepName: String!
      toStepName:   String!
      trigger:      String
      label:        String
      sourceHandle: String
      targetHandle: String
    ): WorkflowTransitionDef!

    removeWorkflowTransition(
      definitionId: ID!
      transitionId: ID!
    ): Boolean!

    updateWorkflowTransition(
      definitionId: ID!
      transitionId: ID!
      input:        UpdateTransitionInput!
    ): WorkflowDefinition!

    saveWorkflowLayout(
      definitionId: ID!
      positions:    [StepPositionInput!]!
    ): Boolean!

    # expectedVersion: optimistic lock — se la definizione ha una versione
    # diversa (salvata da un altro utente) la mutation fallisce con CONFLICT
    # invece di sovrascrivere. Null = nessun controllo (client legacy).
    saveWorkflowChanges(
      definitionId:    ID!
      transitions:     [TransitionChangeInput!]!
      positions:       [StepPositionInput!]!
      steps:           [StepChangeInput!]
      expectedVersion: Int
    ): WorkflowDefinition!

    executeWorkflowTransition(
      instanceId: ID!
      toStep: String!
      notes: String
    ): TransitionResult!

    # Notification Channels
    createNotificationChannel(input: CreateNotificationChannelInput!): NotificationChannel!
    updateNotificationChannel(id: ID!, input: CreateNotificationChannelInput!): NotificationChannel!
    deleteNotificationChannel(id: ID!): Boolean!

    createNotificationRule(input: CreateNotificationRuleInput!): NotificationRule!
    updateNotificationRule(id: ID!, input: UpdateNotificationRuleInput!): NotificationRule!
    deleteNotificationRule(id: ID!): Boolean!
    testNotificationChannel(id: ID!): Boolean!

    # Slack account linking
    linkSlackAccount(slackId: String!): User!
    """La propria scelta di ricevere le e-mail di notifica (menzioni, osservazione, regole, digest)."""
    setMyEmailNotifications(enabled: Boolean!): User!

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

    # Dashboard
    createDashboard(input: CreateDashboardInput!): DashboardConfig!
    updateDashboard(id: ID!, input: UpdateDashboardInput!): DashboardConfig!
    deleteDashboard(id: ID!): Boolean!
    cloneDashboard(id: ID!, newName: String!): DashboardConfig!
    addDashboardWidget(input: AddDashboardWidgetInput!): DashboardConfig!
    removeDashboardWidget(widgetId: ID!): DashboardConfig!
    updateDashboardWidget(widgetId: ID!, input: UpdateDashboardWidgetInput!): DashboardConfig!
    reorderDashboardWidgets(dashboardId: ID!, widgetIds: [ID!]!): DashboardConfig!
    # Custom Widgets
    createCustomWidget(input: CreateCustomWidgetInput!): CustomWidget!
    updateCustomWidget(id: ID!, input: UpdateCustomWidgetInput!): CustomWidget!
    deleteCustomWidget(id: ID!): Boolean!
    reorderCustomWidgets(dashboardId: ID!, widgetIds: [ID!]!): [CustomWidget!]!

    # Anomaly Detection
    resolveAnomaly(id: ID!, resolutionStatus: ResolutionStatus!, note: String!): Anomaly!
    runAnomalyScanner: Boolean!

    # ITIL Designer
    updateITILType(id: ID!, input: UpdateITILTypeInput!): CITypeDefinition!
    createITILField(typeId: ID!, input: ITILFieldInput!): CITypeDefinition!
    updateITILField(typeId: ID!, fieldId: ID!, input: ITILFieldInput!): CITypeDefinition!
    deleteITILField(typeId: ID!, fieldId: ID!): CITypeDefinition!

    # Tipi di CI esclusi per tipo di ticket (CM-8): sostituisce l'elenco intero.
    setTicketCIExclusions(ticketType: String!, ciTypes: [String!]!): TicketCIExclusions!

    # Discovery / Sync
    createSyncSource(input: CreateSyncSourceInput!): SyncSource!
    updateSyncSource(id: ID!, input: UpdateSyncSourceInput!): SyncSource!
    deleteSyncSource(id: ID!): Boolean!
    triggerSync(sourceId: ID!, syncType: String): SyncRun!
    resolveConflict(conflictId: ID!, resolution: String!): SyncConflict!
    testSyncConnection(sourceId: ID!): SyncConnectionTestResult!

    # Enum Types
    createEnumType(input: CreateEnumTypeInput!): EnumTypeDefinition!
    updateEnumType(id: ID!, input: UpdateEnumTypeInput!): EnumTypeDefinition!
    deleteEnumType(id: ID!): Boolean!
    """
    Cambia NOME a un valore, tenendolo al suo posto — e porta dietro tutto:
    i record che lo usano, le liste e la mappa delle severità della policy
    degli allarmi, le chiavi e le celle delle matrici di dominio, il valore di
    default del vocabolario. Tutto nella stessa transazione.

    Era l'operazione che il prodotto non aveva: il Dizionario sapeva solo
    aggiungere in coda e togliere, quindi «rinominare» voleva dire spostare il
    valore in fondo, e tre regole di dominio leggono il vocabolario per
    posizione (con quali conseguenze è scritto sul resolver).
    """
    renameEnumValue(id: ID!, from: String!, to: String!): EnumTypeDefinition!
    """
    Cambia l'ORDINE dei valori: lo stesso insieme, permutato. Per i vocabolari
    di scala l'ordine porta significato (l'impatto più alto è l'ultimo valore) e
    finora non era modificabile.
    """
    reorderEnumValues(id: ID!, values: [String!]!): EnumTypeDefinition!
    """
    Personalizza un vocabolario spedito col prodotto: crea la copia del tenant
    con gli stessi valori e la restituisce. Da lì si modifica; la copia vince in
    lettura solo per chi la possiede, gli altri clienti continuano a vedere
    quello spedito.
    """
    customizeEnumType(id: ID!): EnumTypeDefinition!
    """
    Adds to YOUR copy the shipped values it has not seen yet (appended, with their shipped labels and colors),
    and marks the current shipped list as seen.
    """
    adoptShippedValues(id: ID!): EnumTypeDefinition!
    """
    Keeps the shipped values your copy has not seen out of it, and marks the current shipped list as seen.
    """
    acknowledgeShippedValues(id: ID!): EnumTypeDefinition!

    # Approval Workflow
    createApprovalRequest(entityType: String!, entityId: String!, title: String!, description: String, approvers: [String!]!, approvalType: String, dueDate: String): ApprovalRequest!
    approveRequest(id: ID!, note: String): ApprovalRequest!
    rejectRequest(id: ID!, note: String!): ApprovalRequest!
    cancelApprovalRequest(id: ID!): ApprovalRequest!

    # Attachments
    deleteAttachment(id: ID!): Boolean!

    # Comments
    addComment(entityType: String!, entityId: String!, body: String!, isInternal: Boolean): EntityComment!
    updateComment(id: ID!, body: String!): EntityComment!
    deleteComment(id: ID!): Boolean!

    # Knowledge Base
    createKBArticle(title: String!, body: String!, category: String!, tags: [String!], status: String): KBArticle!
    # AI: bozza KB da incident risolto — crea un articolo in stato iniziale (draft)
    createKbDraftFromIncident(incidentId: ID!): KBArticle!
    updateKBArticle(id: ID!, title: String, body: String, category: String, tags: [String!]): KBArticle!
    restoreKBArticleVersion(articleId: ID!, version: Int!): KBArticle!
    createOLAContract(input: CreateOLAContractInput!): OLAContract!
    updateOLAContract(id: ID!, input: UpdateOLAContractInput!): OLAContract!
    deleteKBArticle(id: ID!): Boolean!
    rateKBArticle(id: ID!, helpful: Boolean!): KBArticle!

    # Queue Jobs (admin only)
    retryQueueJob(queueName: String!, jobId: ID!): Boolean!

    # Report Export
    exportReportPDF(templateId: ID!): String!
    exportReportExcel(templateId: ID!): String!

    # Report Schedule
    updateReportSchedule(templateId: ID!, enabled: Boolean!, cron: String, recipients: [String!], format: String): ReportTemplate!

    # Field Rules (admin)
    createFieldVisibilityRule(entityType: String!, triggerField: String!, triggerValue: String!, targetField: String!, action: String!): FieldVisibilityRule!
    updateFieldVisibilityRule(id: ID!, triggerField: String, triggerValue: String, targetField: String, action: String): FieldVisibilityRule!
    deleteFieldVisibilityRule(id: ID!): Boolean!
    setFieldRequirement(entityType: String!, fieldName: String!, required: Boolean!, workflowStep: String): FieldRequirementRule!
    deleteFieldRequirement(id: ID!): Boolean!

    # Portal (Self-Service)
    createTicket(title: String!, description: String, priority: String, category: String!, customFields: [CustomFieldInput!]): MyTicket!
    addTicketComment(ticketId: ID!, body: String!): EntityComment!
    reopenTicket(ticketId: ID!): MyTicket!
    "Quali severità del vocabolario offrire nel portale e con che parole (admin)."
    setPortalSeverityOptions(options: [PortalSeverityOptionInput!]!): [PortalSeverityOption!]!

  }

  # ── Domain enums ─────────────────────────────────────────────────────────────
  # NOTE: IncidentSeverity, IncidentStatus, ChangeStatus, ChangeType, ChangePriority,
  # ProblemStatus, ProblemPriority, ServiceRequestStatus, ServiceRequestPriority
  # are generated at runtime from the ITIL metamodel (scope: 'itil') by the schema
  # generator. They are NOT hardcoded here — see loadITILTypes + generateITILEnumsSDL.

  ${incidentSDL()}
  ${problemSDL()}
  ${changeSDL()}
  ${serviceRequestSDL()}
  ${userTeamSDL()}
  ${workflowSDL()}
  ${notificationSDL()}
  ${reportSDL()}
  ${olaSDL()}
  ${dashboardSDL()}
  ${anomalySDL()}
  ${organizationSDL()}
  ${rolesSDL()}
  ${slackSDL()}
  ${loginSDL()}
  ${eventsSDL()}
  ${servicesSDL()}
  ${topologySDL()}
  ${discoverySDL()}
  ${adminSDL()}
  ${monitoringSDL()}
  ${cmdbSDL()}
  ${enumTypeSDL()}
  ${domainMatrixSDL()}
  ${approvalSDL()}
  ${attachmentsSDL()}
  ${commentsSDL()}
  ${customFieldsSDL()}

  type EntityFilterField {
    name:       String!
    kind:       String!
    scalarName: String
    enumValues: [String!]
  }

  type GlobalSearchResults {
    cis:        [CIBase!]!
    changes:    [Change!]!
    incidents:  [Incident!]!
    problems:   [Problem!]!
    serviceRequests: [ServiceRequest!]!
    tasks:      [SearchTaskResult!]!
    kbArticles: [KBArticle!]!
  }

  type SearchTaskResult {
    id:         ID!
    code:       String!
    taskType:   String!
    status:     String!
    changeCode: String!
    changeId:   ID!
    ciName:     String!
  }
  ${knowledgeBaseSDL()}
  ${portalSDL()}
  ${fieldRulesSDL()}
  ${automationSchema}
  ${integrationsSchema}
  ${collaborationSchema}
  ${impactSDL()}
  ${whatifSDL()}

  ${similaritySDL}
  `
}
