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
  query GetAllCIs($limit: Int, $offset: Int, $type: String, $environment: String, $status: String, $search: String, $filters: String, $sortField: String, $sortDirection: String) {
    allCIs(limit: $limit, offset: $offset, type: $type, environment: $environment, status: $status, search: $search, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id name type status environment description createdAt
        ownerGroup { id name }
        supportGroup { id name }
      }
    }
  }
`

export const GET_CI_BY_ID = gql`
  query GetCIById($id: ID!) {
    ciById(id: $id) {
      id name type status environment description createdAt updatedAt notes
      ownerGroup { id name }
      supportGroup { id name }
      ... on Application {
        url
        dependencies { relation ci { id name type environment status } }
        dependents { relation ci { id name type environment status } }
      }
      ... on Database {
        port instanceType
        dependencies { relation ci { id name type environment status } }
        dependents { relation ci { id name type environment status } }
      }
      ... on DatabaseInstance {
        ipAddress port instanceType version
        dependencies { relation ci { id name type environment status } }
        dependents { relation ci { id name type environment status } }
      }
      ... on Server {
        ipAddress location vendor os version
        dependencies { relation ci { id name type environment status } }
        dependents { relation ci { id name type environment status } }
      }
      ... on Certificate {
        serialNumber expiresAt certificateType
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
      id name entityType active version
    }
  }
`

export const GET_WORKFLOW_DEFINITION_BY_ID = gql`
  query GetWorkflowDefinitionById($id: ID!) {
    workflowDefinitionById(id: $id) {
      id name entityType version active
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
      id name entityType version active
      steps { id name label type enterActions exitActions }
      transitions {
        id fromStepName toStepName trigger label requiresInput inputField condition
      }
    }
  }
`

export const GET_WORKFLOW_DEFINITIONS = gql`
  query GetWorkflowDefinitions($entityType: String) {
    workflowDefinitions(entityType: $entityType) {
      id name entityType version active
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

export const GET_DASHBOARD_STATS = gql`
  query GetDashboardStats {
    openIncidents: incidents(status: "open", limit: 1) {
      total
    }
    openProblems: problems(status: "open", limit: 1000) {
      id
    }
    pendingChanges: changes(limit: 1) {
      total
    }
    openRequests: serviceRequests(status: "open", limit: 1000) {
      id
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
      id name label active
      fields {
        id name label fieldType
        required enumValues order isSystem
      }
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
      id name isDefault isPersonal
      visibility createdAt
      createdBy { id name }
      sharedWith { id name }
    }
  }
`

export const GET_DASHBOARD = gql`
  query GetDashboard($id: ID!) {
    dashboard(id: $id) {
      id name isDefault isPersonal
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
