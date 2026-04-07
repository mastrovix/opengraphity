import { gql } from '@apollo/client'

export const GET_INCIDENTS = gql`
  query GetIncidents($status: String, $severity: String, $limit: Int, $offset: Int, $filters: String, $sortField: String, $sortDirection: String) {
    incidents(status: $status, severity: $severity, limit: $limit, offset: $offset, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id title severity status createdAt
      }
    }
  }
`

export const GET_INCIDENT = gql`
  query GetIncident($id: ID!) {
    incident(id: $id) {
      id
      title
      description
      severity
      status
      rootCause
      createdAt
      updatedAt
      resolvedAt
      assignee { id name email }
      assignedTeam { id name }
      affectedCIs { id name type status environment }
      workflowInstance { id currentStep status }
      availableTransitions {
        toStep label requiresInput inputField condition
      }
      workflowHistory {
        id stepName enteredAt exitedAt durationMs
        triggeredBy triggerType notes
      }
      comments {
        id text createdAt updatedAt
        author { id name email }
      }
    }
  }
`

export const GET_USERS = gql`
  query GetUsers {
    users {
      id name email role createdAt
      teams { id name }
    }
  }
`

export const GET_USER = gql`
  query GetUser($id: ID!) {
    user(id: $id) {
      id name email role createdAt
      teams { id name type }
    }
  }
`

export const GET_TEAMS = gql`
  query GetTeams($filters: String) {
    teams(filters: $filters) { id name description type createdAt }
  }
`

export const GET_PROBLEMS = gql`
  query GetProblems($limit: Int, $offset: Int, $status: String, $priority: String, $search: String, $filters: String, $sortField: String, $sortDirection: String) {
    problems(limit: $limit, offset: $offset, status: $status, priority: $priority, search: $search, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id title priority status
        createdAt updatedAt
        assignee { id name }
        assignedTeam { id name }
        affectedCIs { id name type }
        relatedIncidents { id title status }
      }
    }
  }
`

export const GET_PROBLEM = gql`
  query GetProblem($id: ID!) {
    problem(id: $id) {
      id title description priority status
      rootCause workaround affectedUsers
      createdAt updatedAt resolvedAt
      createdBy { id name }
      assignee { id name email }
      assignedTeam { id name }
      affectedCIs { id name type status environment }
      relatedIncidents { id title status severity createdAt }
      relatedChanges { id title type status scheduledStart }
      workflowInstance { id currentStep status }
      availableTransitions { toStep label requiresInput inputField condition }
      workflowHistory { id stepName enteredAt exitedAt durationMs triggeredBy triggerType notes }
      comments { id text type createdAt author { id name } }
    }
  }
`

export const GET_CHANGES = gql`
  query GetChanges($status: String, $type: String, $priority: String, $search: String, $limit: Int, $offset: Int, $filters: String, $sortField: String, $sortDirection: String) {
    changes(status: $status, type: $type, priority: $priority, search: $search, limit: $limit, offset: $offset, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id title type priority status
        scheduledStart scheduledEnd
        createdAt updatedAt
        assignedTeam { id name }
        assignee { id name }
        affectedCIs { id name type }
        workflowInstance { id currentStep status }
      }
    }
  }
`

export const GET_SERVICE_REQUESTS = gql`
  query GetServiceRequests($status: String, $priority: String, $limit: Int, $offset: Int, $filters: String) {
    serviceRequests(status: $status, priority: $priority, limit: $limit, offset: $offset, filters: $filters) {
      id
      title
      priority
      status
      createdAt
    }
  }
`

export const GET_ALL_CIS = gql`
  query GetAllCIs($limit: Int, $offset: Int, $type: String, $environment: String, $status: String, $search: String, $ciTypes: [String], $filters: String, $sortField: String, $sortDirection: String) {
    allCIs(limit: $limit, offset: $offset, type: $type, environment: $environment, status: $status, search: $search, ciTypes: $ciTypes, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id name type status environment description createdAt
        ownerGroup { id name }
        supportGroup { id name }
      }
    }
  }
`

