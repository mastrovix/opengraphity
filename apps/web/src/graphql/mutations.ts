import { gql } from '@apollo/client'

export const LOGIN = gql`
  mutation Login($email: String!, $password: String!) {
    login(email: $email, password: $password) {
      token
      expiresAt
      user { id name email role }
    }
  }
`

export const CREATE_INCIDENT = gql`
  mutation CreateIncident($input: CreateIncidentInput!) {
    createIncident(input: $input) {
      id
      title
      severity
      status
      createdAt
      affectedCIs { id name type }
    }
  }
`

export const RESOLVE_INCIDENT = gql`
  mutation ResolveIncident($id: ID!, $rootCause: String) {
    resolveIncident(id: $id, rootCause: $rootCause) {
      id
      status
      resolvedAt
    }
  }
`

export const CREATE_PROBLEM = gql`
  mutation CreateProblem($input: CreateProblemInput!) {
    createProblem(input: $input) {
      id
      title
      status
      impact
      createdAt
    }
  }
`

export const CREATE_CHANGE = gql`
  mutation CreateChange($input: CreateChangeInput!) {
    createChange(input: $input) {
      id
      title
      type
      risk
      status
      windowStart
      windowEnd
    }
  }
`

export const APPROVE_CHANGE = gql`
  mutation ApproveChange($id: ID!) {
    approveChange(id: $id) {
      id
      status
    }
  }
`

export const REJECT_CHANGE = gql`
  mutation RejectChange($id: ID!, $reason: String) {
    rejectChange(id: $id, reason: $reason) {
      id
      status
    }
  }
`

export const CREATE_SERVICE_REQUEST = gql`
  mutation CreateServiceRequest($input: CreateServiceRequestInput!) {
    createServiceRequest(input: $input) {
      id
      title
      priority
      status
      createdAt
    }
  }
`

export const UPDATE_CI = gql`
  mutation UpdateCI($id: ID!, $input: UpdateCIFieldsInput!) {
    updateCIFields(id: $id, input: $input) {
      id name status environment
      ipAddress location vendor version port url region expiryDate notes
    }
  }
`

export const ADD_CI_DEPENDENCY = gql`
  mutation AddCIDependency($fromId: ID!, $toId: ID!, $type: String!) {
    addCIDependency(fromId: $fromId, toId: $toId, type: $type)
  }
`

export const UPDATE_WORKFLOW_STEP = gql`
  mutation UpdateWorkflowStep($definitionId: ID!, $stepName: String!, $label: String!) {
    updateWorkflowStep(definitionId: $definitionId, stepName: $stepName, label: $label) {
      id name label type
    }
  }
`

export const UPDATE_WORKFLOW_TRANSITION = gql`
  mutation UpdateWorkflowTransition(
    $definitionId: ID!
    $transitionId: ID!
    $label: String!
    $requiresInput: Boolean!
    $inputField: String
  ) {
    updateWorkflowTransition(
      definitionId: $definitionId
      transitionId: $transitionId
      label: $label
      requiresInput: $requiresInput
      inputField: $inputField
    ) {
      id fromStepName toStepName trigger label requiresInput inputField
    }
  }
`

export const EXECUTE_WORKFLOW_TRANSITION = gql`
  mutation ExecuteWorkflowTransition($instanceId: ID!, $toStep: String!, $notes: String) {
    executeWorkflowTransition(instanceId: $instanceId, toStep: $toStep, notes: $notes) {
      success
      error
      instance { id currentStep status }
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
  mutation AssignIncidentToUser($id: ID!, $userId: ID!) {
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

export const COMPLETE_SERVICE_REQUEST = gql`
  mutation CompleteServiceRequest($id: ID!) {
    completeServiceRequest(id: $id) {
      id
      status
      completedAt
    }
  }
`
