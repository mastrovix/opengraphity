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
  query GetTeams {
    teams { id name description type createdAt }
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

export const GET_ALL_CIS = gql`
  query GetAllCIs($limit: Int, $offset: Int, $type: String, $environment: String, $status: String, $search: String) {
    allCIs(limit: $limit, offset: $offset, type: $type, environment: $environment, status: $status, search: $search) {
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

export const GET_APPLICATIONS = gql`
  query GetApplications($limit: Int, $offset: Int, $environment: String, $status: String, $search: String) {
    applications(limit: $limit, offset: $offset, environment: $environment, status: $status, search: $search) {
      total
      items { id name type status environment description createdAt url ownerGroup { id name } supportGroup { id name } }
    }
  }
`

export const GET_APPLICATION = gql`
  query GetApplication($id: ID!) {
    application(id: $id) {
      id name type status environment description createdAt updatedAt notes
      url
      ownerGroup { id name }
      supportGroup { id name }
      dependencies { relation ci { id name type environment status } }
      dependents { relation ci { id name type environment status } }
    }
  }
`

export const GET_DATABASES = gql`
  query GetDatabases($limit: Int, $offset: Int, $environment: String, $status: String, $search: String) {
    databases(limit: $limit, offset: $offset, environment: $environment, status: $status, search: $search) {
      total
      items { id name type status environment description createdAt port instanceType ownerGroup { id name } supportGroup { id name } }
    }
  }
`

export const GET_DATABASE = gql`
  query GetDatabase($id: ID!) {
    database(id: $id) {
      id name type status environment description createdAt updatedAt notes port instanceType
      ownerGroup { id name }
      supportGroup { id name }
      dependencies { relation ci { id name type environment status } }
      dependents { relation ci { id name type environment status } }
    }
  }
`

export const GET_DATABASE_INSTANCES = gql`
  query GetDatabaseInstances($limit: Int, $offset: Int, $environment: String, $status: String, $search: String) {
    databaseInstances(limit: $limit, offset: $offset, environment: $environment, status: $status, search: $search) {
      total
      items { id name type status environment description createdAt ipAddress port instanceType version ownerGroup { id name } supportGroup { id name } }
    }
  }
`

export const GET_DATABASE_INSTANCE = gql`
  query GetDatabaseInstance($id: ID!) {
    databaseInstance(id: $id) {
      id name type status environment description createdAt updatedAt notes ipAddress port instanceType version
      ownerGroup { id name }
      supportGroup { id name }
      dependencies { relation ci { id name type environment status } }
      dependents { relation ci { id name type environment status } }
    }
  }
`

export const GET_SERVERS = gql`
  query GetServers($limit: Int, $offset: Int, $environment: String, $status: String, $search: String) {
    servers(limit: $limit, offset: $offset, environment: $environment, status: $status, search: $search) {
      total
      items { id name type status environment description createdAt ipAddress location vendor os version ownerGroup { id name } supportGroup { id name } }
    }
  }
`

export const GET_SERVER = gql`
  query GetServer($id: ID!) {
    server(id: $id) {
      id name type status environment description createdAt updatedAt notes ipAddress location vendor os version
      ownerGroup { id name }
      supportGroup { id name }
      dependencies { relation ci { id name type environment status } }
      dependents { relation ci { id name type environment status } }
    }
  }
`

export const GET_CERTIFICATES = gql`
  query GetCertificates($limit: Int, $offset: Int, $environment: String, $status: String, $search: String) {
    certificates(limit: $limit, offset: $offset, environment: $environment, status: $status, search: $search) {
      total
      items { id name type status environment description createdAt serialNumber expiresAt certificateType ownerGroup { id name } supportGroup { id name } }
    }
  }
`

export const GET_CERTIFICATE = gql`
  query GetCertificate($id: ID!) {
    certificate(id: $id) {
      id name type status environment description createdAt updatedAt notes serialNumber expiresAt certificateType
      ownerGroup { id name }
      supportGroup { id name }
      dependencies { relation ci { id name type environment status } }
      dependents { relation ci { id name type environment status } }
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
        ci { id name type environment ownerGroup { id name } supportGroup { id name } }
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
        id fromStepName toStepName trigger label requiresInput inputField condition
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
