import { startServer } from './server.js'
import { createNotificationDispatcher } from '@opengraphity/notifications'
import { createSLAEngine } from '@opengraphity/sla'
import { closeConnection } from '@opengraphity/events'
import { closeDriver } from '@opengraphity/neo4j'
import { startReportScheduler } from './jobs/reportScheduler.js'
import { startAnomalyScanner } from './anomaly/anomalyEngine.js'
import { startWorkflowJobWorker } from './jobs/workflowJobWorker.js'
import { registerAllConnectors } from './discovery/registerConnectors.js'
import { startSyncWorker, loadScheduledSyncs } from './discovery/syncWorker.js'
import { logger } from './lib/logger.js'
import type { Worker } from 'bullmq'

async function main() {
  const httpServer = await startServer()

  // Start RabbitMQ consumers
  await createNotificationDispatcher()
  await createSLAEngine()

  // Start report scheduler (BullMQ, every 60s)
  startReportScheduler()

  // Start anomaly scanner (BullMQ, every 1h)
  const anomalyWorker = startAnomalyScanner()

  // Start workflow job worker (BullMQ, processes auto_close and other scheduled jobs)
  const workflowWorker = startWorkflowJobWorker()

  // Register discovery connectors and start sync worker
  registerAllConnectors()
  const syncWorker = startSyncWorker()
  await loadScheduledSyncs()

  logger.info('All consumers started')

  const bullWorkers: Worker[] = [anomalyWorker, workflowWorker, syncWorker]

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'Received signal — shutting down gracefully')

    // Stop accepting new HTTP connections
    httpServer.close(() => {
      logger.info('HTTP server closed')
    })

    // Close BullMQ workers with a 30s timeout
    const workerClosePromise = Promise.all(bullWorkers.map(w => w.close()))
    await Promise.race([
      workerClosePromise,
      new Promise<void>(resolve => setTimeout(resolve, 30_000)),
    ])
    logger.info('BullMQ workers closed')

    // Close RabbitMQ/Redis event connection
    await closeConnection()
    logger.info('Event connection closed')

    // Close Neo4j driver
    await closeDriver()
    logger.info('Neo4j driver closed')

    logger.info('Graceful shutdown completed')
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT',  () => void shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Fatal startup error')
  process.exit(1)
})
