/**
 * Seed idempotente del workflow "Problem Management" per un tenant
 * (definizione in @opengraphity/workflow, runner qui: D-31).
 *
 * Invocazione: pnpm --filter @opengraphity/api seed:problem-workflow -- --tenant=c-one
 */
import { seedProblemWorkflowForTenant } from '@opengraphity/workflow'
import { resolveTenantArg } from './lib/scriptArgs.js'

async function main() {
  const tenantId = resolveTenantArg()
  const definitionId = await seedProblemWorkflowForTenant(tenantId)
  console.log(`[seed-problem-workflow] tenant=${tenantId} definitionId=${definitionId}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1) })
