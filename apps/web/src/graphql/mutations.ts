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
    createProblem(input: $input) { id title priority status createdAt }
  }
`

export const UPDATE_PROBLEM = gql`
  mutation UpdateProblem($id: ID!, $input: UpdateProblemInput!) {
    updateProblem(id: $id, input: $input) { id title description priority status rootCause workaround affectedUsers updatedAt }
  }
`

export const DELETE_PROBLEM = gql`
  mutation DeleteProblem($id: ID!) { deleteProblem(id: $id) }
`

export const LINK_INCIDENT_TO_PROBLEM = gql`
  mutation LinkIncidentToProblem($problemId: ID!, $incidentId: ID!) {
    linkIncidentToProblem(problemId: $problemId, incidentId: $incidentId) {
      id relatedIncidents { id title status severity }
    }
  }
`

export const UNLINK_INCIDENT_FROM_PROBLEM = gql`
  mutation UnlinkIncidentFromProblem($problemId: ID!, $incidentId: ID!) {
    unlinkIncidentFromProblem(problemId: $problemId, incidentId: $incidentId) {
      id relatedIncidents { id title status severity }
    }
  }
`

export const LINK_CHANGE_TO_PROBLEM = gql`
  mutation LinkChangeToProblem($problemId: ID!, $changeId: ID!) {
    linkChangeToProblem(problemId: $problemId, changeId: $changeId) {
      id relatedChanges { id title type status }
    }
  }
