import { gql } from '@apollo/client'

// ── Service Request ──────────────────────────────────────────────────────────

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

// ── Reports ──────────────────────────────────────────────────────────────────

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

export const UPDATE_REPORT_SCHEDULE = gql`
  mutation UpdateReportSchedule($templateId: ID!, $enabled: Boolean!, $cron: String, $recipients: [String!], $format: String) {
    updateReportSchedule(templateId: $templateId, enabled: $enabled, cron: $cron, recipients: $recipients, format: $format) {
      id scheduleEnabled scheduleCron scheduleRecipients scheduleFormat lastScheduledRun
    }
  }
`

// ── Dashboard ────────────────────────────────────────────────────────────────

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

export const CLONE_DASHBOARD = gql`
  mutation CloneDashboard($id: ID!, $newName: String!) {
    cloneDashboard(id: $id, newName: $newName) {
      id name description role isDefault isShared visibility
    }
  }
`

// ── Custom Widgets ───────────────────────────────────────────────────────────

export const CREATE_CUSTOM_WIDGET = gql`
  mutation CreateCustomWidget($input: CreateCustomWidgetInput!) {
    createCustomWidget(input: $input) {
      id title widgetType entityType metric
      groupByField filterField filterValue timeRange
      size color position dashboardId
    }
  }
`

export const UPDATE_CUSTOM_WIDGET = gql`
  mutation UpdateCustomWidget($id: ID!, $input: UpdateCustomWidgetInput!) {
    updateCustomWidget(id: $id, input: $input) {
      id title widgetType entityType metric
      groupByField filterField filterValue timeRange
      size color position dashboardId
    }
  }
`

export const DELETE_CUSTOM_WIDGET = gql`
  mutation DeleteCustomWidget($id: ID!) {
    deleteCustomWidget(id: $id)
  }
`

export const REORDER_CUSTOM_WIDGETS = gql`
  mutation ReorderCustomWidgets($dashboardId: ID!, $widgetIds: [ID!]!) {
    reorderCustomWidgets(dashboardId: $dashboardId, widgetIds: $widgetIds) {
      id position
    }
  }
`

// ── Notifications ────────────────────────────────────────────────────────────

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

// ── ITIL Type Designer ───────────────────────────────────────────────────────

const ITIL_TYPE_FRAGMENT = gql`
  fragment ITILTypeFields on CITypeDefinition {
    id name label icon color active validationScript
    fields {
      id name label fieldType
      required enumValues order isSystem
      enumTypeId enumTypeName
      validationScript visibilityScript defaultScript
    }
  }
`

export const UPDATE_ITIL_TYPE = gql`
  ${ITIL_TYPE_FRAGMENT}
  mutation UpdateITILType($id: ID!, $input: UpdateITILTypeInput!) {
    updateITILType(id: $id, input: $input) {
      ...ITILTypeFields
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

export const CREATE_ITIL_CI_RELATION_RULE = gql`
  mutation CreateITILCIRelationRule($itilType: String!, $ciType: String!, $relationType: String!, $direction: String!, $description: String) {
    createITILCIRelationRule(itilType: $itilType, ciType: $ciType, relationType: $relationType, direction: $direction, description: $description) {
      id itilType ciType relationType direction description
    }
  }
`

export const DELETE_ITIL_CI_RELATION_RULE = gql`
  mutation DeleteITILCIRelationRule($id: ID!) {
    deleteITILCIRelationRule(id: $id)
  }
`

// ── Enum Types ───────────────────────────────────────────────────────────────

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

// ── Queue / Sync ─────────────────────────────────────────────────────────────

export const RETRY_QUEUE_JOB = gql`
  mutation RetryQueueJob($queueName: String!, $jobId: ID!) {
    retryQueueJob(queueName: $queueName, jobId: $jobId)
  }
`

// ── Field Visibility Rules ───────────────────────────────────────────────────

export const CREATE_FIELD_VISIBILITY_RULE = gql`
  mutation CreateFieldVisibilityRule($entityType: String!, $triggerField: String!, $triggerValue: String!, $targetField: String!, $action: String!) {
    createFieldVisibilityRule(entityType: $entityType, triggerField: $triggerField, triggerValue: $triggerValue, targetField: $targetField, action: $action) {
      id entityType triggerField triggerValue targetField action
    }
  }
`

export const UPDATE_FIELD_VISIBILITY_RULE = gql`
  mutation UpdateFieldVisibilityRule($id: ID!, $triggerField: String, $triggerValue: String, $targetField: String, $action: String) {
    updateFieldVisibilityRule(id: $id, triggerField: $triggerField, triggerValue: $triggerValue, targetField: $targetField, action: $action) {
      id entityType triggerField triggerValue targetField action
    }
  }
