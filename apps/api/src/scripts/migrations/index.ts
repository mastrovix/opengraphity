/**
 * Registry of the application's versioned data migrations, in any order (the
 * runner sorts by id). To add one: create `YYYYMMDD_HHMM_name.ts` exporting a
 * `Migration`, import it here, append it to MIGRATIONS. Never edit an applied
 * migration — write a new one (the runner reports the checksum drift).
 *
 * Tenant-scoped, operator-driven data fixes (migrate-enum-references.ts,
 * which needs `--tenant`) are NOT migrations: they stay manual scripts.
 *
 * REGOLA ROTTA TRE VOLTE, e come si e rimediato (revisione totale · H-16).
 * Tre migrazioni sono state modificate DOPO il commit che le introduceva:
 * `20260908_1000_workflow_step_metadata`,
 * `20260908_1010_ci_configuration_item_label` e
 * `20260917_1810_ci_lifecycle_semantics`. La piu dannosa e la 1010: la sua
 * prima versione metteva `:ConfigurationItem` anche sui nodi dei tipi ITIL,
 * che hanno una `neo4j_label`; il filtro `scope <> 'itil'` e arrivato dopo, e
 * su un database migrato prima quei ticket sono rimasti etichettati come CI —
 * `migrate --status` lo mostrava come «drift» informativo e nessuno lo
 * traduceva in un'azione. La riparazione e la migrazione
 * `20261002_1070_remove_ci_label_from_tickets`, che toglie la label. Quando il
 * runner segnala un drift su una di queste tre, e quello: non riapplicarle.
 */
