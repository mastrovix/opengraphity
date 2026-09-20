/**
 * OGNI OPERAZIONE DELL'API → I PERMESSI CHE LA APRONO (ondata 7 di «Nulla cablato»).
 *
 * Una riga dice: queste operazioni si eseguono con ALMENO UNO di questi
 * permessi. Il catalogo dei permessi sta in `@opengraphity/types`
 * (`PERMISSION_CATALOG`); qui si decide solo quale operazione chiede cosa.
 *
 * Tre regole:
 *  - un'operazione compare in una riga sola: un doppione fa fallire il modulo
 *    al caricamento, perché due righe direbbero due cose diverse;
 *  - un campo root senza riga fa fallire l'avvio (`applyAuthorizationPolicy`):
 *    un'operazione nuova va decisa, non ereditata per caso;
 *  - le query e le mutation generate per ogni tipo di CI (`servers`,
 *    `createServer`, …) non hanno una riga: seguono `cmdb.read` / `cmdb.write`
 *    (`DYNAMIC_CI_PERMISSIONS`), perché i loro nomi li sceglie il cliente.
 *
 * `AUTHENTICATED` marca le poche letture concesse a chiunque entri con un ruolo:
 * il proprio profilo, la lingua, il marchio dell'organizzazione e cosa si può
 * allegare. Non sono nella matrice perché senza di esse nessuna pagina parte.
 */
import type { Permission } from '@opengraphity/types'

export type RootKind = 'Query' | 'Mutation'

export const AUTHENTICATED = 'authenticated' as const
export type OperationRequirement = readonly Permission[] | typeof AUTHENTICATED

/** Leggere un qualunque tipo di ticket. */
const TICKET_READ: readonly Permission[] = ['incident.read', 'problem.read', 'change.read', 'request.read']

