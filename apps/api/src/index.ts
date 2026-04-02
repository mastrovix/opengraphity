import { startServer } from './server.js'
import { createNotificationDispatcher } from '@opengraphity/notifications'
import { createSLAEngine } from '@opengraphity/sla'
import { closeConnection } from '@opengraphity/events'
import { startReportScheduler } from './jobs/reportScheduler.js'
import { startAnomalyScanner } from './anomaly/anomalyEngine.js'
import { startWorkflowJobWorker } from './jobs/workflowJobWorker.js'
import { registerAllConnectors } from './discovery/registerConnectors.js'
import { startSyncWorker, loadScheduledSyncs } from './discovery/syncWorker.js'
import { logger } from './lib/logger.js'

async function main() {
  const httpServer = await startServer()

  // Start RabbitMQ consumers
  await createNotificationDispatcher()
  await createSLAEngine()

  // Start report scheduler (BullMQ, every 60s)
  startReportScheduler()

  // Start anomaly scanner (BullMQ, every 1h)
  startAnomalyScanner()

  // Start workflow job worker (BullMQ, processes auto_close and other scheduled jobs)
  startWorkflowJobWorker()

  // Register discovery connectors and start sync worker
  registerAllConnectors()
  startSyncWorker()
  await loadScheduledSyncs()

  logger.info('All consumers started')

  // ── Graceful shutdown ──────────────────────────────────────────────────────

  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info({ signal }, 'Received signal — shutting down gracefully')
    httpServer.close(() => {
      logger.info('HTTP server closed')
    })
    await closeConnection()
    logger.info('Redis connection closed')
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT',  () => void shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Fatal startup error')
  process.exit(1)
})