export const GET_CHANGE = gql`
  query GetChange($id: ID!) {
    change(id: $id) {
      id title description type priority status
      scheduledStart scheduledEnd
      implementedAt createdAt updatedAt
      assignedTeam { id name }
      assignee { id name email }
      createdBy { id name email }
      affectedCIs { id name type status environment }
      relatedIncidents { id title status severity }
      workflowInstance { id currentStep status }
      availableTransitions { toStep label requiresInput inputField condition }
      workflowHistory { id stepName enteredAt exitedAt durationMs triggeredBy triggerType notes }
      changeTasks {
        id taskType changeId status order title description
        scheduledStart scheduledEnd durationDays
        hasValidation validationStatus validationStart validationEnd validationNotes
        skipReason notes completedAt
        riskLevel impactDescription mitigation
        type createdAt
        ci { id name type environment ownerGroup { id name } supportGroup { id name } }
        assignedTeam { id name }
        assignee { id name }
        validationTeam { id name }
        validationUser { id name }
      }
      comments {
        id text type createdAt
        createdBy { id name }
      }
      impactAnalysis {
        riskScore riskLevel
        breakdown { productionCIs blastRadiusCIs openIncidents failedChanges ongoingChanges scoreDetails }
        blastRadius { id name type environment distance }
        openIncidents { id title severity status ciName ciId createdAt isOpen }
        recentChanges { id title type status ciName ciId createdAt }
      }
    }
  }
`

export const GET_CHANGE_IMPACT = gql`
  query GetChangeImpact($ciIds: [ID!]!) {
    changeImpactAnalysis(ciIds: $ciIds) {
      riskScore riskLevel
      breakdown { productionCIs blastRadiusCIs openIncidents failedChanges ongoingChanges scoreDetails }
      blastRadius { id name type environment distance }
      openIncidents { id title severity status ciName ciId createdAt isOpen }
      recentChanges { id title type status ciName ciId createdAt }
    }
  }
`

export const GET_WORKFLOW_LIST = gql`
  query GetWorkflowList {
    workflowDefinitions {
      id name entityType category active version
      steps { name label type }
    }
  }
`

export const GET_WORKFLOW_DEFINITION_BY_ID = gql`
  query GetWorkflowDefinitionById($id: ID!) {
    workflowDefinitionById(id: $id) {
      id name entityType category version active
      steps { id name label type enterActions exitActions }
      transitions {
        id fromStepName toStepName trigger label requiresInput inputField condition timerHours
      }
    }
  }
`

export const GET_WORKFLOW_DEFINITION = gql`
  query GetWorkflowDefinition($entityType: String!) {
    workflowDefinition(entityType: $entityType) {
      id name entityType category version active
      steps { id name label type enterActions exitActions }
      transitions {
        id fromStepName toStepName trigger label requiresInput inputField condition
      }
    }
  }
`

export const GET_TEAM = gql`
  query GetTeam($id: ID!) {
    team(id: $id) {
      id name description type createdAt
      members { id name email role }
      ownedCIs { id name type environment status }
      supportedCIs { id name type environment status }
    }
  }
`

export const GET_BLAST_RADIUS = gql`
  query GetBlastRadius($id: ID!) {
    blastRadius(id: $id) {
      distance
      parentId
      ci { id name type environment status }
    }
  }
`

export const GET_CI_CHANGES = gql`
  query GetCIChanges($ciId: ID!) {
    ciChanges(ciId: $ciId) {
      id title type priority status
      createdAt scheduledStart
    }
  }
`

export const GET_CI_INCIDENTS = gql`
  query GetCIIncidents($ciId: ID!) {
    ciIncidents(ciId: $ciId) {
      id title severity status
      createdAt updatedAt
    }
  }
`

export const GET_BASE_CI_TYPE = gql`
  query GetBaseCIType {
    baseCIType {
      id name label icon color active
      validationScript
      fields {
        id name label fieldType
        required enumValues order
        isSystem
        validationScript
        visibilityScript
        defaultScript
      }
      relations { id name label relationshipType targetType cardinality direction order }
      systemRelations { id name label relationshipType targetEntity required order }
    }
  }
`

