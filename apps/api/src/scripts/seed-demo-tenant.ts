/**
 * A DEMO TENANT: THREE YEARS OF OPERATION (23 Sep 2026).
 *
 *   pnpm --filter @opengraphity/api seed:demo-tenant -- --tenant demo-opengrafo
 *   pnpm --filter @opengraphity/api seed:demo-tenant -- --tenant demo-opengrafo --seed acme --scale 0.1
 *   pnpm --filter @opengraphity/api seed:demo-tenant -- --tenant demo-opengrafo --verify
 *   pnpm --filter @opengraphity/api seed:demo-tenant -- --tenant demo-opengrafo --clean --yes-delete
 *
 * The rules live in `lib/testData/demoTenant/`: this file only reads the
 * arguments. `--scale` multiplies every count (0.1 = a tenth of the default
 * tenant, for a quick look); `--seed` picks the tenant (same seed, same
 * tenant); `--now` fixes the end of the period (ISO date), otherwise now.
 * `--clean` removes what a previous run wrote, and asks `--yes-delete`.
 */
import { refuseInProduction, resolveTenantArg, readOptionValue, hasFlag, requireConfirmFlag, ScriptArgError } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'
import { scaledDemoCounts, type DemoCounts } from '../lib/testData/demoTenant/options.js'
import { generateDemoTenant } from '../lib/testData/demoTenant/generate.js'
import { cleanDemoTenant } from '../lib/testData/demoTenant/clean.js'
import { verifyDemoTenant } from '../lib/testData/demoTenant/verify.js'
import { getSession, runQuery } from '@opengraphity/neo4j'
import { closeAllQueues } from '../lib/bullmq.js'
import { stopInAppBus } from '../lib/inAppBus.js'
import { closeConnection as closeEventConnection } from '@opengraphity/events'
import { stopMetamodelBus } from '../lib/metamodelBus.js'
import { closeScheduler } from '@opengraphity/sla'

runScript('seed-demo-tenant', async () => {
  try {
    await run()
  } finally {
    // The app's mutations publish on Redis (metamodel invalidations): close it, or the process never ends.
    /*
     * EVERY connection the app's code may open, closed the way the server
     * closes them on shutdown (index.ts). The one that held the process for
     * five hours on 22-23 September: `@opengraphity/events` opens one queue
     * per consumer (five of them) the first time a domain event is published,
     * and a monitored service created with components down publishes its
     * health — those five sockets outlived everything else, because only the
     * package's own `closeConnection` closes them. The two buses have their
     * own subscriber connections as well.
     */
    await closeEventConnection()
    await stopInAppBus()
    await stopMetamodelBus()
    await closeAllQueues()
    await closeScheduler()
    /*
     * THE WATCHDOG (23 Sep 2026). A run that finished its work and does not
     * exit is a run nobody notices: on the night of 22 September one stayed
     * alive for five hours after writing everything, and the verification
     * chained after it never started. Something the app's code opened — a
     * socket, a timer — outlived the closing above. Twenty seconds after the
     * end, whatever still holds the process is named and the process leaves,
     * with the exit code the run already set.
     */
    setTimeout(() => {
      console.error(`[seed-demo-tenant] still alive 20 s after finishing, held by: ${process.getActiveResourcesInfo().join(', ')}`)
      process.exit(process.exitCode ?? 0)
    }, 20_000).unref()
  }
})

async function run(): Promise<void> {
  refuseInProduction('seed-demo-tenant')
  const tenantId = resolveTenantArg()
  const log = (m: string): void => { console.log(`[seed-demo-tenant] ${m}`) }
  if (hasFlag('--clean')) {
    requireConfirmFlag('--yes-delete')
    const { deleted } = await cleanDemoTenant(tenantId, log)
    log(`${tenantId}: ${String(deleted)} demo nodes removed`)
    return
  }
  if (hasFlag('--verify')) {
    const session = getSession(undefined, 'READ')
    try {
      const run = (await runQuery<{ counts: string }>(session, `MATCH (r:DemoDataRun {tenant_id: $tenantId}) RETURN r.counts AS counts ORDER BY r.started_at DESC LIMIT 1`, { tenantId }))[0]
      if (!run) throw new ScriptArgError(`${tenantId} has no demo run to verify`)
      const report = await verifyDemoTenant(session, tenantId, JSON.parse(run.counts) as DemoCounts, log)
      for (const f of report.facts) log(`  · ${f}`)
      for (const f of report.failures.slice(0, 50)) log(`  ✖ ${f}`)
      if (report.failures.length) throw new Error(`${String(report.failures.length)} checks failed`)
    } finally { await session.close() }
    return
  }
  const scaleRaw = readOptionValue('--scale')
  const scale = scaleRaw === undefined ? 1 : Number(scaleRaw)
  if (!(scale > 0 && scale <= 1)) throw new ScriptArgError(`--scale must be a number in (0, 1] (got "${String(scaleRaw)}")`)
  const counts = scaledDemoCounts(scale)
  const nowRaw = readOptionValue('--now')
  const nowMs = nowRaw === undefined ? Date.now() : Date.parse(nowRaw)
  if (Number.isNaN(nowMs)) throw new ScriptArgError(`--now is not a date: "${String(nowRaw)}"`)
  const result = await generateDemoTenant({ tenantId, seed: readOptionValue('--seed') ?? 'opengrafo-demo', nowMs, years: 3, counts }, log)
  log(`${tenantId}: done in ${String(Math.round(result.durationMs / 1000))} s — ${String(result.nodes)} nodes, ${String(result.relationships)} relationships (run ${result.runId})`)
}
