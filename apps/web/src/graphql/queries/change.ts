import { gql } from '@apollo/client'

export const GET_CHANGES = gql`
  query GetChanges($status: String, $type: String, $priority: String, $search: String, $limit: Int, $offset: Int, $filters: String, $sortField: String, $sortDirection: String) {
    changes(status: $status, type: $type, priority: $priority, search: $search, limit: $limit, offset: $offset, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id number title type priority status
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

export const GET_CHANGE = gql`
  query GetChange($id: ID!) {
    change(id: $id) {
      id number title description type priority status
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