import type { Migration } from '@opengraphity/neo4j'
import { workflowStepMetadata }     from './20260908_1000_workflow_step_metadata.js'
import { ciConfigurationItemLabel } from './20260908_1010_ci_configuration_item_label.js'
import { eventManagementBootstrap } from './20260909_1000_event_management_bootstrap.js'
import { eventManagementFixup }     from './20260909_1010_event_management_fixup.js'
import { eventManagementNotificationRules } from './20260909_1020_event_management_notification_rules.js'
import { eventManagementCorrelationRules } from './20260909_1030_event_management_correlation_rules.js'
import { eventManagementPolicyV2 } from './20260909_1040_event_management_policy_v2.js'
import { eventManagementIndexes } from './20260909_1050_event_management_indexes.js'
import { eventManagementPolicyVersion } from './20260909_1060_event_management_policy_version.js'
import { eventManagementTenants } from './20260910_1070_event_management_tenants.js'
import { serviceMapsBootstrap } from './20260910_1080_service_maps_bootstrap.js'
import { serviceNotificationRules } from './20260910_1090_service_notification_rules.js'
import { serviceMapPlanLimit } from './20260910_1100_service_map_plan_limit.js'
import { serviceMapAutoSync } from './20260910_1110_service_map_auto_sync.js'
import { serviceMapReview2 } from './20260910_1120_service_map_review2.js'
import { sharedDomainRules } from './20260911_1130_shared_domain_rules.js'
import { notificationChannelsRoutable } from './20260911_1150_notification_channels_routable.js'
import { ciStatusVocabulary } from './20260912_1210_ci_status_vocabulary.js'
import { workflowStepActions } from './20260912_1210_workflow_step_actions.js'
import { systemEnumTypes } from './20260913_1300_system_enum_types.js'
import { tenantFieldsOnSharedTypes } from './20260913_1310_tenant_fields_on_shared_types.js'
import { workflowStepOrderSeeded } from './20260913_1400_workflow_step_order_seeded.js'
import { workflowStepTenantBackfill } from './20260913_1410_workflow_step_tenant_backfill.js'
import { workflowStepPurpose } from './20260914_1500_workflow_step_purpose.js'
import { stepEnteredNotificationRules } from './20260914_1520_step_entered_notification_rules.js'
import { serviceRoleAndRelationScope } from './20260916_1710_service_role_and_relation_scope.js'
import { globalSearchConfigurationItem } from './20260916_1700_global_search_configuration_item.js'
import { domainMatrices } from './20260917_1800_domain_matrices.js'
import { ciLifecycleSemantics } from './20260917_1810_ci_lifecycle_semantics.js'
import { changePrioritySeedFix } from './20260917_1820_change_priority_seed_fix.js'
import { provisionTenantDataMigration } from './20260918_1910_provision_tenant_data.js'
import { preApprovedChangeTypesSeed } from './20260918_1920_pre_approved_change_types.js'
import { ciStatusDefaultSeed } from './20260919_1600_ci_status_default.js'
import { riskBandThresholdsSeed } from './20260919_1610_risk_band_thresholds.js'
import { enumValueLabelsSeed } from './20260920_1700_enum_value_labels.js'
import { enumValueLabelsTenantCopies } from './20260920_1710_enum_value_labels_tenant_copies.js'
import { itilPriorityImpactUrgency } from './20260920_1720_itil_priority_impact_urgency.js'
import { enumValueLabelsPerLingua } from './20260920_1730_enum_value_labels_per_lingua.js'
import { enumValueLabelsIdentiche } from './20260920_1740_enum_value_labels_identiche.js'
import { tenantDefaultLanguage } from './20260920_1750_tenant_default_language.js'
import { teamTypeVocabolario } from './20260921_1000_team_type_vocabolario.js'
import { teamTypeEtichette } from './20260921_1010_team_type_etichette.js'
import { reportSectionGroupNode } from './20260922_1000_report_section_group_node.js'
import { concludedTicketsSla } from './20260922_1010_concluded_tickets_sla.js'
import { shippedMetamodelLabels } from './20260922_1020_shipped_metamodel_labels.js'
import { problemKnownErrorPurpose } from './20260923_1000_problem_known_error_purpose.js'
import { notificationRuleSeverity } from './20260923_1010_notification_rule_severity.js'
import { ticketOrphansCleanup } from './20260923_1020_ticket_orphans_cleanup.js'
import { commentsSingleModel } from './20260923_1030_comments_single_model.js'
import { majorIncidentNotificationRule } from './20260923_1040_major_incident_notification_rule.js'
import { slaWarningMinutes } from './20260923_1050_sla_warning_minutes.js'
import { changeTaskCounters } from './20260923_1060_change_task_counters.js'
import { reportDashboardChildrenTenant } from './20260923_1070_report_dashboard_children_tenant.js'
import { changeNumber } from './20260923_1080_change_number.js'
import { slaPolicyTimezoneInherit } from './20260924_1000_sla_policy_timezone_inherit.js'
import { environmentRiskMatrix } from './20260924_1010_environment_risk_matrix.js'
import { valueColorsKbCategory } from './20260924_1020_value_colors_kb_category.js'
import { serviceCalendar } from './20260924_1030_service_calendar.js'
import { kbPublishedAt } from './20260924_1040_kb_published_at.js'
import { changeEnvironmentWeightSeed } from './20260924_1050_change_environment_weight.js'
import { workflowLabelsByLanguage } from './20260924_1060_workflow_labels_by_language.js'
import { riskBandColors } from './20260925_1000_risk_band_colors.js'
import { serviceExclusionReasonCode } from './20260925_1010_service_exclusion_reason_code.js'
import { portalSeverityOptionsSeed } from './20260925_1020_portal_severity_options.js'
import { catalogItemPriority } from './20260925_1030_catalog_item_priority.js'
import { inAppRetentionPerTenant } from './20260925_1100_inapp_retention_per_tenant.js'
import { serviceUrgencyMatrix } from './20260925_1110_service_urgency_matrix.js'
import { catalogItemCategoryVocabulary } from './20260925_1120_catalog_item_category_vocabulary.js'
import { namedServiceCalendars } from './20260925_1130_named_service_calendars.js'
import { complianceObjectives } from './20260925_1140_compliance_objectives.js'
import { stepDeadlines } from './20260925_1200_step_deadlines.js'
import { impactAnalysisWeightsSeed } from './20260926_1000_impact_analysis_weights.js'
import { anomalyRuleConfigsSeed } from './20260926_1010_anomaly_rule_configs.js'
import { organizationSettingsSeed } from './20260927_1000_organization_settings.js'
import { factoryRoles } from './20260928_1000_factory_roles.js'
import { assistantPermission } from './20260928_1010_assistant_permission.js'
import { ciRelationTargetLabel } from './20260929_1000_ci_relation_target_label.js'
import { ticketCIExclusions } from './20260929_1010_ticket_ci_exclusions.js'
import { officeProductivityLabel } from './20260930_1000_office_productivity_label.js'
import { changeAuditDetailKeys } from './20260930_1010_change_audit_detail_keys.js'
import { changeAuditDetailKeysOwnerSupport } from './20260930_1020_change_audit_detail_keys_owner_support.js'
import { apiKeyExpiryRateLimit } from './20261001_1000_api_key_expiry_rate_limit.js'
import { userEmailLowercase } from './20261001_1010_user_email_lowercase.js'
import { answerOptionTenant } from './20261001_1020_answer_option_tenant.js'
import { requestCreatedBy } from './20261001_1030_request_created_by.js'
import { slaBreachedAt } from './20261002_1000_sla_breached_at.js'
import { changeTaskKeys } from './20261002_1010_change_task_keys.js'
import { slaWarningRepair } from './20261002_1020_sla_warning_repair.js'
import { stepDeadlineCalendar } from './20261002_1030_step_deadline_calendar.js'
import { serviceCalendarNameKey } from './20261002_1040_service_calendar_name_key.js'
import { eventPolicyHighImpact } from './20261002_1050_event_policy_high_impact.js'
import { slaNullResolveOutcome } from './20261002_1060_sla_null_resolve_outcome.js'
import { removeCiLabelFromTickets } from './20261002_1070_remove_ci_label_from_tickets.js'
import { catalogFormSchema } from './20261003_1010_catalog_form_schema.js'
import { catalogFormLimits } from './20261003_1020_catalog_form_limits.js'
import { formTableRowsLimit } from './20261004_1010_form_table_rows_limit.js'
import { metamodelDuplicateFields } from './20261005_1010_metamodel_duplicate_fields.js'
import { changeTransitionLabels } from './20261005_1020_change_transition_labels.js'
import { deployPlanWindowEnvelope } from './20261005_1030_deploy_plan_window_envelope.js'
import { ticketTeamSegments } from './20260930_1030_ticket_team_segments.js'
import { changeTaskTeamSegments } from './20260930_1040_change_task_team_segments.js'

