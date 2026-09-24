/**
 * Prepares the two tenants of the integration suite on a throwaway Neo4j
 * (wave 7 · C2). The schema, the migrations and the shared metamodels come
 * first, from their own commands:
 *
 *   migrate --init-schema → seed:metamodel → seed-itil-metamodel → this → vitest
 *
 * `pnpm --filter @opengraphity/api test:integration` runs this and the suite.
 */
import { closeConnection as closeEventConnection } from '@opengraphity/events'
import { closeScheduler } from '@opengraphity/sla'
import { runScript } from '../scripts/lib/runScript.js'
import { closeAllQueues } from '../lib/bullmq.js'
import { stopInAppBus } from '../lib/inAppBus.js'
import { stopMetamodelBus } from '../lib/metamodelBus.js'
import { prepareIntegrationTenants } from './tenants.js'

runScript('integration-prepare', async () => {
  try {
    await prepareIntegrationTenants((m) => console.log(`[integration] ${m}`), Date.now())
  } finally {
    // The connections the app's code opens, closed like seed-demo-tenant closes them.
    await closeEventConnection()
    await stopInAppBus()
    await stopMetamodelBus()
    await closeAllQueues()
    await closeScheduler()
  }
})
