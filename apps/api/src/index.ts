import { initTelemetry } from './telemetry.js'
initTelemetry()

import { startServer } from './server.js'
import { createNotificationDispatcher } from '@opengraphity/notifications'
import { createSLAEngine } from '@opengraphity/sla'
import { closeConnection } from '@opengraphity/events'
import { closeDriver, registerSessionTracker } from '@opengraphity/neo4j'
import { neo4jQueryDurationSeconds, recordSlowQuery } from './middleware/metrics.js'

// Instrument every Neo4j session.run() — covers all 400+ call sites
registerSessionTracker((durationMs, query) => {
  neo4jQueryDurationSeconds.observe({ operation: 'QUERY' }, durationMs / 1000)
  if (durationMs > 500) recordSlowQuery(query || 'unknown', durationMs)
})
import { startReportScheduler } from './jobs/reportScheduler.js'
import { startAnomalyScanner } from './anomaly/anomalyEngine.js'
import { startWorkflowJobWorker, startNotificationJobWorker } from './jobs/workflowJobWorker.js'
import { startWebhookDeliveryWorker } from './jobs/webhookDeliveryWorker.js'
import { startEmbeddingWorker } from './jobs/embeddingWorker.js'
import { startEmailDigestWorker } from './jobs/emailDigestWorker.js'
import { registerAllConnectors } from './discovery/registerConnectors.js'
import { startSyncWorker, loadScheduledSyncs } from './discovery/syncWorker.js'
import { startMaintenanceWorker } from './workers/maintenance.worker.js'
import { logger } from './lib/logger.js'
import type { Worker } from 'bullmq'

async function main() {
  const httpServer = await startServer()

  // Start RabbitMQ consumers
  const notificationDispatcher = await createNotificationDispatcher()
  const slaEngine = await createSLAEngine()

  // Start report scheduler (BullMQ, every 60s)
  const reportScheduler = startReportScheduler()

  // Start anomaly scanner (BullMQ, every 1h)
  const anomalyWorker = startAnomalyScanner()

  // Start workflow job worker (BullMQ, processes auto_close and other scheduled jobs)
  const workflowWorker = startWorkflowJobWorker()

  // Start notification job worker (escalation_check, digest, timer_wait)
  const notificationWorker = startNotificationJobWorker()
  const webhookDeliveryWorker = startWebhookDeliveryWorker()
  // Embedding worker (semantic similarity: incident simili + KB suggerita)
  const embeddingWorker = startEmbeddingWorker()
  const emailDigestWorker = startEmailDigestWorker()

  // Register discovery connectors and start sync worker
  registerAllConnectors()
  const syncWorker        = startSyncWorker()
  await loadScheduledSyncs()

  // Start maintenance worker (backup scheduler)
  const maintenanceWorker = startMaintenanceWorker()

  logger.info('All consumers started')

  // Every worker/consumer must be closed on shutdown; a job left in-flight is
  // redelivered at-least-once on the next boot (idempotency in BaseConsumer and
  // the SLAStatus MERGE keep that safe, but draining cleanly avoids the churn).
  const bullWorkers: Worker[] = [
    anomalyWorker, workflowWorker, syncWorker, maintenanceWorker,
    notificationWorker, webhookDeliveryWorker, embeddingWorker,
    emailDigestWorker, reportScheduler,
  ]
  const baseConsumers = [notificationDispatcher, slaEngine]

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

    // Close all BullMQ workers and BaseConsumers with a 30s timeout
    const workerClosePromise = Promise.all([
      ...bullWorkers.map(w => w.close()),
      ...baseConsumers.map(c => c.stop()),
    ])
    const timedOut = await Promise.race([
      workerClosePromise.then(() => false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), 30_000)),
    ])
    logger.info(timedOut ? 'BullMQ workers close timed out after 30s' : 'BullMQ workers closed')

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
