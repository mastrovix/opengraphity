import { gql } from '@apollo/client'

export const CREATE_INCIDENT = gql`
  mutation CreateIncident($input: CreateIncidentInput!) {
    createIncident(input: $input) {
      id
      title
      severity
      category
      status
      createdAt
      affectedCIs { id name type }
    }
  }
`

export const ASSIGN_INCIDENT_TO_TEAM = gql`
  mutation AssignIncidentToTeam($id: ID!, $teamId: ID!) {
    assignIncidentToTeam(id: $id, teamId: $teamId) {
      id status
      assignedTeam { id name }
      workflowInstance { currentStep status }
    }
  }
`

export const RESOLVE_INCIDENT = gql`
  mutation ResolveIncident($id: ID!, $rootCause: String) {
    resolveIncident(id: $id, rootCause: $rootCause) {
      id status
      workflowInstance { currentStep status }
    }
  }
`

export const ASSIGN_INCIDENT_TO_USER = gql`
  mutation AssignIncidentToUser($id: ID!, $userId: ID) {
    assignIncidentToUser(id: $id, userId: $userId) {
      id status
      assignee { id name email }
      workflowInstance { currentStep status }
    }
  }
`

export const ADD_INCIDENT_COMMENT = gql`
  mutation AddIncidentComment($id: ID!, $text: String!, $isInternal: Boolean) {
    addIncidentComment(id: $id, text: $text, isInternal: $isInternal) {
      id text isInternal createdAt updatedAt
      author { id name email }
    }
  }
`

export const ADD_AFFECTED_CI = gql`
  mutation AddAffectedCI($incidentId: ID!, $ciId: ID!) {
    addAffectedCI(incidentId: $incidentId, ciId: $ciId) {
      id
      affectedCIs { id name type status environment }
    }
  }
`

export const REMOVE_AFFECTED_CI = gql`
  mutation RemoveAffectedCI($incidentId: ID!, $ciId: ID!) {
    removeAffectedCI(incidentId: $incidentId, ciId: $ciId) {
      id
      affectedCIs { id name type status environment }
    }
  }
`

export const SET_INCIDENT_MAJOR = gql`
  mutation SetIncidentMajor($id: ID!, $major: Boolean!) {
    setIncidentMajor(id: $id, major: $major) { id major }
  }
`

export const UPDATE_INCIDENT = gql`
  mutation UpdateIncident($id: ID!, $input: UpdateIncidentInput!) {
    updateIncident(id: $id, input: $input) {
      id title description severity impact urgency priority status
    }
  }
`

export const ASSIGN_SERVICE_REQUEST_TO_USER = gql`
  mutation AssignServiceRequestToUser($id: ID!, $userId: ID) {
    assignServiceRequestToUser(id: $id, userId: $userId) {
      id assignee { id name email }
    }
  }
`

/** I CI di una richiesta (revisione del 15 set 2026 · CM-8). */
export const ADD_CI_TO_SERVICE_REQUEST = gql`
  mutation AddCIToServiceRequest($requestId: ID!, $ciId: ID!) {
    addCIToServiceRequest(requestId: $requestId, ciId: $ciId) {
      id
      affectedCIs { id name type status environment }
    }
  }
`

export const REMOVE_CI_FROM_SERVICE_REQUEST = gql`
  mutation RemoveCIFromServiceRequest($requestId: ID!, $ciId: ID!) {
    removeCIFromServiceRequest(requestId: $requestId, ciId: $ciId) {
      id
      affectedCIs { id name type status environment }
    }
  }
`

export const UPDATE_SERVICE_REQUEST = gql`
  mutation UpdateServiceRequest($id: ID!, $input: UpdateServiceRequestInput!) {
    updateServiceRequest(id: $id, input: $input) {
      id title description status priority dueDate
    }
  }
`

