import { gql } from '@apollo/client'

export const CREATE_CHANGE = gql`
  mutation CreateChange($input: CreateChangeInput!) {
    createChange(input: $input) {
      id title type status
      workflowInstance { id currentStep }
    }
  }
`

export const SAVE_DEPLOY_STEPS = gql`
  mutation SaveDeploySteps($changeId: ID!, $steps: [CreateDeployStepInput!]!) {
    saveDeploySteps(changeId: $changeId, steps: $steps) {
      id changeTasks {
        id taskType order title scheduledStart scheduledEnd durationDays
        hasValidation validationStart validationEnd
        assignedTeam { id name }
      }
    }
  }
`

export const SAVE_CHANGE_VALIDATION = gql`
  mutation SaveChangeValidation($changeId: ID!, $scheduledStart: String!, $scheduledEnd: String!) {
    saveChangeValidation(changeId: $changeId, scheduledStart: $scheduledStart, scheduledEnd: $scheduledEnd) {
      id changeTasks {
        id taskType scheduledStart scheduledEnd status
      }
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

export const UPDATE_CHANGE_TASK = gql`
  mutation UpdateChangeTask($id: ID!, $input: UpdateChangeTaskInput!) {
    updateChangeTask(id: $id, input: $input) {
      id rollbackPlan
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
  mutation AddAffectedCIToChange($changeId: ID!, $ciId: ID!, $relationType: String) {
    addAffectedCIToChange(changeId: $changeId, ciId: $ciId, relationType: $relationType) {
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
