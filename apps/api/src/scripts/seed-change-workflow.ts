/**
 * Seed idempotente del workflow "Change RFC Process".
 *
 * Usa `seedWorkflowDefinition` (MERGE per chiave naturale, step esistenti
 * conservati, niente DETACH DELETE): la versione precedente cancellava gli
 * step a ogni esecuzione orfanando le CURRENT_STEP delle change aperte.
 *
 * La definizione vive in ./lib/workflowDefinitions.ts (senza side effect) ed è
 * la stessa usata dall'onboarding tenant.
 *
 * Il seed NON sovrascrive una definizione esistente (B-2): se c'è già, la salta
 * e dice perché. Per riallinearla al seed di fabbrica: `--overwrite` (stampa
 * prima il diff); se il disegnatore l'ha marchiata come personalizzata serve
 * anche `--overwrite-customized`.
 *
 * Invocazione: pnpm --filter @opengraphity/api seed:change-workflow -- --tenant=c-one
 */
import { seedWorkflowDefinition } from '@opengraphity/workflow'
import { resolveTenantArg, resolveSeedOverwriteOpts } from './lib/scriptArgs.js'
import { CHANGE_RFC_WORKFLOW } from './lib/workflowDefinitions.js'

export { CHANGE_RFC_WORKFLOW }

async function main() {
  const tenantId = resolveTenantArg()
  const res = await seedWorkflowDefinition(tenantId, CHANGE_RFC_WORKFLOW, resolveSeedOverwriteOpts())
  console.log(`[seed-change-workflow] "${CHANGE_RFC_WORKFLOW.name}" tenant=${tenantId} defId=${res.definitionId} ${res.created ? 'creata' : res.skipped ? 'saltata (già presente)' : 'riscritta dal seed'}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1) })
