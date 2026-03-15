import { gql } from '@apollo/client'

export const GET_INCIDENTS = gql`
  query GetIncidents($status: String, $severity: String, $limit: Int, $offset: Int) {
    incidents(status: $status, severity: $severity, limit: $limit, offset: $offset) {
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
    users { id name email teamId }
  }
`

export const GET_TEAMS = gql`
  query GetTeams {
    teams { id name }
  }
`

export const GET_PROBLEMS = gql`
  query GetProblems($status: String, $limit: Int, $offset: Int) {
    problems(status: $status, limit: $limit, offset: $offset) {
      id
      title
      status
      impact
      createdAt
    }
  }
`

export const GET_CHANGES = gql`
  query GetChanges($status: String, $type: String, $priority: String, $search: String, $limit: Int, $offset: Int) {
    changes(status: $status, type: $type, priority: $priority, search: $search, limit: $limit, offset: $offset) {
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
  query GetServiceRequests($status: String, $priority: String, $limit: Int, $offset: Int) {
    serviceRequests(status: $status, priority: $priority, limit: $limit, offset: $offset) {
      id
      title
      priority
      status
      createdAt
    }
  }
`

export const GET_CIS_SEARCH = gql`
  query SearchCIs($search: String) {
    configurationItems(search: $search, limit: 20) {
      id name type environment status
    }
  }
`

export const GET_CIS = gql`
  query GetCIs(
    $limit: Int, $offset: Int,
    $type: String, $environment: String,
    $status: String, $search: String
  ) {
    configurationItems(
      limit: $limit, offset: $offset,
      type: $type, environment: $environment,
      status: $status, search: $search
    ) {
      total
      items {
        id name type status environment createdAt
        owner { id name }
        supportGroup { id name }
      }
    }
  }
`

export const GET_CI_DETAIL = gql`
  query GetCI($id: ID!) {
    configurationItem(id: $id) {
      id
      name
      type
      status
      environment
      createdAt
      updatedAt
      dependenciesWithType {
        relationType
        ci { id name type status environment }
      }
      dependentsWithType {
        relationType
        ci { id name type status environment }
      }
      owner { id name }
      supportGroup { id name }
      ipAddress
      location
      vendor
      version
      port
      url
      region
      expiryDate
      notes
    }
  }
`

export const GET_CHANGE = gql`
  query GetChange($id: ID!) {
    change(id: $id) {
      id title description type priority status
      rollbackPlan scheduledStart scheduledEnd
      implementedAt createdAt updatedAt
      assignedTeam { id name }
      assignee { id name email }
      createdBy { id name email }
      affectedCIs { id name type status environment }
      relatedIncidents { id title status severity }
      workflowInstance { id currentStep status }
      availableTransitions { toStep label requiresInput inputField condition }
      workflowHistory { id stepName enteredAt exitedAt durationMs triggeredBy triggerType notes }
      deploySteps {
        id order title description status
        scheduledStart durationDays scheduledEnd
        hasValidation validationStart validationEnd
        validationStatus validationNotes
        skipReason notes completedAt
        assignedTeam { id name }
        assignee { id name }
        validationTeam { id name }
        validationUser { id name }
      }
      assessmentTasks {
        id status riskLevel impactDescription mitigation notes completedAt
        ci { id name type environment owner { id name } supportGroup { id name } }
        assignedTeam { id name }
        assignee { id name }
      }
      validation {
        id type scheduledStart scheduledEnd status notes completedAt
        assignedTeam { id name }
        assignee { id name }
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

export const GET_BLAST_RADIUS = gql`
  query GetBlastRadius($ciId: ID!, $depth: Int) {
    blastRadius(ciId: $ciId, depth: $depth) {
      id
      name
      type
      status
      environment
      distance
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
