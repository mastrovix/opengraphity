/**
 * B-08 wrapper: runs ONLY the versioned migration
 * 20260908_1010_ci_configuration_item_label (adds :ConfigurationItem to the
 * typed CI nodes) through the migration runner. Already applied → no-op;
 * `--force` re-runs it (idempotent: only nodes still missing the label are touched),
 * useful after registering a new CITypeDefinition whose nodes pre-exist.
 *
 * Uso: pnpm --filter @opengraphity/api exec tsx --env-file=.env src/scripts/migrate-ci-labels.ts [--force]
 */
import { getSession, runMigrations } from '@opengraphity/neo4j'
import { ciConfigurationItemLabel }  from './migrations/20260908_1010_ci_configuration_item_label.js'
import { hasFlag }                   from './lib/scriptArgs.js'
import { runScript }                 from './lib/runScript.js'

runScript('migrate-ci-labels', async () => {
  const session = getSession(undefined, 'WRITE')
  try {
    const res = await runMigrations([ciConfigurationItemLabel], { session, force: hasFlag('--force') })
    if (res.applied.length === 0) console.log('Già applicata: rilanciare con --force per riapplicarla (idempotente).')
  } finally {
    await session.close()
  }
})
