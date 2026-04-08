import { gql } from '@apollo/client'

export const UPDATE_WORKFLOW_STEP = gql`
  mutation UpdateWorkflowStep($definitionId: ID!, $stepName: String!, $label: String!, $enterActions: String, $exitActions: String) {
    updateWorkflowStep(definitionId: $definitionId, stepName: $stepName, label: $label, enterActions: $enterActions, exitActions: $exitActions) {
      id name label type enterActions exitActions
    }
  }
`

export const SAVE_WORKFLOW_CHANGES = gql`
  mutation SaveWorkflowChanges(
    $definitionId: ID!
    $transitions: [TransitionChangeInput!]!
    $positions: [StepPositionInput!]!
  ) {
    saveWorkflowChanges(
      definitionId: $definitionId
      transitions: $transitions
      positions: $positions
    ) {
      id name version
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

export const ADD_WORKFLOW_STEP = gql`
  mutation AddWorkflowStep($definitionId: ID!, $name: String!, $label: String!, $type: String!, $timerDelayMinutes: Int, $subWorkflowId: String) {
    addWorkflowStep(definitionId: $definitionId, name: $name, label: $label, type: $type, timerDelayMinutes: $timerDelayMinutes, subWorkflowId: $subWorkflowId) {
      id name version steps { id name label type timerDelayMinutes subWorkflowId }
    }
  }
`