export const GET_CI_TYPES = gql`
  query GetCITypes {
    ciTypes {
      id name label icon color active
      validationScript
      fields {
        id name label fieldType
        required enumValues order
        isSystem
        validationScript
        visibilityScript
        defaultScript
      }
      relations {
        id name label relationshipType
        targetType cardinality direction order
      }
      systemRelations {
        id name label relationshipType
        targetEntity required order
      }
    }
  }
`

export const GET_ITIL_TYPES = gql`
  query GetITILTypes {
    itilTypes {
      id name label icon color active validationScript
      fields {
        id name label fieldType
        required enumValues order isSystem
        enumTypeId enumTypeName
        validationScript visibilityScript defaultScript
      }
    }
  }
`

export const GET_ITIL_CI_RELATION_RULES = gql`
  query GetITILCIRelationRules($itilType: String!) {
    itilCIRelationRules(itilType: $itilType) {
      id itilType ciType relationType direction description
    }
  }
`

export const GET_ALL_ITIL_CI_RELATION_RULES = gql`
  query GetAllITILCIRelationRules {
    allITILCIRelationRules {
      id itilType ciType relationType direction description
    }
  }
`

export const GET_REPORT_TEMPLATES = gql`
  query GetReportTemplates {
    reportTemplates {
      id name description icon visibility
      scheduleEnabled scheduleCron
      createdAt
      createdBy { id name }
      sharedWith { id name }
      sections {
        id order title chartType
        groupByNodeId groupByField metric metricField
        limit sortDir
        nodes { id entityType neo4jLabel label isResult isRoot positionX positionY filters selectedFields }
        edges { id sourceNodeId targetNodeId relationshipType direction label }
      }
    }
  }
`

export const GET_REPORT_TEMPLATE = gql`
  query GetReportTemplate($id: ID!) {
    reportTemplate(id: $id) {
      id name description icon visibility
      scheduleEnabled scheduleCron scheduleChannelId
      scheduleRecipients scheduleFormat lastScheduledRun
      createdAt updatedAt
      createdBy { id name }
      sharedWith { id name }
      sections {
        id order title chartType
        groupByNodeId groupByField metric metricField limit sortDir
        nodes { id entityType neo4jLabel label isResult isRoot positionX positionY filters selectedFields }
        edges { id sourceNodeId targetNodeId relationshipType direction label }
      }
    }
  }
`

export const GET_NAVIGABLE_ENTITIES = gql`
  query GetNavigableEntities {
    navigableEntities {
      entityType label neo4jLabel
      fields { name label fieldType enumValues }
      relations {
        relationshipType direction label
        targetEntityType targetLabel targetNeo4jLabel
      }
    }
  }
`

export const GET_REACHABLE_ENTITIES = gql`
  query GetReachableEntities($fromNeo4jLabel: String!) {
    reachableEntities(fromNeo4jLabel: $fromNeo4jLabel) {
      entityType label neo4jLabel
      relationshipType direction count
      fields { name label fieldType enumValues }
    }
  }
`

export const EXECUTE_REPORT = gql`
  query ExecuteReport($templateId: ID!) {
    executeReport(templateId: $templateId) {
      sections { sectionId title chartType data total error }
    }
  }
`

export const PREVIEW_REPORT_SECTION = gql`
  query PreviewReportSection($input: ReportSectionInput!) {
    previewReportSection(input: $input) {
      sectionId title chartType data total error
    }
  }
`

export const GET_MY_DASHBOARDS = gql`
  query GetMyDashboards {
    myDashboards {
      id name description role isDefault isPersonal isShared
      visibility createdAt
      createdBy { id name }
      sharedWith { id name }
    }
  }
`

export const GET_DASHBOARD = gql`
  query GetDashboard($id: ID!) {
    dashboard(id: $id) {
      id name description role isDefault isPersonal isShared
      visibility
      createdBy { id name }
      sharedWith { id name }
      widgets {
        id order colSpan
        reportTemplateId reportSectionId
        data error
        reportSection { id title chartType }
        reportTemplate { id name }
      }
      customWidgets {
        id title widgetType entityType metric
        groupByField filterField filterValue timeRange
        size color position dashboardId
      }
    }
  }
`

