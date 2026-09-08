/**
 * Seed del workflow "KB Article" per un tenant (definizione in
 * @opengraphity/workflow, runner qui: D-31). Sostituisce il vecchio
 * packages/workflow/src/seed-kb-runner.ts, che aveva il tenant `c-one` cablato.
 *
 * Invocazione: pnpm --filter @opengraphity/api seed:kb-workflow -- --tenant=c-one
 */
import { seedKBWorkflowForTenant } from '@opengraphity/workflow'
import { resolveTenantArg } from './lib/scriptArgs.js'

async function main() {
  const tenantId = resolveTenantArg()
  const definitionId = await seedKBWorkflowForTenant(tenantId)
  console.log(`[seed-kb-workflow] tenant=${tenantId} definitionId=${definitionId}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1) })
