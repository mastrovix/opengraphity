import { initTelemetry } from './telemetry.js'
initTelemetry()

// Fail-fast configuration: every variable the API process needs is read (and
// its production guard run) here, before any queue/driver/server is opened.
// One error lists ALL the missing variables (G-07).
import { validateConfig, config } from './lib/config.js'
validateConfig('api')
// Process profile (revisione 2 · D1.1): the ONE table of «profile → what
// starts» is lib/workerProfiles.ts; a profile that is not valid for the API
// process stops the boot here.
import { workGroupsFor } from './lib/workerProfiles.js'
const workGroups = workGroupsFor('api', config.workerProfile)

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
import { getAllQueues, getQueue, closeAllQueues } from './lib/bullmq.js'
import { QUEUE_REGISTRY } from './lib/queueRegistry.js'
import { wireDomainEventFailureMetric } from './lib/domainEventFailures.js'
import { runGracefulShutdown, type Closable } from './lib/shutdown.js'
// Canale del metamodello (A-16): l'import registra i clearer dei moduli che
// tengono cache derivate dal metamodello; `startMetamodelBus()` apre la
// sottoscrizione Redis e registra il publisher usato da invalidateSchema.
import { startMetamodelBus, stopMetamodelBus } from './lib/metamodelBus.js'

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
  // Prima del server: una mutation sul metamodello servita subito dopo l'avvio
  // deve già trovare il canale aperto, altrimenti le altre repliche non
  // vengono avvisate e nessuno se ne accorge.
  startMetamodelBus()

  const httpServer = await startServer()

  // Domain-event consumers that exhaust their retries → events_failed_total{queue,type}
  wireDomainEventFailureMetric()

  // Start domain-event consumers (BullMQ fan-out queues of packages/events)
  const notificationDispatcher = await createNotificationDispatcher()
  const slaEngine = await createSLAEngine()

  // Auto-escalation on SLA / OLA-UC breach (executes the 'sla_breach'-triggered
  // workflow transition, e.g. incident in_progress → escalated).
  const escalationConsumer = new EscalationConsumer()
  await escalationConsumer.start()

  // Start report scheduler (BullMQ, every 60s)
  const reportScheduler = await startReportScheduler()

  // Start anomaly scanner (BullMQ, every 1h)
  const anomalyWorker = await startAnomalyScanner()

  // Start workflow job worker (BullMQ, processes auto_close and other scheduled jobs)
  const workflowWorker = startWorkflowJobWorker()

  // Start notification job worker (escalation_check, digest, timer_wait)
  const notificationWorker = startNotificationJobWorker()
  const webhookDeliveryWorker = startWebhookDeliveryWorker()

  // Event Management + Servizi monitorati: allarmi dal monitoraggio (coda
  // events-ingest), correlazione ritardata / fine finestra di change
  // (events-correlate), passate periodiche paginate (events-maintenance,
  // concurrency 1), valutazione delle mappe (services-impact) e il consumer
  // che la innesca da ci.health_changed. Con WORKER_PROFILE=api tutto questo
  // gira nel processo `events-worker` (worker.ts) e l'API resta libera per le
  // richieste: qui non parte nulla, e il webhook continua ad accodare.
  const eventWorkers: Worker[] = []
  const eventConsumers: Closable[] = []
  if (workGroups.includes('events')) {
    const serviceImpactConsumer = new ServiceImpactConsumer()
    await serviceImpactConsumer.start()
    eventConsumers.push({ name: 'service-impact-consumer', close: () => serviceImpactConsumer.stop() })
    eventWorkers.push(
      startEventIngestWorker(),
      await startEventCorrelateWorker(),
      await startEventMaintenanceWorker(),
      await startServiceImpactWorker(),
    )
  } else {
    logger.info({ profile: config.workerProfile }, 'Event Management and Servizi monitorati workers delegated to the events worker process (WORKER_PROFILE)')
  }

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
  // (A-14). Every queue of the registry is opened here as a producer handle so
  // the gauge covers ALL of them — the consumer queues of packages/events and
  // the queues whose workers run in another process included (revisione 2 ·
  // D2.2) — not only the ones this process happened to open. Getter: queues
  // opened later are picked up too. Interval is unref'd.
  for (const entry of QUEUE_REGISTRY) getQueue(entry.name)
  startBullMQMetricsCollector(getAllQueues)

  logger.info({ profile: config.workerProfile, workGroups }, 'All consumers started')

  // Every worker/consumer must be closed on shutdown; a job left in-flight is
  // redelivered at-least-once on the next boot (idempotency in BaseConsumer and
  // the SLAStatus MERGE keep that safe, but draining cleanly avoids the churn).
  const bullWorkers: Worker[] = [
    anomalyWorker, workflowWorker, syncWorker, maintenanceWorker,
    notificationWorker, webhookDeliveryWorker, ...eventWorkers,
    emailDigestWorker, reportScheduler,
    ...(embeddingWorker ? [embeddingWorker] : []),
  ]
  const closables: Closable[] = [
    ...bullWorkers.map((w) => ({ name: w.name, close: () => w.close() })),
    { name: 'notification-service', close: () => notificationDispatcher.stop() },
    { name: 'sla-engine',           close: () => slaEngine.stop() },
    { name: 'escalation-consumer',  close: () => escalationConsumer.stop() },
    ...eventConsumers,
  ]

  // ── Graceful shutdown (lib/shutdown.ts, revisione 2 · D1.2) ───────────────
  // HTTP awaited for real (idle then all connections), workers within the
  // timeout; if they do not stop, the shared resources are NOT closed under the
  // in-flight jobs and the process exits ≠ 0 (the container is recreated).
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    void runGracefulShutdown({
      signal,
      httpServer,
      workers: closables,
      // Code singleton (lib/bullmq), poi SLA scheduler, poi publisher (D-24, A-13), poi il driver
      resources: [
        { name: 'metamodel-bus',    close: () => stopMetamodelBus() },
        { name: 'bullmq-queues',    close: () => closeAllQueues() },
        { name: 'sla-scheduler',    close: () => closeScheduler() },
        { name: 'event-connection', close: () => closeConnection() },
        { name: 'neo4j-driver',     close: () => closeDriver() },
      ],
      log: logger,
      exit: (code) => process.exit(code),
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT',  () => shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Fatal startup error')
  process.exit(1)
})