export const GET_MY_DASHBOARD = gql`
  query GetMyDashboard {
    myDashboard {
      id name description role isDefault isPersonal isShared
      visibility
      widgets {
        id order colSpan reportTemplateId reportSectionId
        data error
        reportSection { id title chartType }
        reportTemplate { id name }
      }
      customWidgets {
        id title widgetType entityType metric
        groupByField filterField filterValue timeRange
        size color position dashboardId
      }
    }
  }
`

export const GET_WIDGET_DATA = gql`
  query GetWidgetData($widgetId: ID!) {
    widgetData(widgetId: $widgetId) {
      value label
      series { label value color }
    }
  }
`

export const GET_WIDGET_DATA_PREVIEW = gql`
  query GetWidgetDataPreview($entityType: String!, $metric: String!, $groupByField: String, $filterField: String, $filterValue: String, $timeRange: String) {
    widgetDataPreview(entityType: $entityType, metric: $metric, groupByField: $groupByField, filterField: $filterField, filterValue: $filterValue, timeRange: $timeRange) {
      value label
      series { label value color }
    }
  }
`

export const GET_ANOMALIES = gql`
  query GetAnomalies($status: String, $severity: String, $ruleKey: String, $limit: Int, $offset: Int, $filters: String, $sortField: String, $sortDirection: String) {
    anomalies(status: $status, severity: $severity, ruleKey: $ruleKey, limit: $limit, offset: $offset, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id ruleKey title severity status
        entityId entityType entitySubtype entityName
        description detectedAt resolvedAt
        resolutionStatus resolutionNote resolvedBy
      }
    }
  }
`

export const GET_ANOMALY_STATS = gql`
  query GetAnomalyStats {
    anomalyStats {
      total open critical high medium low falsePositive acceptedRisk
    }
  }
`

export const RESOLVE_ANOMALY = gql`
  mutation ResolveAnomaly($id: ID!, $resolutionStatus: ResolutionStatus!, $note: String!) {
    resolveAnomaly(id: $id, resolutionStatus: $resolutionStatus, note: $note) {
      id status resolutionStatus resolutionNote resolvedBy resolvedAt
    }
  }
`

export const RUN_ANOMALY_SCANNER = gql`
  mutation RunAnomalyScanner {
    runAnomalyScanner
  }
`

export const GET_ANOMALY_SCAN_STATUS = gql`
  query GetAnomalyScanStatus {
    anomalyScanStatus {
      lastScanAt
      totalScans
    }
  }
`

export const GET_ENUM_TYPES = gql`
  query GetEnumTypes($scope: String) {
    enumTypes(scope: $scope) {
      id name label values isSystem scope createdAt updatedAt
    }
  }
`

export const GET_ENUM_TYPE = gql`
  query GetEnumType($id: ID!) {
    enumType(id: $id) {
      id name label values isSystem scope createdAt updatedAt
    }
  }
`

export const GET_TOPOLOGY = gql`
  query GetTopology($types: [String!], $environment: String, $status: String, $selectedCiId: ID, $maxHops: Int) {
    topology(types: $types, environment: $environment, status: $status, selectedCiId: $selectedCiId, maxHops: $maxHops) {
      nodes {
        id name type status environment ownerGroup incidentCount changeCount
      }
      edges {
        source target type
      }
      truncated
    }
  }
`

export const GET_NOTIFICATION_RULES = gql`
  query GetNotificationRules {
    notificationRules {
      id eventType enabled severityOverride titleKey channels target conditions isSeed
      escalationDelayMinutes escalationTarget escalationMessage
      slaWarningThresholdPercent slaWarningTarget
      digestTime digestRecipients
    }
  }
`

export const GET_QUEUE_STATS = gql`
  query GetQueueStats {
    queueStats {
      name
      counts {
        waiting active completed failed delayed paused
      }
    }
  }
`

