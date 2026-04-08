import { gql } from '@apollo/client'

export const GET_PROBLEMS = gql`
  query GetProblems($limit: Int, $offset: Int, $status: String, $priority: String, $search: String, $filters: String, $sortField: String, $sortDirection: String) {
    problems(limit: $limit, offset: $offset, status: $status, priority: $priority, search: $search, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id title priority status
        createdAt updatedAt
        assignee { id name }
        assignedTeam { id name }
        affectedCIs { id name type }
        relatedIncidents { id title status }
      }
    }
  }
`

export const GET_PROBLEM = gql`
  query GetProblem($id: ID!) {
    problem(id: $id) {
      id title description priority status
      rootCause workaround affectedUsers
      createdAt updatedAt resolvedAt
      createdBy { id name }
      assignee { id name email }
      assignedTeam { id name }
      affectedCIs { id name type status environment }
      relatedIncidents { id title status severity createdAt }
      relatedChanges { id title type status scheduledStart }
      workflowInstance { id currentStep status }
      availableTransitions { toStep label requiresInput inputField condition }
      workflowHistory { id stepName enteredAt exitedAt durationMs triggeredBy triggerType notes }
      comments { id text type createdAt author { id name } }
    }
  }
`