const RULES: ReadonlyArray<{ anyOf: OperationRequirement; query?: readonly string[]; mutation?: readonly string[] }> = [
  { anyOf: AUTHENTICATED, query: ['me', 'tenantLanguageSettings', 'tenantBrand', 'attachmentPolicy'], mutation: ['setMyLanguage'] },

  // ── Accesso ────────────────────────────────────────────────────────────────
  // L'area di lavoro dello staff: ricerca, filtri, attività e approvazioni
  // proprie, osservare un ticket, e i dati di riferimento che ogni pagina legge
  // (team, persone, tipi, vocabolari, workflow, calendari).
  {
    anyOf: ['workspace.use'],
    query: [
      'globalSearch', 'entityFilterFields', 'searchUsers', 'users', 'user', 'teams', 'team',
      'myTasks', 'myPendingApprovals', 'pendingTicketApprovals', 'myNotifications', 'isWatching', 'watchers',
      'notificationRouting', 'aiSettings', 'tenantTimezoneSettings', 'tenantInAppRetentionDays', 'serviceCalendars',
      'ciTypes', 'baseCIType', 'itilTypes', 'itilTypeFields', 'ticketCIExclusions',
      'enumTypes', 'enumType', 'criticalServiceCriticalities', 'preApprovedChangeTypes', 'riskBandThresholds',
      'navigableEntities', 'navigableRelations', 'reachableEntities',
      'workflowDefinitions', 'workflowDefinition', 'workflowDefinitionById', 'workflowEventTypes',
      // Solo nome ed etichetta dei passi, per LEGGERE uno stato: stesso
      // permesso di `workflowDefinition`, che è dove si leggono oggi.
      'workflowStepLabels',
      'olaContracts', 'ticketOLAs', 'slaCoverage', 'ticketCreationCustomFields',
    ],
    mutation: ['watchEntity', 'unwatchEntity', 'linkSlackAccount'],
  },
  {
    anyOf: ['workspace.notificationsManage'],
    mutation: ['markNotificationRead', 'markAllNotificationsRead', 'dismissAllNotifications', 'setMyEmailNotifications'],
  },
  { anyOf: ['portal.read'], query: ['myTickets', 'myTicket', 'myTicketStats', 'portalSeverityChoices', 'portalCustomFields'] },
  { anyOf: ['workspace.use', 'portal.read'], query: ['ticketCategories', 'fieldVisibilityRules', 'fieldRequirementRules'] },
  { anyOf: ['portal.submit'], mutation: ['createTicket', 'addTicketComment', 'reopenTicket'] },

  /**
   * I COMPITI DI UN TICKET non hanno un permesso proprio: vale quello del
   * ticket a cui sono appesi. Qui la regola è l'UNIONE dei permessi dei tipi
   * che possono avere compiti — questo guardiano pretende una regola per ogni
   * campo dello schema, e il tipo del ticket si sa solo a runtime — mentre il
   * controllo PRECISO lo fa il resolver (`resolvers/ticketTasks.ts`), sul
   * tipo che il compito ha davvero. Un permesso «task.read» a sé sarebbe la
   * strada per cui un giorno qualcuno legge dai titoli dei compiti quello che
   * il ticket non gli mostra.
   */
  {
    anyOf: ['incident.read', 'problem.read', 'change.read', 'request.read', 'kb.read'],
    query: ['ticketTasks'],
  },
  /**
   * I CAMPI RIFERIMENTO dei moduli, per il disegnatore dei workflow: nome,
   * etichetta e tipo, niente altro. Prima si allargava `formFields` a
   * `config.workflow`, ma quella porta anche gli script di validazione e le
   * formule del cliente — per una tendina bastano tre stringhe (20 set 2026).
   */
  { anyOf: ['config.workflow', 'config.catalog'], query: ['formReferenceFields'] },
  {
    anyOf: ['incident.write', 'problem.write', 'change.write', 'request.write', 'kb.write'],
    mutation: ['claimTicketTask', 'completeTicketTask', 'cancelTicketTask'],
  },

  // ── Ticket ─────────────────────────────────────────────────────────────────
  {
    anyOf: ['incident.read'],
    query: ['incidents', 'incident', 'incidentAvailableTransitions', 'incidentWorkflow', 'incidentWorkflowHistory', 'similarIncidents', 'suggestedArticles'],
  },
  {
    anyOf: ['incident.write'],
    mutation: ['createIncident', 'updateIncident', 'resolveIncident', 'assignIncidentToTeam', 'assignIncidentToUser',
      'addIncidentComment', 'setIncidentMajor', 'createKbDraftFromIncident'],
  },
  { anyOf: ['incident.ai'], query: ['triageSuggestion', 'resolutionDraft'] },
  { anyOf: ['incident.write', 'problem.write'], mutation: ['linkIncidentToProblem', 'unlinkIncidentFromProblem'] },
  { anyOf: ['incident.read', 'problem.read'], query: ['knownErrors'] },
  { anyOf: ['problem.read'], query: ['problems', 'problem', 'problemCandidates', 'ciProblems'] },
  {
    anyOf: ['problem.write'],
    mutation: ['createProblem', 'updateProblem', 'assignProblemToTeam', 'assignProblemToUser', 'addProblemComment',
      'executeProblemTransition', 'addCIToProblem', 'removeCIFromProblem'],
  },
  // LA CANCELLAZIONE DEI TICKET — una regola sola (revisione del 14 set 2026 · F14),
  // pinnata da graphql/__tests__/ticketDeletionPolicy.test.ts:
  //  - change: cancellazione LOGICA (approvazioni e audit restano leggibili);
  //  - problem: cancellazione FISICA con cascata completa e job di breach annullati;
  //  - incident e richieste non si cancellano: si chiudono o si annullano col workflow.
  { anyOf: ['problem.delete'], mutation: ['deleteProblem'] },
  {
    anyOf: ['change.read'],
    query: ['changes', 'change', 'changeAffectedCIs', 'changeAuditTrail', 'changeCalendar', 'changeImpactAnalysis', 'changeImpactedCIs',
      'ciChanges', 'taskById', 'approvalRequests', 'assessmentQuestionCatalog'],
  },
  {
    anyOf: ['change.write'],
    mutation: ['createChange', 'executeChangeTransition', 'addCIToChange', 'removeCIFromChange',
      'assignAssessmentTaskToTeam', 'assignAssessmentTaskToUser', 'submitAssessmentResponse', 'completeAssessmentTask', 'reopenAssessmentTask',
      'saveDeployPlan', 'assignDeployPlanTaskToUser', 'completeDeployPlanTask', 'reopenDeployPlanTask',
      'completeDeployment', 'reopenDeploymentTask', 'completeValidationTest', 'reopenValidationTest',
      'completeReview', 'reopenReviewTask', 'sendTaskReminder'],
  },
  { anyOf: ['change.delete'], mutation: ['deleteChange'] },
  { anyOf: ['request.read'], query: ['serviceRequests', 'serviceRequest', 'ciServiceRequests'] },
  { anyOf: ['request.write'], mutation: ['addCIToServiceRequest', 'removeCIFromServiceRequest'] },
  { anyOf: ['request.read', 'portal.read'], query: ['serviceCatalogItems', 'catalogFormToFill',
    // Le scelte di un campo «riferimento» del modulo: chi può vedere il
    // modulo può vedere le sue scelte, e sono i CI dei tipi che il campo
    // dichiara — non la CMDB (20 set 2026).
    'portalReferenceChoices'] },
  { anyOf: ['request.write'], mutation: ['updateServiceRequest', 'assignServiceRequestToUser', 'setServiceRequestFormAnswer'] },
  { anyOf: ['request.write', 'portal.submit'], mutation: ['createServiceRequest'] },
  // Il passo di workflow per id d'istanza: vale per incident, richieste e articoli.
  { anyOf: ['incident.write', 'problem.write', 'request.write', 'kb.write'], mutation: ['executeWorkflowTransition'] },
  { anyOf: TICKET_READ, query: ['comments', 'attachments'] },
  {
    anyOf: ['ticket.work'],
    mutation: ['addComment', 'setTicketCustomFields', 'addAffectedCI', 'removeAffectedCI',
      'addWatcher', 'removeWatcher', 'linkRelatedTicket', 'unlinkRelatedTicket', 'linkResolvedTicket', 'unlinkResolvedTicket'],
  },
  // Il resolver limita la modifica ai commenti propri (e pubblici, dal portale).
  { anyOf: ['ticket.work', 'portal.submit'], mutation: ['updateComment', 'deleteComment'] },
  /**
   * `deleteAttachment` anche dal portale (moduli del catalogo, ondata 2): un
   * campo allegato si compila caricando i file su una BOZZA, e chi compila deve
   * poter togliere un file scelto per sbaglio prima di inviare. Il resolver
   * resta il guardiano vero — cancella solo chi ha caricato, o chi modera.
   */
  { anyOf: ['ticket.work', 'portal.submit'], mutation: ['deleteAttachment'] },
  {
    anyOf: ['ticket.internalChat'],
    query: ['internalMessages'],
    mutation: ['sendInternalMessage', 'editInternalMessage', 'deleteInternalMessage'],
  },
  {
    anyOf: ['approval.decide'],
    mutation: ['createApprovalRequest', 'cancelApprovalRequest', 'approveRequest', 'rejectRequest', 'approveChangeApproval', 'rejectChangeApproval'],
  },

  // ── Knowledge base ─────────────────────────────────────────────────────────
  { anyOf: ['kb.read'], query: ['kbArticleVersions'] },
  { anyOf: ['kb.read', 'portal.read'], query: ['kbArticles', 'kbArticle', 'kbArticleBySlug', 'kbCategories'] },
  { anyOf: ['kb.write'], mutation: ['createKBArticle', 'updateKBArticle', 'deleteKBArticle', 'restoreKBArticleVersion'] },
  { anyOf: ['kb.rate'], mutation: ['rateKBArticle'] },

  // ── CMDB e monitoraggio ────────────────────────────────────────────────────
  { anyOf: ['cmdb.read'], query: ['allCIs', 'ciById', 'ciGroupMembers', 'ciIncidents', 'topology', 'blastRadius'] },
  { anyOf: ['cmdb.write'], mutation: ['updateCIFields', 'addCIRelationship', 'removeCIRelationship', 'assignCIOwner', 'assignCISupportGroup'] },
  {
    anyOf: ['event.read'],
    query: ['events', 'event', 'eventStats', 'monitoringSourceRefs', 'ciHealth', 'ciHealthOverview', 'businessCapabilitiesHealth', 'ciAliases', 'eventPolicy'],
  },
  {
    anyOf: ['event.work'],
    mutation: ['acknowledgeEvent', 'resolveEvent', 'linkEventToCI', 'createIncidentFromEvent', 'setCIHealthOverride', 'reevaluateEvent'],
  },
  { anyOf: ['service.read'], query: ['serviceMaps', 'serviceMap', 'servicesImpactedByCI'] },
  { anyOf: ['service.reevaluate'], mutation: ['reevaluateServiceMap'] },

  // ── Analisi e report ───────────────────────────────────────────────────────
  { anyOf: ['analysis.read'], query: ['anomalies', 'anomaly', 'anomalyStats', 'anomalyScanStatus', 'whatIfAnalysis', 'whatIfCompare'] },
  { anyOf: ['anomaly.resolve'], mutation: ['resolveAnomaly'] },
  { anyOf: ['anomaly.scan'], mutation: ['runAnomalyScanner'] },
  // Le proposte di miglioramento. Accettare e rifiutare stanno sotto lo
  // STESSO permesso: rifiutare scrive la lapide che zittisce l'impronta, e
  // zittire una proposta è una decisione quanto accettarla.
  { anyOf: ['proposal.read'],   query: ['proposals', 'proposal'] },
  // Gli aggregati del lavoro quotidiano: misure della squadra, non dati di un
  // ticket — stesso permesso delle anomalie.
  { anyOf: ['analysis.read'],   query: ['dailyWorkAggregates'] },
  { anyOf: ['proposal.accept'], mutation: ['acceptProposal', 'rejectProposal', 'postponeProposal', 'undoProposal'] },
  { anyOf: ['proposal.run'],    mutation: ['runProposalAnalysis'] },
  {
    anyOf: ['report.read'],
    query: ['reportTemplates', 'reportTemplate', 'executeReport', 'previewReportSection', 'slaReport', 'reportConversations', 'reportConversation'],
    mutation: ['deleteReportConversation'],
  },
  {
    anyOf: ['report.write'],
    mutation: ['createReportTemplate', 'updateReportTemplate', 'deleteReportTemplate', 'duplicateReportTemplate',
      'addReportSection', 'updateReportSection',
      // La PROPOSTA dell'AI non scrive niente, ma costa una chiamata al
      // modello e riempie il costruttore: la puo chiedere chi salva i report.
      'proposeReportSection', 'removeReportSection', 'reorderReportSections', 'exportReportPDF', 'exportReportExcel'],
  },
  { anyOf: ['report.schedule'], mutation: ['updateReportSchedule'] },
  { anyOf: ['report.ai'], mutation: ['askReport'] },
  {
    anyOf: ['dashboard.use'],
    query: ['dashboard', 'myDashboard', 'myDashboards', 'customWidgets', 'widgetData', 'widgetDataPreview', 'widgetCatalog'],
    mutation: ['createDashboard', 'updateDashboard', 'deleteDashboard', 'cloneDashboard', 'saveDashboardLayout',
      'addDashboardWidget', 'removeDashboardWidget', 'updateDashboardWidget', 'reorderDashboardWidgets',
      'createCustomWidget', 'updateCustomWidget', 'deleteCustomWidget', 'reorderCustomWidgets'],
  },

  // ── Configurazione ─────────────────────────────────────────────────────────
  {
    anyOf: ['config.organization'],
    query: ['tenantName', 'tenantBrandSettings', 'ticketNumbering', 'portalSeverityOptions', 'scriptingSettings'],
    mutation: ['setTenantName', 'setTenantBrand', 'setTenantDefaultLanguage', 'setTenantTimezone', 'setTenantInAppRetentionDays',
      'setTicketNumbering', 'setAttachmentPolicy', 'setAISettings', 'setPortalSeverityOptions',
      // L'interruttore degli script del cliente (moduli del catalogo, ondata 6).
      'setScriptingEnabled',
      'createServiceCalendar', 'updateServiceCalendar', 'deleteServiceCalendar'],
  },
  {
    anyOf: ['config.metamodel'],
    query: ['domainMatrices', 'changeEnvironmentWeight', 'impactAnalysisWeights', 'ciTypeDeletionImpact', 'itilFieldValueCount', 'ciFieldValueCount', 'enumValueUsage', 'ticketWorkflowSteps'],
    mutation: [
      'createCIType', 'updateCIType', 'deleteCIType', 'addCIField', 'updateCIField', 'removeCIField', 'addCIRelation', 'removeCIRelation',
      'updateITILType', 'createITILField', 'updateITILField', 'deleteITILField', 'setTicketCIExclusions',
      'createEnumType', 'updateEnumType', 'deleteEnumType', 'customizeEnumType', 'renameEnumValue', 'reorderEnumValues',
      'adoptShippedValues', 'acknowledgeShippedValues',
      'updateDomainMatrix', 'updatePreApprovedChangeTypes', 'updateRiskBandThresholds', 'updateChangeEnvironmentWeight', 'updateImpactAnalysisWeights',
      'createFieldVisibilityRule', 'updateFieldVisibilityRule', 'deleteFieldVisibilityRule', 'setFieldRequirement', 'deleteFieldRequirement',
      // La libreria dei campi dei moduli (moduli del catalogo, ondata 1):
      // definisce PROPRIETA dei ticket, quindi sta col metamodello e non col
      // catalogo — chi compone un modulo (config.catalog) sceglie fra i campi
      // che esistono, chi ne crea uno nuovo tocca la forma dei dati.
      'createFormField', 'updateFormField', 'deleteFormField',
      // Il tetto tecnico sulla libreria e sui moduli (ondata 4): sta con chi
      // puo' creare i campi, perche' alzarlo vuol dire poterne creare altri.
      'setCatalogFormLimits',
    ],
  },
  {
    anyOf: ['config.workflow'],
    mutation: ['addWorkflowStep', 'removeWorkflowStep', 'updateWorkflowStep', 'addWorkflowTransition', 'removeWorkflowTransition',
      'updateWorkflowTransition', 'saveWorkflowLayout', 'saveWorkflowChanges',
      // Duplicare una definizione e metterla in servizio (moduli del catalogo, ondata 3).
      'duplicateWorkflowDefinition', 'setWorkflowDefinitionActive'],
  },
  {
    anyOf: ['config.sla'],
    query: ['slaPolicies'],
    mutation: ['createSLAPolicy', 'updateSLAPolicy', 'deleteSLAPolicy', 'createOLAContract', 'updateOLAContract', 'deleteOLAContract'],
  },
  {
    anyOf: ['config.automation'],
    query: ['autoTriggers', 'businessRules'],
    mutation: ['createAutoTrigger', 'updateAutoTrigger', 'deleteAutoTrigger', 'createBusinessRule', 'updateBusinessRule', 'deleteBusinessRule', 'reorderBusinessRules'],
  },
  {
    anyOf: ['config.notifications'],
    query: ['notificationChannels', 'notificationRules'],
    mutation: ['createNotificationChannel', 'updateNotificationChannel', 'deleteNotificationChannel', 'testNotificationChannel',
      'createNotificationRule', 'updateNotificationRule', 'deleteNotificationRule'],
  },
  {
    anyOf: ['config.catalog'],
    query: ['assessmentQuestionsAdmin', 'questionCITypeAssignments', 'formFields', 'catalogForm', 'catalogFormLimits'],
    mutation: ['saveCatalogForm',
      // La PROPOSTA dell'AI non scrive niente, quindi basta poter comporre un
      // modulo; se chi chiede non ha anche `config.metamodel` la proposta
      // esce di solo riuso, perche' i campi nuovi non potrebbe crearli.
      'proposeServiceRequestDesign',
      'createServiceCatalogItem', 'updateServiceCatalogItem', 'createAssessmentQuestion', 'updateAssessmentQuestion',
      'deleteAssessmentQuestion', 'assignQuestionToCIType', 'removeQuestionFromCIType', 'setQuestionCore'],
  },
  {
    anyOf: ['config.monitoring'],
    query: ['monitoringSources', 'monitoringSource', 'payloadKeys', 'sampleInboundPayload', 'anomalyRules', 'anomalyRuleOptions'],
    mutation: ['createCIAlias', 'deleteCIAlias', 'updateEventPolicy', 'sendSampleEvent', 'previewInboundEvents', 'updateAnomalyRule'],
  },
  {
    anyOf: ['config.services'],
    query: ['serviceMapCandidates', 'serviceMapCreationPreview', 'serviceMapProposal', 'serviceImpactPreview', 'serviceRelationshipTypes'],
    mutation: ['createServiceMap', 'setServiceMapStatus', 'deleteServiceMap', 'updateServiceImpactRules', 'updateServiceMapNodes',
      'applyServiceMapProposal', 'removeServiceMapExclusion', 'setServiceMapAutoSync', 'syncServiceMap', 'updateServiceMapScope'],
  },
  {
    anyOf: ['config.integrations'],
    query: ['apiKeys', 'inboundWebhooks', 'outboundWebhooks', 'syncSources', 'syncSource', 'syncRuns', 'syncConflicts', 'syncStats',
      'availableConnectors', 'syncChangeHistory', 'slackSettings'],
    mutation: ['createApiKey', 'updateApiKey', 'deleteApiKey', 'regenerateApiKey',
      'createInboundWebhook', 'updateInboundWebhook', 'deleteInboundWebhook', 'regenerateWebhookToken',
      'createOutboundWebhook', 'updateOutboundWebhook', 'deleteOutboundWebhook', 'testOutboundWebhook',
      'createSyncSource', 'updateSyncSource', 'deleteSyncSource', 'triggerSync', 'resolveConflict', 'testSyncConnection',
      'startSlackInstall', 'connectSlackWithToken', 'disconnectSlack'],
  },

  // ── Amministrazione ────────────────────────────────────────────────────────
  {
    anyOf: ['admin.users'],
    mutation: ['createUser', 'updateUserTeams', 'setUserRole', 'setUserActive', 'createTeam', 'updateTeam', 'setTeamManager', 'removeTeamManager', 'setTeamMember', 'setChangeManagerTeam',
      'createRole', 'updateRole', 'deleteRole'],
  },
  // Chi entra e come (ondata 8): regole delle password e login aziendale del realm dell'organizzazione.
  {
    anyOf: ['admin.users'],
    query: ['loginSettings'],
    mutation: ['setPasswordRules', 'testLoginProvider', 'saveLoginProvider', 'deactivateLoginProvider', 'removeLoginProvider'],
  },
  // I ruoli li legge chi assegna ruoli alle persone e chi indirizza notifiche «per ruolo».
  { anyOf: ['admin.users', 'config.notifications', 'config.workflow', 'config.automation'], query: ['roles'] },
  // `auditEntityTypes`: i tipi di entità presenti nel registro, per il filtro
  // della pagina Audit Log (revisione totale · G-20). Stesso permesso del resto.
  { anyOf: ['admin.audit'], query: ['logs', 'auditLog', 'auditActions', 'auditEntityTypes'] },
  {
    anyOf: ['admin.system'],
    query: ['tenantProvisioningGaps', 'configurationIssues', 'queueStats', 'queueJobs', 'systemHealth', 'systemMetrics', 'traceInfo'],
    mutation: ['provisionTenantData', 'retryQueueJob'],
  },
]

/** Le operazioni generate per ogni tipo di CI: i nomi li sceglie il cliente. */
export const DYNAMIC_CI_PERMISSIONS: Readonly<Record<RootKind, readonly Permission[]>> = {
  Query:    ['cmdb.read'],
  Mutation: ['cmdb.write'],
}

function buildMap(): ReadonlyMap<string, OperationRequirement> {
  const map = new Map<string, OperationRequirement>()
  const duplicates: string[] = []
  for (const rule of RULES) {
    for (const [kind, names] of [['Query', rule.query ?? []], ['Mutation', rule.mutation ?? []]] as const) {
      for (const name of names) {
        const key = `${kind}.${name}`
        if (map.has(key)) duplicates.push(key)
        map.set(key, rule.anyOf)
      }
    }
  }
  if (duplicates.length) {
    throw new Error(`[operationPermissions] operations listed twice: ${duplicates.join(', ')}`)
  }
  return map
}

/** `Query.incidents` → `['incident.read']`. */
export const OPERATION_PERMISSIONS: ReadonlyMap<string, OperationRequirement> = buildMap()

export function operationRequirement(kind: RootKind, field: string): OperationRequirement | undefined {
  return OPERATION_PERMISSIONS.get(`${kind}.${field}`)
}
