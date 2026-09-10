import { gql } from '@apollo/client'
import { EVENT_ROW_FIELDS, IMPACTED_SERVICE_FIELDS } from '../fragments'

export const GET_INCIDENTS = gql`
  query GetIncidents($status: String, $severity: String, $limit: Int, $offset: Int, $filters: String, $sortField: String, $sortDirection: String) {
    incidents(status: $status, severity: $severity, limit: $limit, offset: $offset, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id number title severity status createdAt
        slaStatus { startedAt responseDeadline resolveDeadline responseMet resolveMet breached pausedAt }
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
      impact
      urgency
      priority
      major
      status
      rootCause
      createdAt
      updatedAt
      resolvedAt
      assignee { id name email }
      assignedTeam { id name }
      affectedCIs { id name type status environment }
      impactedApplications {
        distance
        via
        ci { id name type status environment }
        path { id name type }
      }
      workflowInstance { id currentStep status }
      linkedIncidents { id number title status removable }
      linkedProblems { id number title status removable }
      linkedChanges { id number title status removable }
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
      slaStatus { startedAt responseDeadline resolveDeadline responseMet resolveMet breached pausedAt }
      correlatedEvents { ...EventRowFields }
      correlatedEventsPurged
      impactedServices { ...ImpactedServiceFields }
    }
  }
  ${EVENT_ROW_FIELDS}
  ${IMPACTED_SERVICE_FIELDS}
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
      workflowInstance { id currentStep status }
      availableTransitions { toStep label requiresInput inputField }
    }
  }
`

/** Campi filtrabili di un tipo (scalari/enum): sostituisce l'introspezione `__type`, spenta in produzione. */
export const GET_ENTITY_FILTER_FIELDS = gql`
  query EntityFilterFields($typeName: String!) {
    entityFilterFields(typeName: $typeName) { name kind scalarName enumValues }
  }
`
