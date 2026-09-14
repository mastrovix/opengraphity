import { gql } from '@apollo/client'
import { CUSTOM_FIELD_VALUE_FIELDS } from '../fragments'

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
        customFields { name value }
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
      slaStatus { startedAt responseDeadline resolveDeadline responseMet resolveMet breached pausedAt warningMinutes }
      createdBy { id name }
      assignee { id name email }
      assignedTeam { id name }
      affectedCIs { id name type status environment ownerGroup { id } supportGroup { id } }
      workflowInstance { id currentStep status }
      linkedIncidents { id number title status removable }
      linkedProblems { id number title status removable }
      linkedChanges { id number title status removable }
      availableTransitions { toStep label labels { language label } requiresInput inputField condition }
      workflowHistory { id stepName enteredAt exitedAt durationMs triggeredBy triggerType notes }
      comments { id text type isInternal createdAt authorKind authorLabel author { id name } }
      customFields { ...CustomFieldValueFields }
    }
  }
  ${CUSTOM_FIELD_VALUE_FIELDS}
`
