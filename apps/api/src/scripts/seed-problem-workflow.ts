/**
 * Seed idempotente del workflow "Problem Management" per un tenant
 * (definizione in @opengraphity/workflow, runner qui: D-31).
 *
 * Il seed NON sovrascrive una definizione esistente (B-2): se c'è già, la salta
 * e dice perché. Per riallinearla al seed di fabbrica: `--overwrite` (stampa
 * prima il diff); se il disegnatore l'ha marchiata come personalizzata serve
 * anche `--overwrite-customized`.
 *
 * Invocazione: pnpm --filter @opengraphity/api seed:problem-workflow -- --tenant=c-one
 */
import { seedProblemWorkflowForTenant } from '@opengraphity/workflow'
import { resolveTenantArg, resolveSeedOverwriteOpts } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'

async function main() {
  const tenantId = resolveTenantArg()
  const definitionId = await seedProblemWorkflowForTenant(tenantId, resolveSeedOverwriteOpts())
  console.log(`[seed-problem-workflow] tenant=${tenantId} definitionId=${definitionId}`)
}

runScript('seed-problem-workflow', main)
