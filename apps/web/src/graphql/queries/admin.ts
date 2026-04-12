import { gql } from '@apollo/client'

// ── Users & Teams ───────────────────────────────────────────────────────────

export const GET_USERS = gql`
  query GetUsers($sortField: String, $sortDirection: String) {
    users(sortField: $sortField, sortDirection: $sortDirection) {
      id name email role createdAt
      teams { id name }
    }
  }
`

export const GET_USER = gql`
  query GetUser($id: ID!) {
    user(id: $id) {
      id tenantId name code firstName lastName email role slackId createdAt
      teams { id name type }
    }
  }
`

export const GET_TEAMS = gql`
  query GetTeams($filters: String, $sortField: String, $sortDirection: String) {
    teams(filters: $filters, sortField: $sortField, sortDirection: $sortDirection) { id name description type createdAt }
  }
`

export const GET_TEAM = gql`
  query GetTeam($id: ID!) {
    team(id: $id) {
      id tenantId name description type createdAt
      manager { id name email }
      members { id name email role }
      ownedCIs { id name type environment status }
      supportedCIs { id name type environment status }
    }
  }
`

export const SEARCH_USERS = gql`
  query SearchUsers($search: String!, $limit: Int) {
    searchUsers(search: $search, limit: $limit) { id name email }
  }
`

// ── Reports ─────────────────────────────────────────────────────────────────

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

// ── Dashboard ───────────────────────────────────────────────────────────────

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

// ── Anomaly ─────────────────────────────────────────────────────────────────

export const GET_ANOMALIES = gql`
  query GetAnomalies($limit: Int, $offset: Int, $filters: String, $sortField: String, $sortDirection: String) {
    anomalies(limit: $limit, offset: $offset, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
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

// ── Enums ───────────────────────────────────────────────────────────────────

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

// ── Notifications ───────────────────────────────────────────────────────────

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

// ── Queues & Monitoring ─────────────────────────────────────────────────────

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

// ── Rules ───────────────────────────────────────────────────────────────────

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

// ── Automation ──────────────────────────────────────────────────────────────

export const GET_AUTO_TRIGGERS = gql`
  query GetAutoTriggers($entityType: String, $filters: String, $sortField: String, $sortDirection: String) {
    autoTriggers(entityType: $entityType, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      id name entityType eventType conditions timerDelayMinutes
      actions enabled executionCount lastExecutedAt
    }
  }
`

export const GET_BUSINESS_RULES = gql`
  query GetBusinessRules($entityType: String, $filters: String, $sortField: String, $sortDirection: String) {
    businessRules(entityType: $entityType, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      id name description entityType eventType conditionLogic
      conditions actions priority stopOnMatch enabled
    }
  }
`

export const GET_SLA_POLICIES = gql`
  query GetSLAPolicies($entityType: String, $filters: String, $sortField: String, $sortDirection: String) {
    slaPolicies(entityType: $entityType, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      id name entityType priority category teamId teamName
      timezone responseMinutes resolveMinutes businessHours enabled
    }
  }
`

// ── Collaboration ───────────────────────────────────────────────────────────

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

// ── Change Catalog ──────────────────────────────────────────────────────────

export const GET_CHANGE_CATALOG_CATEGORIES = gql`
  query GetChangeCatalogCategories {
    changeCatalogCategories { id name description icon color order enabled entryCount }
  }
`

export const GET_STANDARD_CHANGE_CATALOG = gql`
  query GetStandardChangeCatalog($categoryId: String, $search: String, $filters: String, $sortField: String, $sortDirection: String) {
    standardChangeCatalog(categoryId: $categoryId, search: $search, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      id name description categoryId riskLevel impact defaultTitleTemplate defaultDescriptionTemplate defaultPriority ciTypes checklist estimatedDurationHours requiresDowntime rollbackProcedure icon color usageCount enabled createdBy createdAt updatedAt
      workflowId ciRequired maintenanceWindow notifyTeam requireCompletionConfirm
      category { id name icon color }
      workflow { id name category }
    }
  }
`

export const GET_STANDARD_CHANGE_CATALOG_ENTRY = gql`
  query GetStandardChangeCatalogEntry($id: ID!) {
    standardChangeCatalogEntry(id: $id) {
      id name description categoryId riskLevel impact defaultTitleTemplate defaultDescriptionTemplate defaultPriority ciTypes checklist estimatedDurationHours requiresDowntime rollbackProcedure icon color usageCount enabled createdBy createdAt
      workflowId ciRequired maintenanceWindow notifyTeam requireCompletionConfirm
      category { id name icon color }
      workflow { id name category }
    }
  }
`

// ── What-if Planning ───────────────────────────────────────────────────────

export const WHAT_IF_ANALYSIS = gql`
  query WhatIfAnalysis($ciId: ID!, $action: String!, $depth: Int) {
    whatIfAnalysis(ciId: $ciId, action: $action, depth: $depth) {
      targetCI { id name type environment status impactLevel impactPath isRedundant }
      action
      impactedCIs { id name type environment status impactLevel impactPath isRedundant }
      impactedServices { id name type impactLevel impactPath isRedundant }
      impactedTeams { id name role impactedCICount }
      totalImpacted riskScore hasRedundancy openIncidents summary
    }
  }
`

// ── Change Calendar ────────────────────────────────────────────────────────

export const CHANGE_CALENDAR_EVENTS = gql`
  query ChangeCalendarEvents($from: String!, $to: String!) {
    changeCalendarEvents(from: $from, to: $to) {
      id title changeType status riskLevel scheduledStart scheduledEnd duration ciNames teamName requiresDowntime color
    }
  }
`

export const CHANGE_CALENDAR_CONFLICTS = gql`
  query ChangeCalendarConflicts($from: String!, $to: String!) {
    changeCalendarConflicts(from: $from, to: $to) {
      changeA { id title changeType scheduledStart scheduledEnd }
      changeB { id title changeType scheduledStart scheduledEnd }
      sharedCIs overlapStart overlapEnd
    }
  }
`

export const CHANGE_CALENDAR_SUGGESTED_SLOTS = gql`
  query ChangeCalendarSuggestedSlots($duration: Int!, $ciIds: [ID!], $from: String!, $to: String!) {
    changeCalendarSuggestedSlots(duration: $duration, ciIds: $ciIds, from: $from, to: $to) {
      start end score reason
    }
  }
`
