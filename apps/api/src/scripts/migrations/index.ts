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

export const MIGRATIONS: readonly Migration[] = [
  workflowStepMetadata,
  ciConfigurationItemLabel,
]
