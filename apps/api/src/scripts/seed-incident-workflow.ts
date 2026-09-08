/**
 * Seed idempotente dei workflow Incident ("Incident Management" + variante
 * security) per un tenant. La definizione e la funzione seedWorkflowForTenant
 * vivono in @opengraphity/workflow (solo dati + funzioni, senza runner: D-31).
 *
 * Invocazione: pnpm --filter @opengraphity/api seed:incident-workflow -- --tenant=c-one
 */
import { seedWorkflowForTenant } from '@opengraphity/workflow'
import { resolveTenantArg } from './lib/scriptArgs.js'

async function main() {
  const tenantId = resolveTenantArg()
  const definitionId = await seedWorkflowForTenant(tenantId)
  console.log(`[seed-incident-workflow] tenant=${tenantId} definitionId=${definitionId}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1) })
