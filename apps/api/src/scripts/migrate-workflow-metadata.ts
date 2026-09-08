/**
 * Compat wrapper (npm script `migrate:workflow-metadata`): runs ONLY the
 * versioned migration 20260908_1000_workflow_step_metadata through the
 * migration runner (lock + marker). Already applied → no-op; pass `--force`
 * to re-apply it on workflows seeded with old data (it is idempotent).
 *
 * Prefer `scripts/migrate.ts` for the whole set.
 */
import { getSession, runMigrations } from '@opengraphity/neo4j'
import { workflowStepMetadata }      from './migrations/20260908_1000_workflow_step_metadata.js'
import { hasFlag }                   from './lib/scriptArgs.js'
import { runScript }                 from './lib/runScript.js'

runScript('migrate-workflow-metadata', async () => {
  const session = getSession(undefined, 'WRITE')
  try {
    const res = await runMigrations([workflowStepMetadata], { session, force: hasFlag('--force') })
    if (res.applied.length === 0) console.log('Già applicata: rilanciare con --force per riapplicarla (idempotente).')
  } finally {
    await session.close()
  }
})
