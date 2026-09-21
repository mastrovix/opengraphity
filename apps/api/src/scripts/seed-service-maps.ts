/**
 * Servizi monitorati — seed demo: una mappa del servizio per ogni
 * BusinessApplication del tenant che non ne ha ancora una (logica in
 * scripts/lib/seedServiceMaps.ts). Idempotente.
 *
 * Uso: pnpm --filter @opengraphity/api seed:service-maps -- --tenant=<slug>
 *      (nel container: node --no-node-snapshot dist/scripts/seed-service-maps.js --tenant=<slug>,
 *       con NODE_ENV diverso da production come per ogni seed)
 * Opzioni: --max-depth=<1..8> (default 4), --relationships=DEPENDS_ON,HOSTED_ON,… (default tutte).
 */
import { closeConnection } from '@opengraphity/events'
import { closeAllQueues } from '../lib/bullmq.js'
import { parseSeedArgs, seedServiceMaps } from './lib/seedServiceMaps.js'
import { refuseInProduction } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'

runScript('seed-service-maps', async () => {
  refuseInProduction('seed-service-maps')
  const opts = parseSeedArgs(process.argv.slice(2))
  try {
    const r = await seedServiceMaps(opts)
    console.log(`Mappe create: ${r.created.length}`)
  } finally {
    // La valutazione pubblica service.health_changed (code BullMQ): vanno chiuse perché il processo termini.
    await closeAllQueues()
    await closeConnection()
  }
})
