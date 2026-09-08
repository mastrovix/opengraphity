/**
 * Seed idempotente del workflow "Service Request Fulfillment".
 *
 * Usa `seedWorkflowDefinition` (MERGE per chiave naturale, step esistenti
 * conservati, niente DETACH DELETE): la versione precedente cancellava gli
 * step a ogni esecuzione orfanando le CURRENT_STEP delle richieste aperte.
 *
 * La definizione vive in ./lib/workflowDefinitions.ts (senza side effect) ed è
 * la stessa usata dall'onboarding tenant.
 *
 * Invocazione: pnpm --filter @opengraphity/api seed:sr-workflow -- --tenant=c-one
 */
import { seedWorkflowDefinition } from '@opengraphity/workflow'
import { resolveTenantArg } from './lib/scriptArgs.js'
import { SERVICE_REQUEST_WORKFLOW } from './lib/workflowDefinitions.js'

export { SERVICE_REQUEST_WORKFLOW }

async function main() {
  const tenantId = resolveTenantArg()
  const res = await seedWorkflowDefinition(tenantId, SERVICE_REQUEST_WORKFLOW)
  console.log(`[seed-service-request-workflow] "${SERVICE_REQUEST_WORKFLOW.name}" tenant=${tenantId} defId=${res.definitionId} ${res.created ? 'creata' : 'aggiornata'}`)
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1) })
