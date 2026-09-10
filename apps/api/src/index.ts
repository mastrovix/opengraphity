import { initTelemetry } from './telemetry.js'
initTelemetry()

// Fail-fast configuration: every variable the API process needs is read (and
// its production guard run) here, before any queue/driver/server is opened.
// One error lists ALL the missing variables (G-07).
import { validateConfig, config } from './lib/config.js'
validateConfig('api')

import { startServer } from './server.js'
// Registra le condizioni di transizione ITSM sul workflow engine (side-effect).
import './workflow/conditions.js'
import { createNotificationDispatcher } from '@opengraphity/notifications'
import { createSLAEngine, closeScheduler } from '@opengraphity/sla'
import { EscalationConsumer } from './consumers/escalationConsumer.js'
import { ServiceImpactConsumer } from './consumers/serviceImpactConsumer.js'
import { closeConnection } from '@opengraphity/events'
import { closeDriver, registerSessionTracker } from '@opengraphity/neo4j'
import { neo4jQueryDurationSeconds, recordSlowQuery, startBullMQMetricsCollector } from './middleware/metrics.js'
import { getAllQueues, closeAllQueues } from './lib/bullmq.js'

// Instrument every Neo4j session.run() — covers all 400+ call sites
registerSessionTracker((durationMs, query) => {
  neo4jQueryDurationSeconds.observe({ operation: 'QUERY' }, durationMs / 1000)
  if (durationMs > 500) recordSlowQuery(query || 'unknown', durationMs)
})
import { startReportScheduler } from './jobs/reportScheduler.js'
import { startAnomalyScanner } from './anomaly/anomalyEngine.js'
import { startWorkflowJobWorker, startNotificationJobWorker } from './jobs/workflowJobWorker.js'
import { startWebhookDeliveryWorker } from './jobs/webhookDeliveryWorker.js'
import { startEventIngestWorker } from './jobs/eventIngestWorker.js'
import { startEventCorrelateWorker, startEventMaintenanceWorker } from './jobs/eventCorrelateWorker.js'
import { startServiceImpactWorker } from './jobs/serviceImpactWorker.js'
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

  // Auto-escalation on SLA / OLA-UC breach (executes the 'sla_breach'-triggered
  // workflow transition, e.g. incident in_progress → escalated).
  const escalationConsumer = new EscalationConsumer()
  await escalationConsumer.start()

  // Servizi monitorati: ci.health_changed → valutazione delle mappe che
  // includono il CI (coda services-impact, dedup per mappa) + passata periodica.
  const serviceImpactConsumer = new ServiceImpactConsumer()
  await serviceImpactConsumer.start()

  // Start report scheduler (BullMQ, every 60s)
  const reportScheduler = await startReportScheduler()

  // Start anomaly scanner (BullMQ, every 1h)
  const anomalyWorker = await startAnomalyScanner()

  // Start workflow job worker (BullMQ, processes auto_close and other scheduled jobs)
  const workflowWorker = startWorkflowJobWorker()

  // Start notification job worker (escalation_check, digest, timer_wait)
  const notificationWorker = startNotificationJobWorker()
  const webhookDeliveryWorker = startWebhookDeliveryWorker()
  // Event Management: allarmi dal monitoraggio (coda events-ingest),
  // correlazione ritardata / fine finestra di change (events-correlate) e
  // passate periodiche paginate (events-maintenance, concurrency 1)
  const eventIngestWorker = startEventIngestWorker()
  const eventCorrelateWorker = await startEventCorrelateWorker()
  const eventMaintenanceWorker = await startEventMaintenanceWorker()
  const serviceImpactWorker = await startServiceImpactWorker()
  // Embedding worker (semantic similarity). CPU-bound: when a dedicated worker
  // container runs it (EMBEDDING_WORKER_EXTERNAL=true) the API skips it so the
  // ONNX inference does not block the request event loop.
  const embeddingExternal = config.embeddingWorkerExternal
  const embeddingWorker = embeddingExternal ? null : await startEmbeddingWorker()
  if (embeddingExternal) logger.info('Embedding worker delegated to external worker process')
  const emailDigestWorker = await startEmailDigestWorker()

  // Register discovery connectors and start sync worker
  registerAllConnectors()
  const syncWorker        = startSyncWorker()
  await loadScheduledSyncs()

  // Start maintenance worker (backup scheduler)
  const maintenanceWorker = await startMaintenanceWorker()

  // BullMQ queue-depth gauges for /metrics and the admin "System metrics" page
  // (A-14). Getter: queues opened later are picked up too. Interval is unref'd.
  startBullMQMetricsCollector(getAllQueues)

  logger.info('All consumers started')

  // Every worker/consumer must be closed on shutdown; a job left in-flight is
  // redelivered at-least-once on the next boot (idempotency in BaseConsumer and
  // the SLAStatus MERGE keep that safe, but draining cleanly avoids the churn).
  const bullWorkers: Worker[] = [
    anomalyWorker, workflowWorker, syncWorker, maintenanceWorker,
    notificationWorker, webhookDeliveryWorker, eventIngestWorker, eventCorrelateWorker, eventMaintenanceWorker, serviceImpactWorker,
    emailDigestWorker, reportScheduler,
    ...(embeddingWorker ? [embeddingWorker] : []),
  ]
  const baseConsumers = [notificationDispatcher, slaEngine, escalationConsumer, serviceImpactConsumer]

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

    // Code singleton (lib/bullmq), poi SLA scheduler, poi publisher (D-24, A-13)
    await closeAllQueues()
    logger.info('BullMQ queues closed')
    await closeScheduler()
    logger.info('SLA scheduler closed')
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
