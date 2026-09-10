/**
 * Registry of the application's versioned data migrations, in any order (the
 * runner sorts by id). To add one: create `YYYYMMDD_HHMM_name.ts` exporting a
 * `Migration`, import it here, append it to MIGRATIONS. Never edit an applied
 * migration — write a new one (the runner reports the checksum drift).
 *
 * Tenant-scoped, operator-driven data fixes (migrate-enum-references.ts,
 * which needs `--tenant`) are NOT migrations: they stay manual scripts.
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
]
