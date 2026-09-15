import { gql } from '@apollo/client'
import { EVENT_ROW_FIELDS, IMPACTED_SERVICE_FIELDS, CUSTOM_FIELD_VALUE_FIELDS } from '../fragments'

export const GET_INCIDENTS = gql`
  query GetIncidents($status: String, $severity: String, $limit: Int, $offset: Int, $filters: String, $sortField: String, $sortDirection: String) {
    incidents(status: $status, severity: $severity, limit: $limit, offset: $offset, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id number title severity status createdAt
        customFields { name value }
        slaStatus { startedAt responseDeadline resolveDeadline responseMet resolveMet breached pausedAt warningMinutes }
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
      affectedCIs { id name type status environment ownerGroup { id } supportGroup { id } }
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
        toStep label labels { language label } requiresInput inputField condition
      }
      workflowHistory {
        id stepName enteredAt exitedAt durationMs
        triggeredBy triggerType notes
      }
      comments {
        id text isInternal createdAt updatedAt authorKind authorLabel
        author { id name email }
        editedAt editedByName deletedAt deletedByName
      }
      slaStatus { startedAt responseDeadline resolveDeadline responseMet resolveMet breached pausedAt warningMinutes }
      # history: who opened the incident from the alarm (monitoring or an operator)
      correlatedEvents { ...EventRowFields history(limit: 20) { kind incident { id } } }
      correlatedEventsPurged
      impactedServices { ...ImpactedServiceFields }
      customFields { ...CustomFieldValueFields }
    }
  }
  ${EVENT_ROW_FIELDS}
  ${IMPACTED_SERVICE_FIELDS}
  ${CUSTOM_FIELD_VALUE_FIELDS}
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
      customFields { name value }
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
      availableTransitions { toStep label labels { language label } requiresInput inputField }
      slaStatus { startedAt responseDeadline resolveDeadline responseMet resolveMet breached pausedAt warningMinutes }
      customFields { ...CustomFieldValueFields }
      affectedCIs { id name type status environment }
    }
  }
  ${CUSTOM_FIELD_VALUE_FIELDS}
`

/** Campi filtrabili di un tipo (scalari/enum): sostituisce l'introspezione `__type`, spenta in produzione. */
export const GET_ENTITY_FILTER_FIELDS = gql`
  query EntityFilterFields($typeName: String!) {
    entityFilterFields(typeName: $typeName) { name kind scalarName enumValues }
  }
`
