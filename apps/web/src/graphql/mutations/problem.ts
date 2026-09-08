import { gql } from '@apollo/client'

export const UPDATE_PROBLEM = gql`
  mutation UpdateProblem($id: ID!, $input: UpdateProblemInput!) {
    updateProblem(id: $id, input: $input) { id title description priority status rootCause workaround affectedUsers updatedAt }
  }
`

export const LINK_RELATED_TICKET = gql`
  mutation LinkRelatedTicket($entityType: String!, $entityId: ID!, $otherId: ID!) {
    linkRelatedTicket(entityType: $entityType, entityId: $entityId, otherId: $otherId)
  }
`

export const UNLINK_RELATED_TICKET = gql`
  mutation UnlinkRelatedTicket($entityType: String!, $entityId: ID!, $otherId: ID!) {
    unlinkRelatedTicket(entityType: $entityType, entityId: $entityId, otherId: $otherId)
  }
`

export const LINK_INCIDENT_TO_PROBLEM = gql`
  mutation LinkIncidentToProblem($problemId: ID!, $incidentId: ID!) {
    linkIncidentToProblem(problemId: $problemId, incidentId: $incidentId) {
      id linkedIncidents { id number title status removable }
    }
  }
`

export const UNLINK_INCIDENT_FROM_PROBLEM = gql`
  mutation UnlinkIncidentFromProblem($problemId: ID!, $incidentId: ID!) {
    unlinkIncidentFromProblem(problemId: $problemId, incidentId: $incidentId) {
      id linkedIncidents { id number title status removable }
    }
  }
`

export const CREATE_PROBLEM = gql`
  mutation CreateProblem($input: CreateProblemInput!) {
    createProblem(input: $input) { id title }
  }
`

export const ADD_CI_TO_PROBLEM = gql`
  mutation AddCIToProblem($problemId: ID!, $ciId: ID!, $relationType: String) {
    addCIToProblem(problemId: $problemId, ciId: $ciId, relationType: $relationType) {
      id affectedCIs { id name type environment status }
    }
  }
`

export const REMOVE_CI_FROM_PROBLEM = gql`
  mutation RemoveCIFromProblem($problemId: ID!, $ciId: ID!) {
    removeCIFromProblem(problemId: $problemId, ciId: $ciId) {
      id affectedCIs { id name type environment status }
    }
  }
`

export const ASSIGN_PROBLEM_TO_TEAM = gql`
  mutation AssignProblemToTeam($problemId: ID!, $teamId: ID!) {
    assignProblemToTeam(problemId: $problemId, teamId: $teamId) {
      id assignedTeam { id name }
    }
  }
`

export const ASSIGN_PROBLEM_TO_USER = gql`
  mutation AssignProblemToUser($problemId: ID!, $userId: ID!) {
    assignProblemToUser(problemId: $problemId, userId: $userId) {
      id assignee { id name email }
    }
  }
`

export const EXECUTE_PROBLEM_TRANSITION = gql`
  mutation ExecuteProblemTransition($problemId: ID!, $toStep: String!, $notes: String) {
    executeProblemTransition(problemId: $problemId, toStep: $toStep, notes: $notes) {
      id status actionErrors workflowInstance { id currentStep status }
      availableTransitions { toStep label requiresInput inputField condition }
    }
  }
`

export const ADD_PROBLEM_COMMENT = gql`
  mutation AddProblemComment($problemId: ID!, $text: String!) {
    addProblemComment(problemId: $problemId, text: $text) {
      id text type createdAt author { id name }
    }
  }
`

export const DELETE_PROBLEM = gql`
  mutation DeleteProblem($id: ID!) { deleteProblem(id: $id) }
`
