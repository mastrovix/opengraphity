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
      id title type status
      workflowInstance { id currentStep }
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

export const SAVE_DEPLOY_STEPS = gql`
  mutation SaveDeploySteps($changeId: ID!, $steps: [CreateDeployStepInput!]!) {
    saveDeploySteps(changeId: $changeId, steps: $steps) {
      id deploySteps {
        id order title scheduledStart scheduledEnd durationDays
        hasValidation validationStart validationEnd
        assignedTeam { id name }
      }
      validation { id scheduledStart scheduledEnd }
    }
  }
`

export const SAVE_CHANGE_VALIDATION = gql`
  mutation SaveChangeValidation($changeId: ID!, $scheduledStart: String!, $scheduledEnd: String!) {
    saveChangeValidation(changeId: $changeId, scheduledStart: $scheduledStart, scheduledEnd: $scheduledEnd) {
      id validation { id scheduledStart scheduledEnd status }
    }
  }
`

export const COMPLETE_ASSESSMENT_TASK = gql`
  mutation CompleteAssessmentTask($taskId: ID!, $input: UpdateAssessmentTaskInput!) {
    completeAssessmentTask(taskId: $taskId, input: $input) {
      id status riskLevel impactDescription completedAt
    }
  }
`

export const REJECT_ASSESSMENT_TASK = gql`
  mutation RejectAssessmentTask($taskId: ID!, $reason: String!) {
    rejectAssessmentTask(taskId: $taskId, reason: $reason) {
      id status notes
    }
  }
`

export const UPDATE_DEPLOY_STEP_STATUS = gql`
  mutation UpdateDeployStepStatus($stepId: ID!, $status: String!, $notes: String, $skipReason: String) {
    updateDeployStepStatus(stepId: $stepId, status: $status, notes: $notes, skipReason: $skipReason) {
      id status notes skipReason completedAt
    }
  }
`

export const EXECUTE_CHANGE_TRANSITION = gql`
  mutation ExecuteChangeTransition($instanceId: ID!, $toStep: String!, $notes: String) {
    executeChangeTransition(instanceId: $instanceId, toStep: $toStep, notes: $notes) {
      success error
      instance { id currentStep status }
    }
  }
`

export const ADD_AFFECTED_CI_TO_CHANGE = gql`
  mutation AddAffectedCIToChange($changeId: ID!, $ciId: ID!) {
    addAffectedCIToChange(changeId: $changeId, ciId: $ciId) {
      id affectedCIs { id name type status environment }
    }
  }
`

export const REMOVE_AFFECTED_CI_FROM_CHANGE = gql`
  mutation RemoveAffectedCIFromChange($changeId: ID!, $ciId: ID!, $reason: String!) {
    removeAffectedCIFromChange(changeId: $changeId, ciId: $ciId, reason: $reason) {
      id affectedCIs { id name type status environment }
      comments { id text type createdAt createdBy { id name } }
    }
  }
`

export const ADD_CHANGE_COMMENT = gql`
  mutation AddChangeComment($changeId: ID!, $text: String!) {
    addChangeComment(changeId: $changeId, text: $text) {
      id text type createdAt createdBy { id name }
    }
  }
`

export const UPDATE_DEPLOY_STEP_VALIDATION = gql`
  mutation UpdateDeployStepValidation($stepId: ID!, $status: String!, $notes: String) {
    updateDeployStepValidation(stepId: $stepId, status: $status, notes: $notes) {
      id validationStatus validationNotes
    }
  }
`

export const COMPLETE_CHANGE_VALIDATION = gql`
  mutation CompleteChangeValidation($changeId: ID!, $notes: String) {
    completeChangeValidation(changeId: $changeId, notes: $notes) {
      id status notes completedAt
    }
  }
`

export const FAIL_CHANGE_VALIDATION = gql`
  mutation FailChangeValidation($changeId: ID!) {
    failChangeValidation(changeId: $changeId) {
      id status completedAt
    }
  }
`

