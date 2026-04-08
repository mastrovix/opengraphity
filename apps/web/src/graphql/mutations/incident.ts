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
  mutation AddIncidentComment($id: ID!, $text: String!) {
    addIncidentComment(id: $id, text: $text) {
      id text createdAt updatedAt
      author { id name email }
    }
  }
`

export const ADD_AFFECTED_CI = gql`
  mutation AddAffectedCI($incidentId: ID!, $ciId: ID!, $relationType: String) {
    addAffectedCI(incidentId: $incidentId, ciId: $ciId, relationType: $relationType) {
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
