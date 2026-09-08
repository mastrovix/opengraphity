import { gql } from '@apollo/client'

export const GET_PROBLEMS = gql`
  query GetProblems($limit: Int, $offset: Int, $status: String, $priority: String, $search: String, $filters: String, $sortField: String, $sortDirection: String) {
    problems(limit: $limit, offset: $offset, status: $status, priority: $priority, search: $search, filters: $filters, sortField: $sortField, sortDirection: $sortDirection) {
      total
      items {
        id number title priority status
        createdAt updatedAt
        assignee { id name }
        assignedTeam { id name }
        affectedCIs { id name type }
      }
    }
  }
`

export const GET_PROBLEM = gql`
  query GetProblem($id: ID!) {
    problem(id: $id) {
      id number title description priority status
      rootCause workaround affectedUsers
      createdAt updatedAt resolvedAt
      createdBy { id name }
      assignee { id name email }
      assignedTeam { id name }
      affectedCIs { id name type status environment }
      workflowInstance { id currentStep status }
      linkedIncidents { id number title status removable }
      linkedProblems { id number title status removable }
      linkedChanges { id number title status removable }
      availableTransitions { toStep label requiresInput inputField condition }
      workflowHistory { id stepName enteredAt exitedAt durationMs triggeredBy triggerType notes }
      comments { id text type createdAt author { id name } }
    }
  }
`
