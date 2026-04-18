import { gql } from '@apollo/client'

export const CREATE_CHANGE = gql`
  mutation CreateChange($input: CreateChangeInput!) {
    createChange(input: $input) {
      id
      code
      title
      createdAt
      workflowInstance { id currentStep status }
    }
  }
`

export const ADD_CI_TO_CHANGE = gql`
  mutation AddCIToChange($changeId: ID!, $ciId: ID!) {
    addCIToChange(changeId: $changeId, ciId: $ciId) {
      ciPhase
      ci { id name type status environment }
    }
  }
`

export const REMOVE_CI_FROM_CHANGE = gql`
  mutation RemoveCIFromChange($changeId: ID!, $ciId: ID!) {
    removeCIFromChange(changeId: $changeId, ciId: $ciId)
  }
`

export const SUBMIT_ASSESSMENT_RESPONSE = gql`
  mutation SubmitAssessmentResponse($taskId: ID!, $questionId: ID!, $optionId: ID!) {
    submitAssessmentResponse(taskId: $taskId, questionId: $questionId, optionId: $optionId) {
      id
      status
      score
      completedAt
    }
  }
`

export const COMPLETE_ASSESSMENT_TASK = gql`
  mutation CompleteAssessmentTask($taskId: ID!) {
    completeAssessmentTask(taskId: $taskId) {
      id
      status
      score
      completedAt
    }
  }
`

export const ASSIGN_ASSESSMENT_TASK_TO_TEAM = gql`
  mutation AssignAssessmentTaskToTeam($taskId: ID!, $teamId: ID!) {
    assignAssessmentTaskToTeam(taskId: $taskId, teamId: $teamId) {
      id
      assignedTeam { id name }
      assignee { id name }
    }
  }
`

export const ASSIGN_ASSESSMENT_TASK_TO_USER = gql`
  mutation AssignAssessmentTaskToUser($taskId: ID!, $userId: ID!) {
    assignAssessmentTaskToUser(taskId: $taskId, userId: $userId) {
      id
      assignee { id name }
    }
  }
`

export const EXECUTE_CHANGE_TRANSITION = gql`
  mutation ExecuteChangeTransition($changeId: ID!, $toStep: String!, $notes: String) {
    executeChangeTransition(changeId: $changeId, toStep: $toStep, notes: $notes) {
      id
      workflowInstance { id currentStep status }
      availableTransitions { toStep label requiresInput inputField condition }
    }
  }
`

export const COMPLETE_VALIDATION_TEST = gql`
  mutation CompleteValidationTest($changeId: ID!, $ciId: ID!, $result: String!) {
    completeValidationTest(changeId: $changeId, ciId: $ciId, result: $result) {
      id
      status
      result
      testedAt
    }
  }
`

export const SAVE_DEPLOY_PLAN = gql`
  mutation SaveDeployPlan($taskId: ID!, $steps: [DeployStepInput!]!) {
    saveDeployPlan(taskId: $taskId, steps: $steps) {
      id
      status
      steps {
        title
        validationWindow { start end }
        releaseWindow { start end }
      }
    }
  }
`

export const COMPLETE_DEPLOY_PLAN_TASK = gql`
  mutation CompleteDeployPlanTask($taskId: ID!) {
    completeDeployPlanTask(taskId: $taskId) {
      id
      status
      completedAt
    }
  }
`

export const COMPLETE_DEPLOYMENT = gql`
  mutation CompleteDeployment($changeId: ID!, $ciId: ID!) {
    completeDeployment(changeId: $changeId, ciId: $ciId) {
      id
      status
      deployedAt
    }
  }
`

export const COMPLETE_REVIEW = gql`
  mutation CompleteReview($changeId: ID!, $ciId: ID!, $result: String!) {
    completeReview(changeId: $changeId, ciId: $ciId, result: $result) {
      id
      status
      result
      reviewedAt
    }
  }
`

export const CREATE_QUESTION = gql`
  mutation CreateAssessmentQuestion($input: CreateQuestionInput!) {
    createAssessmentQuestion(input: $input) {
      id
      text
      category
      isCore
      isActive
      options { id label score sortOrder }
    }
  }
`

export const UPDATE_QUESTION = gql`
  mutation UpdateAssessmentQuestion($id: ID!, $input: UpdateQuestionInput!) {
    updateAssessmentQuestion(id: $id, input: $input) {
      id
      text
      category
      isCore
      isActive
      options { id label score sortOrder }
    }
  }
`

export const DELETE_QUESTION = gql`
  mutation DeleteAssessmentQuestion($id: ID!) {
    deleteAssessmentQuestion(id: $id)
  }
`

export const ASSIGN_QUESTION_TO_CITYPE = gql`
  mutation AssignQuestionToCIType($questionId: ID!, $ciTypeId: ID!, $weight: Int!, $sortOrder: Int!) {
    assignQuestionToCIType(questionId: $questionId, ciTypeId: $ciTypeId, weight: $weight, sortOrder: $sortOrder)
  }
`

export const REMOVE_QUESTION_FROM_CITYPE = gql`
  mutation RemoveQuestionFromCIType($questionId: ID!, $ciTypeId: ID!) {
    removeQuestionFromCIType(questionId: $questionId, ciTypeId: $ciTypeId)
  }
`

export const REOPEN_TASK = gql`
  mutation ReopenAssessmentTask($taskId: ID!, $reason: String!) {
    reopenAssessmentTask(taskId: $taskId, reason: $reason) { id status }
  }
`

export const REOPEN_DEPLOY_PLAN = gql`
  mutation ReopenDeployPlanTask($taskId: ID!, $reason: String!) {
    reopenDeployPlanTask(taskId: $taskId, reason: $reason) { id status }
  }
`

export const REOPEN_VALIDATION = gql`
  mutation ReopenValidationTest($id: ID!, $reason: String!) {
    reopenValidationTest(id: $id, reason: $reason) { id status }
  }
`

export const REOPEN_DEPLOYMENT = gql`
  mutation ReopenDeploymentTask($id: ID!, $reason: String!) {
    reopenDeploymentTask(id: $id, reason: $reason) { id status }
  }
`

export const REOPEN_REVIEW = gql`
  mutation ReopenReviewTask($id: ID!, $reason: String!) {
    reopenReviewTask(id: $id, reason: $reason) { id status }
  }
`

export const SEND_TASK_REMINDER = gql`
  mutation SendTaskReminder($taskId: ID!, $userId: ID!) {
    sendTaskReminder(taskId: $taskId, userId: $userId)
  }
`

export const SET_QUESTION_CORE = gql`
  mutation SetQuestionCore($questionId: ID!, $isCore: Boolean!) {
    setQuestionCore(questionId: $questionId, isCore: $isCore) {
      id
      isCore
    }
  }
`
