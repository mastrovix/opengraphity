/**
 * Compat wrapper (npm script `migrate:workflow-metadata`).
 *
 * Modo normale: esegue SOLO la migrazione versionata
 * `20260908_1000_workflow_step_metadata` tramite il runner (lock + marker).
 * Già applicata → no-op; `--force` la riapplica.
 *
 * B-15 — che cosa `--force` NON fa più: la migrazione completa i metadati
 * MANCANTI (`coalesce`) e non riscrive mai `category` / `is_terminal` /
 * `is_initial` / `is_open` / `step_order` già valorizzati. `--force` serve a
 * completare i mancanti su workflow seminati con dati vecchi, non a riportare
 * tutto di fabbrica: prima cancellava in silenzio le scelte dell'amministratore.
 *
 * Per il ripristino di fabbrica vero — che quelle scelte le cancella davvero —
 * c'è `--reset-from-factory`, che prima stampa il diff (`--dry-run` per vederlo
 * senza scrivere). È distruttivo: richiede `--yes-reset`.
 *
 * Preferire `scripts/migrate.ts` per l'intero insieme.
 */
import { getSession, runMigrations } from '@opengraphity/neo4j'
import { workflowStepMetadata, resetWorkflowStepMetadataFromFactory } from './migrations/20260908_1000_workflow_step_metadata.js'
import { hasFlag, requireConfirmFlag } from './lib/scriptArgs.js'
import { runScript }                   from './lib/runScript.js'

runScript('migrate-workflow-metadata', async () => {
  const session = getSession(undefined, 'WRITE')
  try {
    if (hasFlag('--reset-from-factory')) {
      const dryRun = hasFlag('--dry-run')
      if (!dryRun) requireConfirmFlag('--yes-reset')
      console.log('[migrate-workflow-metadata] RIPRISTINO DI FABBRICA dei metadati dei passi: le scelte fatte dall\'amministratore su category/is_terminal/is_initial/is_open/step_order verranno cancellate.')
      const { changed } = await resetWorkflowStepMetadataFromFactory(session, { dryRun })
      if (changed === 0) console.log('[migrate-workflow-metadata] Nessun passo da riportare di fabbrica.')
      return
    }
    const res = await runMigrations([workflowStepMetadata], { session, force: hasFlag('--force') })
    if (res.applied.length === 0) console.log('Già applicata: rilanciare con --force per riapplicarla (completa solo i metadati mancanti, non riscrive nulla).')
  } finally {
    await session.close()
  }
})
