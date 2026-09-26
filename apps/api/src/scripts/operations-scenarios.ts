/**
 * Puts one case of the operational remedies in a tenant, or takes it away
 * (lib/testData/operationsScenarios.ts). Launched by hand, one case at a time:
 *
 *   tsx scripts/operations-scenarios.ts --tenant demo-opengrafo --plant ci-health
 *   tsx scripts/operations-scenarios.ts --tenant demo-opengrafo --clean ci-health
 *   tsx scripts/operations-scenarios.ts --tenant demo-opengrafo --plant failed-job --queue notification-jobs
 */
import { refuseInProduction, resolveTenantArg, readOptionValue, ScriptArgError } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'
import { SCENARIOS, isScenario, plantScenario, cleanScenario } from '../lib/testData/operationsScenarios.js'
import { closeAllQueues } from '../lib/bullmq.js'
import { closeConnection, closeTenantQueues } from '@opengraphity/events'

runScript('operations-scenarios', async () => {
  try {
    refuseInProduction('operations-scenarios')
    const tenantId = resolveTenantArg()
    const plant = readOptionValue('--plant')
    const clean = readOptionValue('--clean')
    const which = plant ?? clean
    if ((plant === undefined) === (clean === undefined) || which === undefined || !isScenario(which)) {
      throw new ScriptArgError(`say --plant <case> or --clean <case>, one of: ${SCENARIOS.join(', ')}`)
    }
    const log = (m: string): void => { console.log(`[operations-scenarios] ${m}`) }
    const queue = readOptionValue('--queue')
    const opts = queue ? { queue } : {}
    if (plant) await plantScenario(which, tenantId, log, new Date(), opts)
    else await cleanScenario(which, tenantId, log, opts)
  } finally {
    // A tenant queue lives in @opengraphity/events and has its own connection: without these the process never ends.
    await closeTenantQueues()
    await closeAllQueues()
    await closeConnection()
  }
})