`

export const DELETE_FIELD_VISIBILITY_RULE = gql`
  mutation DeleteFieldVisibilityRule($id: ID!) {
    deleteFieldVisibilityRule(id: $id)
  }
`

export const SET_FIELD_REQUIREMENT = gql`
  mutation SetFieldRequirement($entityType: String!, $fieldName: String!, $required: Boolean!, $workflowStep: String) {
    setFieldRequirement(entityType: $entityType, fieldName: $fieldName, required: $required, workflowStep: $workflowStep) {
      id entityType fieldName required workflowStep
    }
  }
`

export const DELETE_FIELD_REQUIREMENT = gql`
  mutation DeleteFieldRequirement($id: ID!) {
    deleteFieldRequirement(id: $id)
  }
`

// ── Auto Triggers ────────────────────────────────────────────────────────────

export const CREATE_AUTO_TRIGGER = gql`
  mutation CreateAutoTrigger($input: CreateAutoTriggerInput!) {
    createAutoTrigger(input: $input) {
      id name entityType eventType conditions timerDelayMinutes actions enabled executionCount lastExecutedAt
    }
  }
`

export const UPDATE_AUTO_TRIGGER = gql`
  mutation UpdateAutoTrigger($id: ID!, $input: UpdateAutoTriggerInput!) {
    updateAutoTrigger(id: $id, input: $input) {
      id name entityType eventType conditions timerDelayMinutes actions enabled executionCount lastExecutedAt
    }
  }
`

export const DELETE_AUTO_TRIGGER = gql`
  mutation DeleteAutoTrigger($id: ID!) { deleteAutoTrigger(id: $id) }
`

// ── Business Rules ───────────────────────────────────────────────────────────

export const CREATE_BUSINESS_RULE = gql`
  mutation CreateBusinessRule($input: CreateBusinessRuleInput!) {
    createBusinessRule(input: $input) {
      id name description entityType eventType conditionLogic conditions actions priority stopOnMatch enabled
    }
  }
`

export const UPDATE_BUSINESS_RULE = gql`
  mutation UpdateBusinessRule($id: ID!, $input: UpdateBusinessRuleInput!) {
    updateBusinessRule(id: $id, input: $input) {
      id name description entityType eventType conditionLogic conditions actions priority stopOnMatch enabled
    }
  }
`

export const DELETE_BUSINESS_RULE = gql`
  mutation DeleteBusinessRule($id: ID!) { deleteBusinessRule(id: $id) }
`

export const REORDER_BUSINESS_RULES = gql`
  mutation ReorderBusinessRules($ruleIds: [String!]!) {
    reorderBusinessRules(ruleIds: $ruleIds) {
      id name priority
    }
  }
`

// ── SLA Policies ─────────────────────────────────────────────────────────────

export const CREATE_SLA_POLICY = gql`
  mutation CreateSLAPolicy($input: CreateSLAPolicyInput!) {
    createSLAPolicy(input: $input) {
      id name entityType priority category teamId teamName timezone responseMinutes resolveMinutes businessHours enabled
    }
  }
`

export const UPDATE_SLA_POLICY = gql`
  mutation UpdateSLAPolicy($id: ID!, $input: UpdateSLAPolicyInput!) {
    updateSLAPolicy(id: $id, input: $input) {
      id name entityType priority category teamId teamName timezone responseMinutes resolveMinutes businessHours enabled
    }
  }
`

export const DELETE_SLA_POLICY = gql`
  mutation DeleteSLAPolicy($id: ID!) { deleteSLAPolicy(id: $id) }
`

// ── Collaboration ────────────────────────────────────────────────────────────

export const WATCH_ENTITY = gql`
  mutation WatchEntity($entityType: String!, $entityId: ID!) { watchEntity(entityType: $entityType, entityId: $entityId) }
`

export const UNWATCH_ENTITY = gql`
  mutation UnwatchEntity($entityType: String!, $entityId: ID!) { unwatchEntity(entityType: $entityType, entityId: $entityId) }
`

export const ADD_WATCHER = gql`
  mutation AddWatcher($entityType: String!, $entityId: ID!, $userId: ID!) { addWatcher(entityType: $entityType, entityId: $entityId, userId: $userId) }
`

export const REMOVE_WATCHER = gql`
  mutation RemoveWatcher($entityType: String!, $entityId: ID!, $userId: ID!) { removeWatcher(entityType: $entityType, entityId: $entityId, userId: $userId) }
`

export const SEND_INTERNAL_MESSAGE = gql`
  mutation SendInternalMessage($entityType: String!, $entityId: ID!, $body: String!) {
    sendInternalMessage(entityType: $entityType, entityId: $entityId, body: $body) {
      id authorId authorName body createdAt
    }
  }