`

export const ADD_CI_TO_PROBLEM = gql`
  mutation AddCIToProblem($problemId: ID!, $ciId: ID!) {
    addCIToProblem(problemId: $problemId, ciId: $ciId) {
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
      id status workflowInstance { id currentStep status }
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

export const SAVE_WORKFLOW_LAYOUT = gql`
  mutation SaveWorkflowLayout(
    $definitionId: ID!
    $positions: [StepPositionInput!]!
  ) {
    saveWorkflowLayout(
      definitionId: $definitionId
      positions: $positions
    )
  }
`

export const UPDATE_WORKFLOW_TRANSITION = gql`
  mutation UpdateWorkflowTransition(
    $definitionId: ID!
    $transitionId: ID!
    $label: String
    $trigger: String
    $requiresInput: Boolean!
    $inputField: String
    $condition: String
    $timerHours: Int
  ) {
    updateWorkflowTransition(
      definitionId: $definitionId
      transitionId: $transitionId
      input: {
        label: $label
        trigger: $trigger
        requiresInput: $requiresInput
        inputField: $inputField
        condition: $condition
        timerHours: $timerHours
      }
    ) {
      id name
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

export const CREATE_REPORT_TEMPLATE = gql`
  mutation CreateReportTemplate($input: CreateReportTemplateInput!) {
    createReportTemplate(input: $input) {
      id name description icon visibility scheduleEnabled scheduleCron createdAt
    }
  }
`

export const UPDATE_REPORT_TEMPLATE = gql`
  mutation UpdateReportTemplate($id: ID!, $input: UpdateReportTemplateInput!) {
    updateReportTemplate(id: $id, input: $input) {
      id name description icon visibility scheduleEnabled scheduleCron scheduleChannelId
      sharedWith { id name }
    }
  }
`

export const DELETE_REPORT_TEMPLATE = gql`
  mutation DeleteReportTemplate($id: ID!) {
    deleteReportTemplate(id: $id)
  }
`

export const ADD_REPORT_SECTION = gql`
  mutation AddReportSection($templateId: ID!, $input: ReportSectionInput!) {
    addReportSection(templateId: $templateId, input: $input) {
      id sections {
        id order title chartType groupByNodeId groupByField metric metricField limit sortDir
        nodes { id entityType neo4jLabel label isResult isRoot positionX positionY filters selectedFields }
        edges { id sourceNodeId targetNodeId relationshipType direction label }
      }
    }
  }
`

export const UPDATE_REPORT_SECTION = gql`
  mutation UpdateReportSection($sectionId: ID!, $input: ReportSectionInput!) {
    updateReportSection(sectionId: $sectionId, input: $input) {
      id sections {
        id order title chartType groupByNodeId groupByField metric metricField limit sortDir
        nodes { id entityType neo4jLabel label isResult isRoot positionX positionY filters selectedFields }
        edges { id sourceNodeId targetNodeId relationshipType direction label }
      }
    }
  }
`

export const REMOVE_REPORT_SECTION = gql`
  mutation RemoveReportSection($templateId: ID!, $sectionId: ID!) {
    removeReportSection(templateId: $templateId, sectionId: $sectionId) {
      id sections { id order title }
    }
  }
`

export const REORDER_REPORT_SECTIONS = gql`
  mutation ReorderReportSections($templateId: ID!, $sectionIds: [ID!]!) {
    reorderReportSections(templateId: $templateId, sectionIds: $sectionIds) {
      id sections { id order title }
    }
  }
`

export const CREATE_DASHBOARD = gql`
  mutation CreateDashboard($input: CreateDashboardInput!) {
    createDashboard(input: $input) {
      id name isDefault isPersonal visibility createdAt
      sharedWith { id name }
    }
  }
`

export const UPDATE_DASHBOARD = gql`
  mutation UpdateDashboard($id: ID!, $input: UpdateDashboardInput!) {
    updateDashboard(id: $id, input: $input) {
      id name isDefault isPersonal visibility
      sharedWith { id name }
    }
  }
`

export const DELETE_DASHBOARD = gql`
  mutation DeleteDashboard($id: ID!) {
    deleteDashboard(id: $id)
  }
`

export const ADD_DASHBOARD_WIDGET = gql`
  mutation AddDashboardWidget($input: AddDashboardWidgetInput!) {
    addDashboardWidget(input: $input) {
      id name widgets {
        id order colSpan reportTemplateId reportSectionId
        data error
        reportSection { id title chartType }
        reportTemplate { id name }
      }
    }
  }
`

export const REMOVE_DASHBOARD_WIDGET = gql`
  mutation RemoveDashboardWidget($widgetId: ID!) {
    removeDashboardWidget(widgetId: $widgetId) {
      id widgets { id order colSpan reportTemplateId reportSectionId }
    }
  }
`

export const UPDATE_DASHBOARD_WIDGET = gql`
  mutation UpdateDashboardWidget($widgetId: ID!, $input: UpdateDashboardWidgetInput!) {
    updateDashboardWidget(widgetId: $widgetId, input: $input) {
      id widgets { id order colSpan }
    }
  }
`

export const REORDER_DASHBOARD_WIDGETS = gql`
  mutation ReorderDashboardWidgets($dashboardId: ID!, $widgetIds: [ID!]!) {
    reorderDashboardWidgets(dashboardId: $dashboardId, widgetIds: $widgetIds) {
      id widgets { id order colSpan }
    }
  }
`

export const UPDATE_NOTIFICATION_RULE = gql`
  mutation UpdateNotificationRule($id: ID!, $input: UpdateNotificationRuleInput!) {
    updateNotificationRule(id: $id, input: $input) {
      id eventType enabled severityOverride titleKey channels target isSeed
      escalationDelayMinutes escalationTarget escalationMessage
      slaWarningThresholdPercent slaWarningTarget digestTime digestRecipients
    }
  }
`

export const CREATE_NOTIFICATION_RULE = gql`
  mutation CreateNotificationRule($input: CreateNotificationRuleInput!) {
    createNotificationRule(input: $input) {
      id eventType enabled severityOverride titleKey channels target isSeed
      escalationDelayMinutes escalationTarget escalationMessage
      slaWarningThresholdPercent slaWarningTarget digestTime digestRecipients
    }
  }
`

export const DELETE_NOTIFICATION_RULE = gql`
  mutation DeleteNotificationRule($id: ID!) {
    deleteNotificationRule(id: $id)
  }
`

const ITIL_TYPE_FRAGMENT = gql`
  fragment ITILTypeFields on CITypeDefinition {
    id name label active
    fields {
      id name label fieldType
      required enumValues order isSystem
      enumTypeId enumTypeName
    }
  }
`

export const CREATE_ITIL_FIELD = gql`
  ${ITIL_TYPE_FRAGMENT}
  mutation CreateITILField($typeId: ID!, $input: ITILFieldInput!) {
    createITILField(typeId: $typeId, input: $input) {
      ...ITILTypeFields
    }
  }
`

export const UPDATE_ITIL_FIELD = gql`
  ${ITIL_TYPE_FRAGMENT}
  mutation UpdateITILField($typeId: ID!, $fieldId: ID!, $input: ITILFieldInput!) {
    updateITILField(typeId: $typeId, fieldId: $fieldId, input: $input) {
      ...ITILTypeFields
    }
  }
`

export const DELETE_ITIL_FIELD = gql`
  ${ITIL_TYPE_FRAGMENT}
  mutation DeleteITILField($typeId: ID!, $fieldId: ID!) {
    deleteITILField(typeId: $typeId, fieldId: $fieldId) {
      ...ITILTypeFields
    }
  }
`

export const CREATE_ENUM_TYPE = gql`
  mutation CreateEnumType($input: CreateEnumTypeInput!) {
    createEnumType(input: $input) {
      id name label values isSystem scope createdAt updatedAt
    }
  }
`

export const UPDATE_ENUM_TYPE = gql`
  mutation UpdateEnumType($id: ID!, $input: UpdateEnumTypeInput!) {
    updateEnumType(id: $id, input: $input) {
      id name label values isSystem scope createdAt updatedAt
    }
  }
`

export const DELETE_ENUM_TYPE = gql`
  mutation DeleteEnumType($id: ID!) {
    deleteEnumType(id: $id)
  }
`

export const ADD_WORKFLOW_STEP = gql`
  mutation AddWorkflowStep($definitionId: ID!, $name: String!, $label: String!, $type: String!, $timerDelayMinutes: Int, $subWorkflowId: String) {
    addWorkflowStep(definitionId: $definitionId, name: $name, label: $label, type: $type, timerDelayMinutes: $timerDelayMinutes, subWorkflowId: $subWorkflowId) {
      id name version steps { id name label type timerDelayMinutes subWorkflowId }
    }
  }
`

export const REMOVE_WORKFLOW_STEP = gql`
  mutation RemoveWorkflowStep($definitionId: ID!, $stepName: String!) {
    removeWorkflowStep(definitionId: $definitionId, stepName: $stepName) {
      id name version steps { id name label type }
    }
  }
`

export const EXPORT_REPORT_PDF = gql`
  mutation ExportReportPDF($templateId: ID!) {
    exportReportPDF(templateId: $templateId)
  }
`

export const EXPORT_REPORT_EXCEL = gql`
  mutation ExportReportExcel($templateId: ID!) {
    exportReportExcel(templateId: $templateId)
  }
`

export const RETRY_QUEUE_JOB = gql`
  mutation RetryQueueJob($queueName: String!, $jobId: ID!) {
    retryQueueJob(queueName: $queueName, jobId: $jobId)
  }
`