export const GET_SYSTEM_HEALTH = gql`
  query GetSystemHealth {
    systemHealth {
      status uptime
      checks {
        neo4j    { status latencyMs error }
        redis    { status latencyMs error }
        keycloak { status latencyMs error }
      }
    }
  }
`

export const GET_SYSTEM_METRICS = gql`
  query GetSystemMetrics {
    systemMetrics {
      requests {
        totalRequests requestsPerMinute averageResponseMs p95ResponseMs errorRate
        statusCodes { code count }
      }
      graphql {
        totalOperations
        slowestResolvers { name averageMs maxMs count }
        errorsByResolver { name count lastError }
      }
      queues { name waiting active completed failed delayed }
      neo4j {
        totalQueries averageQueryMs connectionPoolActive connectionPoolIdle
        slowQueries { query durationMs timestamp }
      }
      system { memoryUsageMb memoryRssMb cpuUsagePercent nodeVersion uptimeSeconds pid }
    }
  }
`

export const GET_TRACE_INFO = gql`
  query GetTraceInfo {
    traceInfo {
      enabled endpoint
      recentTraces { traceId operationName durationMs status timestamp spanCount }
    }
  }
`

export const GET_QUEUE_JOBS = gql`
  query GetQueueJobs($queueName: String!, $status: String, $limit: Int) {
    queueJobs(queueName: $queueName, status: $status, limit: $limit) {
      id name queueName status data
      timestamp processedOn finishedOn
      failedReason stacktrace
      attemptsMade maxAttempts returnValue
    }
  }
`

export const GET_FIELD_VISIBILITY_RULES = gql`
  query GetFieldVisibilityRules($entityType: String!) {
    fieldVisibilityRules(entityType: $entityType) {
      id entityType triggerField triggerValue targetField action
    }
  }
`

export const GET_FIELD_REQUIREMENT_RULES = gql`
  query GetFieldRequirementRules($entityType: String!, $workflowStep: String) {
    fieldRequirementRules(entityType: $entityType, workflowStep: $workflowStep) {
      id entityType fieldName required workflowStep
    }
  }
`

// ── Automation ───────────────────────────────────────────────────────────────

export const GET_AUTO_TRIGGERS = gql`
  query GetAutoTriggers($entityType: String) {
    autoTriggers(entityType: $entityType) {
      id name entityType eventType conditions timerDelayMinutes
      actions enabled executionCount lastExecutedAt
    }
  }
`

export const GET_BUSINESS_RULES = gql`
  query GetBusinessRules($entityType: String) {
    businessRules(entityType: $entityType) {
      id name description entityType eventType conditionLogic
      conditions actions priority stopOnMatch enabled
    }
  }
`

export const GET_SLA_POLICIES = gql`
  query GetSLAPolicies($entityType: String) {
    slaPolicies(entityType: $entityType) {
      id name entityType priority category teamId teamName
      timezone responseMinutes resolveMinutes businessHours enabled
    }
  }
`

export const GET_SERVICE_REQUEST = gql`
  query GetServiceRequest($id: ID!) {
    serviceRequest(id: $id) {
      id tenantId title description status priority dueDate
      createdAt updatedAt completedAt
      requestedBy { id name email }
      assignee { id name email }
    }
  }
`

// ── Collaboration ────────────────────────────────────────────────────────────

export const SEARCH_USERS = gql`
  query SearchUsers($search: String!, $limit: Int) {
    searchUsers(search: $search, limit: $limit) { id name email }
  }
`

export const GET_WATCHERS = gql`
  query GetWatchers($entityType: String!, $entityId: ID!) {
    watchers(entityType: $entityType, entityId: $entityId) { id name email watchedAt }
  }
`

export const IS_WATCHING = gql`
  query IsWatching($entityType: String!, $entityId: ID!) {
    isWatching(entityType: $entityType, entityId: $entityId)
  }
`

export const GET_INTERNAL_MESSAGES = gql`
  query GetInternalMessages($entityType: String!, $entityId: ID!, $limit: Int) {
    internalMessages(entityType: $entityType, entityId: $entityId, limit: $limit) {
      id authorId authorName body mentions createdAt editedAt
    }
  }
`