export const ASSIGN_ASSESSMENT_TASK_TEAM = gql`
  mutation AssignAssessmentTaskTeam($taskId: ID!, $teamId: ID!) {
    assignAssessmentTaskTeam(taskId: $taskId, teamId: $teamId) {
      id assignedTeam { id name }
    }
  }
`

export const ASSIGN_ASSESSMENT_TASK_USER = gql`
  mutation AssignAssessmentTaskUser($taskId: ID!, $userId: ID!) {
    assignAssessmentTaskUser(taskId: $taskId, userId: $userId) {
      id assignee { id name }
    }
  }
`

export const ASSIGN_DEPLOY_STEP_TO_TEAM = gql`
  mutation AssignDeployStepToTeam($stepId: ID!, $teamId: ID!) {
    assignDeployStepToTeam(stepId: $stepId, teamId: $teamId) {
      id assignedTeam { id name }
    }
  }
`

export const ASSIGN_DEPLOY_STEP_TO_USER = gql`
  mutation AssignDeployStepToUser($stepId: ID!, $userId: ID!) {
    assignDeployStepToUser(stepId: $stepId, userId: $userId) {
      id assignee { id name }
    }
  }
`

export const ASSIGN_DEPLOY_STEP_VALIDATION_TEAM = gql`
  mutation AssignDeployStepValidationTeam($stepId: ID!, $teamId: ID!) {
    assignDeployStepValidationTeam(stepId: $stepId, teamId: $teamId) {
      id validationTeam { id name }
    }
  }
`

export const ASSIGN_DEPLOY_STEP_VALIDATION_USER = gql`
  mutation AssignDeployStepValidationUser($stepId: ID!, $userId: ID!) {
    assignDeployStepValidationUser(stepId: $stepId, userId: $userId) {
      id validationUser { id name }
    }
  }
`


// ── CI Type Designer mutations ────────────────────────────────────────────────

export const CREATE_CI_TYPE = gql`
  mutation CreateCIType($input: CreateCITypeInput!) {
    createCIType(input: $input) {
      id name label icon color active validationScript
      fields { id name label fieldType required enumValues order
        validationScript visibilityScript defaultScript }
      relations { id name label relationshipType targetType
        cardinality direction order }
      systemRelations { id name label relationshipType targetEntity required order }
    }
  }
`

export const UPDATE_CI_TYPE = gql`
  mutation UpdateCIType($id: ID!, $input: UpdateCITypeInput!) {
    updateCIType(id: $id, input: $input) {
      id name label icon color active validationScript
      fields { id name label fieldType required enumValues order
        validationScript visibilityScript defaultScript }
      relations { id name label relationshipType targetType
        cardinality direction order }
      systemRelations { id name label relationshipType targetEntity required order }
    }
  }
`

export const DELETE_CI_TYPE = gql`
  mutation DeleteCIType($id: ID!) {
    deleteCIType(id: $id)
  }
`

export const ADD_CI_FIELD = gql`
  mutation AddCIField($typeId: ID!, $input: CIFieldInput!) {
    addCIField(typeId: $typeId, input: $input) {
      id fields { id name label fieldType required enumValues order
        validationScript visibilityScript defaultScript }
    }
  }
`

export const REMOVE_CI_FIELD = gql`
  mutation RemoveCIField($typeId: ID!, $fieldId: ID!) {
    removeCIField(typeId: $typeId, fieldId: $fieldId) {
      id fields { id name label fieldType required enumValues order }
    }
  }
`

export const ADD_CI_RELATION = gql`
  mutation AddCIRelation($typeId: ID!, $input: CIRelationInput!) {
    addCIRelation(typeId: $typeId, input: $input) {
      id relations { id name label relationshipType targetType
        cardinality direction order }
    }
  }
`

export const REMOVE_CI_RELATION = gql`
  mutation RemoveCIRelation($typeId: ID!, $relationId: ID!) {
    removeCIRelation(typeId: $typeId, relationId: $relationId) {
      id relations { id name label relationshipType targetType
        cardinality direction order }
    }
  }
`