`

export const EDIT_INTERNAL_MESSAGE = gql`
  mutation EditInternalMessage($messageId: ID!, $body: String!) {
    editInternalMessage(messageId: $messageId, body: $body) { id body editedAt }
  }
`

export const DELETE_INTERNAL_MESSAGE = gql`
  mutation DeleteInternalMessage($messageId: ID!) { deleteInternalMessage(messageId: $messageId) }
`

// ── Change Catalog ──────────────────────────────────────────────────────────

export const CREATE_CHANGE_CATALOG_CATEGORY = gql`
  mutation CreateChangeCatalogCategory($name: String!, $description: String, $icon: String, $color: String, $order: Int) {
    createChangeCatalogCategory(name: $name, description: $description, icon: $icon, color: $color, order: $order) { id name description icon color order enabled entryCount }
  }
`

export const UPDATE_CHANGE_CATALOG_CATEGORY = gql`
  mutation UpdateChangeCatalogCategory($id: ID!, $name: String, $description: String, $icon: String, $color: String, $order: Int, $enabled: Boolean) {
    updateChangeCatalogCategory(id: $id, name: $name, description: $description, icon: $icon, color: $color, order: $order, enabled: $enabled) { id name description icon color order enabled entryCount }
  }
`

export const DELETE_CHANGE_CATALOG_CATEGORY = gql`
  mutation DeleteChangeCatalogCategory($id: ID!) { deleteChangeCatalogCategory(id: $id) }
`

export const REORDER_CHANGE_CATALOG_CATEGORIES = gql`
  mutation ReorderChangeCatalogCategories($categoryIds: [ID!]!) {
    reorderChangeCatalogCategories(categoryIds: $categoryIds) { id name order }
  }
`

export const CREATE_STANDARD_CHANGE_CATALOG_ENTRY = gql`
  mutation CreateStandardChangeCatalogEntry($categoryId: String!, $name: String!, $description: String!, $riskLevel: String!, $impact: String!, $defaultTitleTemplate: String!, $defaultDescriptionTemplate: String!, $defaultPriority: String!, $ciTypes: [String!], $checklist: String, $estimatedDurationHours: Float, $requiresDowntime: Boolean, $rollbackProcedure: String, $icon: String, $color: String) {
    createStandardChangeCatalogEntry(categoryId: $categoryId, name: $name, description: $description, riskLevel: $riskLevel, impact: $impact, defaultTitleTemplate: $defaultTitleTemplate, defaultDescriptionTemplate: $defaultDescriptionTemplate, defaultPriority: $defaultPriority, ciTypes: $ciTypes, checklist: $checklist, estimatedDurationHours: $estimatedDurationHours, requiresDowntime: $requiresDowntime, rollbackProcedure: $rollbackProcedure, icon: $icon, color: $color) { id name }
  }
`

export const UPDATE_STANDARD_CHANGE_CATALOG_ENTRY = gql`
  mutation UpdateStandardChangeCatalogEntry($id: ID!, $name: String, $description: String, $categoryId: String, $riskLevel: String, $impact: String, $defaultTitleTemplate: String, $defaultDescriptionTemplate: String, $defaultPriority: String, $ciTypes: [String!], $checklist: String, $estimatedDurationHours: Float, $requiresDowntime: Boolean, $rollbackProcedure: String, $icon: String, $color: String, $enabled: Boolean) {
    updateStandardChangeCatalogEntry(id: $id, name: $name, description: $description, categoryId: $categoryId, riskLevel: $riskLevel, impact: $impact, defaultTitleTemplate: $defaultTitleTemplate, defaultDescriptionTemplate: $defaultDescriptionTemplate, defaultPriority: $defaultPriority, ciTypes: $ciTypes, checklist: $checklist, estimatedDurationHours: $estimatedDurationHours, requiresDowntime: $requiresDowntime, rollbackProcedure: $rollbackProcedure, icon: $icon, color: $color, enabled: $enabled) { id name }
  }
`

export const DELETE_STANDARD_CHANGE_CATALOG_ENTRY = gql`
  mutation DeleteStandardChangeCatalogEntry($id: ID!) { deleteStandardChangeCatalogEntry(id: $id) }
`

export const CREATE_CHANGE_FROM_CATALOG = gql`
  mutation CreateChangeFromCatalog($catalogEntryId: ID!, $title: String, $description: String, $ciIds: [ID!]) {
    createChangeFromCatalog(catalogEntryId: $catalogEntryId, title: $title, description: $description, ciIds: $ciIds) { id title status type }
  }
`