export const MIGRATIONS: readonly Migration[] = [
  workflowStepMetadata,
  ciConfigurationItemLabel,
  eventManagementBootstrap,
  eventManagementFixup,
  eventManagementNotificationRules,
  eventManagementCorrelationRules,
  eventManagementPolicyV2,
  eventManagementIndexes,
  eventManagementPolicyVersion,
  eventManagementTenants,
  serviceMapsBootstrap,
  serviceNotificationRules,
  serviceMapPlanLimit,
  serviceMapAutoSync,
  serviceMapReview2,
  sharedDomainRules,
  notificationChannelsRoutable,
  ciStatusVocabulary,
  workflowStepActions,
  systemEnumTypes,
  tenantFieldsOnSharedTypes,
  workflowStepOrderSeeded,
  workflowStepTenantBackfill,
  workflowStepPurpose,
  stepEnteredNotificationRules,
  globalSearchConfigurationItem,
  serviceRoleAndRelationScope,
  domainMatrices,
  ciLifecycleSemantics,
  changePrioritySeedFix,
  provisionTenantDataMigration,
  preApprovedChangeTypesSeed,
  ciStatusDefaultSeed,
  riskBandThresholdsSeed,
  enumValueLabelsSeed,
  enumValueLabelsTenantCopies,
  itilPriorityImpactUrgency,
  enumValueLabelsPerLingua,
  enumValueLabelsIdentiche,
  tenantDefaultLanguage,
  teamTypeVocabolario,
  teamTypeEtichette,
  reportSectionGroupNode,
  concludedTicketsSla,
  shippedMetamodelLabels,
  problemKnownErrorPurpose,
  notificationRuleSeverity,
  ticketOrphansCleanup,
  commentsSingleModel,
  majorIncidentNotificationRule,
  slaWarningMinutes,
  changeTaskCounters,
  reportDashboardChildrenTenant,
  changeNumber,
  slaPolicyTimezoneInherit,
  environmentRiskMatrix,
  valueColorsKbCategory,
  serviceCalendar,
  kbPublishedAt,
  changeEnvironmentWeightSeed,
  workflowLabelsByLanguage,
  riskBandColors,
  serviceExclusionReasonCode,
  portalSeverityOptionsSeed,
  catalogItemPriority,
  inAppRetentionPerTenant,
  serviceUrgencyMatrix,
  catalogItemCategoryVocabulary,
  namedServiceCalendars,
  complianceObjectives,
  stepDeadlines,
  impactAnalysisWeightsSeed,
  anomalyRuleConfigsSeed,
  organizationSettingsSeed,
  factoryRoles,
  assistantPermission,
  ciRelationTargetLabel,
  ticketCIExclusions,
  officeProductivityLabel,
  changeAuditDetailKeys,
  changeAuditDetailKeysOwnerSupport,
  ticketTeamSegments,
  changeTaskTeamSegments,
  apiKeyExpiryRateLimit,
  userEmailLowercase,
  answerOptionTenant,
  requestCreatedBy,
  slaBreachedAt,
  changeTaskKeys,
  slaWarningRepair,
  stepDeadlineCalendar,
  serviceCalendarNameKey,
  eventPolicyHighImpact,
  slaNullResolveOutcome,
  removeCiLabelFromTickets,
  catalogFormSchema,
  catalogFormLimits,
  formTableRowsLimit,
  metamodelDuplicateFields,
  changeTransitionLabels,
  deployPlanWindowEnvelope,
]
