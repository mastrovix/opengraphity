/**
 * Standalone worker process — same image as the API, no HTTP API, different
 * entrypoint (infra/docker-compose.yml `worker` and `events-worker`).
 *
 * What it runs is decided by WORKER_PROFILE through the ONE table in
 * lib/workerProfiles.ts (revisione 2 · D1.1):
 *
 *  - `all` (default, compose service `worker`): the embedding worker. It runs
 *    a CPU-bound ONNX model that in the API process blocked the event loop;
 *    the API skips its own copy when EMBEDDING_WORKER_EXTERNAL=true.
 *  - `events` (compose service `events-worker`): the Event Management and
 *    Servizi monitorati workers (`events-ingest`, `events-correlate`,
 *    `events-maintenance`, `services-impact`) and the `service-impact-consumer`
 *    — ~12 job slots that used to share the API's Neo4j pool with the resolvers.
 *    The API runs with WORKER_PROFILE=api and starts none of them.
 *
 * The process serves GET /metrics on PORT (lib/metricsServer.ts): the pipeline
 * metrics live in the process that runs the pipeline, and Prometheus scrapes
 * every worker like it scrapes the API.
 */
// Fail-fast configuration for THIS process (a subset of the API's: no
// Keycloak, no attachments) — see CONFIG_PROFILES.worker in lib/config.ts.
import { validateConfig, config } from './lib/config.js'
validateConfig('worker')
import { workGroupsFor } from './lib/workerProfiles.js'
const workGroups = workGroupsFor('worker', config.workerProfile)

// Registra le condizioni di transizione ITSM sul workflow engine (side-effect):
// la correlazione degli allarmi e il motore dei servizi aprono e chiudono
// incident attraverso il workflow, esattamente come nell'API.
import './workflow/conditions.js'
import { closeDriver, registerSessionTracker } from '@opengraphity/neo4j'
import { closeConnection } from '@opengraphity/events'
import { neo4jQueryDurationSeconds, recordSlowQuery } from './middleware/metrics.js'
import { startEmbeddingWorker } from './jobs/embeddingWorker.js'
import { startEventIngestWorker } from './jobs/eventIngestWorker.js'
import { startEventCorrelateWorker, startEventMaintenanceWorker } from './jobs/eventCorrelateWorker.js'
import { startServiceImpactWorker } from './jobs/serviceImpactWorker.js'
import { ServiceImpactConsumer } from './consumers/serviceImpactConsumer.js'
import { closeAllQueues } from './lib/bullmq.js'
import { wireDomainEventFailureMetric } from './lib/domainEventFailures.js'
import { startMetricsServer } from './lib/metricsServer.js'
import { runGracefulShutdown, type Closable } from './lib/shutdown.js'
// Canale del metamodello (A-16): questo processo ha la SUA copia delle cache
// derivate dal metamodello e prima non veniva mai avvisato dei cambiamenti.
import { startMetamodelBus, stopMetamodelBus } from './lib/metamodelBus.js'
import { logger } from './lib/logger.js'
import type { Worker } from 'bullmq'

registerSessionTracker((durationMs, query) => {
  neo4jQueryDurationSeconds.observe({ operation: 'QUERY' }, durationMs / 1000)
  if (durationMs > 500) recordSlowQuery(query || 'unknown', durationMs)
})

async function main() {
  startMetamodelBus()

  const workers: Worker[] = []
  const consumers: Closable[] = []

  if (workGroups.includes('embedding')) {
    // Async: vector indexes are ensured BEFORE the worker starts (a failure is fatal here).
    workers.push(await startEmbeddingWorker())
  }
  if (workGroups.includes('events')) {
    wireDomainEventFailureMetric()
    const serviceImpactConsumer = new ServiceImpactConsumer()
    await serviceImpactConsumer.start()
    consumers.push({ name: 'service-impact-consumer', close: () => serviceImpactConsumer.stop() })
    workers.push(
      startEventIngestWorker(),
      await startEventCorrelateWorker(),
      await startEventMaintenanceWorker(),
      await startServiceImpactWorker(),
    )
  }
  if (workers.length === 0) {
    // The table cannot produce this today; if it ever does, an idle process must not look healthy.
    throw new Error(`WORKER_PROFILE=${config.workerProfile} starts no work group in the worker process`)
  }

  const metricsServer = await startMetricsServer(config.port)
  logger.info({ profile: config.workerProfile, workGroups, workers: workers.map((w) => w.name), consumers: consumers.map((c) => c.name) }, 'Worker process started')

  // ── Graceful shutdown (lib/shutdown.ts, revisione 2 · D1.2) ───────────────
  let shuttingDown = false
  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    void runGracefulShutdown({
      signal,
      httpServer: metricsServer,
      workers: [
        ...workers.map((w) => ({ name: w.name, close: () => w.close() })),
        ...consumers,
      ],
      resources: [
        { name: 'metamodel-bus',    close: () => stopMetamodelBus() },
        { name: 'bullmq-queues',    close: () => closeAllQueues() },
        { name: 'event-connection', close: () => closeConnection() },
        { name: 'neo4j-driver',     close: () => closeDriver() },
      ],
      log: logger,
      exit: (code) => process.exit(code),
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Fatal worker startup error')
  process.exit(1)
})
