import { gql } from '@apollo/client'

export const GET_INCIDENTS = gql`
  query GetIncidents($status: String, $severity: String, $limit: Int, $offset: Int) {
    incidents(status: $status, severity: $severity, limit: $limit, offset: $offset) {
      id
      title
      severity
      status
      createdAt
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
  query GetChanges($status: String, $limit: Int, $offset: Int) {
    changes(status: $status, limit: $limit, offset: $offset) {
      id
      title
      type
      risk
      status
      windowStart
      windowEnd
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
  query GetConfigurationItems {
    configurationItems(limit: 100) {
      id
      name
      type
      status
      environment
      createdAt
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

export const GET_BLAST_RADIUS = gql`
  query GetBlastRadius($ciId: ID!, $depth: Int) {
    blastRadius(ciId: $ciId, depth: $depth) {
      id
      name
      type
      status
      environment
    }
  }
`

export const GET_DASHBOARD_STATS = gql`
  query GetDashboardStats {
    openIncidents: incidents(status: "open", limit: 1000) {
      id
    }
    openProblems: problems(status: "open", limit: 1000) {
      id
    }
    pendingChanges: changes(status: "pending_approval", limit: 1000) {
      id
    }
    openRequests: serviceRequests(status: "open", limit: 1000) {
      id
    }
  }
`
