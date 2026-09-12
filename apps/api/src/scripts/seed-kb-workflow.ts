/**
 * Seed del workflow "KB Article" per un tenant (definizione in
 * @opengraphity/workflow, runner qui: D-31). Sostituisce il vecchio
 * packages/workflow/src/seed-kb-runner.ts, che aveva il tenant `c-one` cablato.
 *
 * Il seed NON sovrascrive una definizione esistente (B-2): se c'è già, la salta
 * e dice perché. Per riallinearla al seed di fabbrica: `--overwrite` (stampa
 * prima il diff); se il disegnatore l'ha marchiata come personalizzata serve
 * anche `--overwrite-customized`.
 *
 * Invocazione: pnpm --filter @opengraphity/api seed:kb-workflow -- --tenant=c-one
 */
import { seedKBWorkflowForTenant } from '@opengraphity/workflow'
import { resolveTenantArg, resolveSeedOverwriteOpts } from './lib/scriptArgs.js'

async function main() {
  const tenantId = resolveTenantArg()
  const definitionId = await seedKBWorkflowForTenant(tenantId, resolveSeedOverwriteOpts())
  console.log(`[seed-kb-workflow] tenant=${tenantId} definitionId=${definitionId}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1) })
