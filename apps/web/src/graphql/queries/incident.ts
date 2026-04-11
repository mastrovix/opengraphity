import { gql } from '@apollo/client'

export const GET_INCIDENTS = gql`
  query GetIncidents($status: String, $severity: String, $limit: Int, $offset: Int, $filters: String, $sortField: String, $sortDirection: String) {
    incidents(status: $status, severity: $severity, limit: $limit, offset: $offset, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id number title severity status createdAt
      }
    }
  }
`

export const GET_INCIDENT = gql`
  query GetIncident($id: ID!) {
    incident(id: $id) {
      id
      number
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

export const GET_SERVICE_REQUESTS = gql`
  query GetServiceRequests($status: String, $priority: String, $limit: Int, $offset: Int, $filters: String, $sortField: String, $sortDirection: String) {
    serviceRequests(status: $status, priority: $priority, limit: $limit, offset: $offset, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      id
      number
      title
      priority
      status
      createdAt
    }
  }
`

export const GET_SERVICE_REQUEST = gql`
  query GetServiceRequest($id: ID!) {
    serviceRequest(id: $id) {
      id number tenantId title description status priority dueDate
      createdAt updatedAt completedAt
      requestedBy { id name email }
      assignee { id name email }
    }
  }
`
