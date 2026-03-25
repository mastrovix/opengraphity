import { changes, change, changeTasksQuery } from './queries.js'
import { changeImpactAnalysisQuery } from './impact.js'
import {
  createChange, approveChange, rejectChange, deployChange, failChange,
  addAffectedCIToChange, removeAffectedCIFromChange, addChangeComment,
  saveDeploySteps, saveChangeValidation,
  updateChangeTask,
  updateAssessmentTask, completeAssessmentTask, rejectAssessmentTask,
  assignDeployStepToTeam, assignDeployStepToUser, updateDeployStepStatus, updateDeployStepValidation,
  assignDeployStepValidationTeam, assignDeployStepValidationUser,
  executeChangeTransition,
  completeChangeValidation, failChangeValidation,
  assignAssessmentTaskTeam, assignAssessmentTaskUser,
} from './mutations.js'
import {
  changeAssignedTeam, changeAssignee, changeAffectedCIs, changeRelatedIncidents,
  changeChangeTasks, changeWorkflowInstance, changeAvailableTransitions,
  changeWorkflowHistory, changeCreatedBy, changeComments, changeImpactAnalysisField,
  changeTaskCI,
} from './fields.js'

export const changeResolvers = {
  Query: {
    changes,
    change,
    changeTasks: changeTasksQuery,
    changeImpactAnalysis: changeImpactAnalysisQuery,
  },
  Mutation: {
    createChange, approveChange, rejectChange, deployChange, failChange,
    addAffectedCIToChange, removeAffectedCIFromChange, addChangeComment,
    saveDeploySteps, saveChangeValidation,
    updateChangeTask,
    updateAssessmentTask, completeAssessmentTask, rejectAssessmentTask,
    assignDeployStepToTeam, assignDeployStepToUser, updateDeployStepStatus, updateDeployStepValidation,
    assignDeployStepValidationTeam, assignDeployStepValidationUser,
    executeChangeTransition,
    completeChangeValidation, failChangeValidation,
    assignAssessmentTaskTeam, assignAssessmentTaskUser,
  },
  ChangeTask: {
    ci: changeTaskCI,
  },
  Change: {
    assignedTeam:         changeAssignedTeam,
    assignee:             changeAssignee,
    affectedCIs:          changeAffectedCIs,
    relatedIncidents:     changeRelatedIncidents,
    changeTasks:          changeChangeTasks,
    workflowInstance:     changeWorkflowInstance,
    availableTransitions: changeAvailableTransitions,
    workflowHistory:      changeWorkflowHistory,
    createdBy:            changeCreatedBy,
    comments:             changeComments,
    impactAnalysis:       changeImpactAnalysisField,
  },
}
