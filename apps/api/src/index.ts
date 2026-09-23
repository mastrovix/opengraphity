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
import { AutomationConsumer } from './consumers/automationConsumer.js'
import { ServiceImpactConsumer } from './consumers/serviceImpactConsumer.js'
import { closeConnection } from '@opengraphity/events'
import { closeDriver, registerSessionTracker } from '@opengraphity/neo4j'
import { neo4jQueryDurationSeconds, recordSlowQuery, startBullMQMetricsCollector } from './middleware/metrics.js'
import { getAllQueues, getQueue, getTenantQueue, closeAllQueues } from './lib/bullmq.js'
import { PLATFORM_QUEUE_NAMES, TENANT_QUEUE_BASES } from './lib/queueRegistry.js'
import { startTenantQueueLifecycle, stopTenantQueueLifecycle, tenantsWithQueues } from './lib/tenantQueueLifecycle.js'
import { wireDomainEventFailureMetric } from './lib/domainEventFailures.js'
import { runGracefulShutdown, type Closable } from './lib/shutdown.js'
import { accendiSinkDeiLog, spegniSinkDeiLog } from './lib/serverLogSink.js'
// Canale del metamodello (A-16): l'import registra i clearer dei moduli che
// tengono cache derivate dal metamodello; `startMetamodelBus()` apre la
// sottoscrizione Redis e registra il publisher usato da invalidateSchema.
import { startMetamodelBus, stopMetamodelBus } from './lib/metamodelBus.js'
// Import a effetto: registra sul canale il clearer delle cache del
// dispatcher delle notifiche (regole, lingua e fuso) — revisione totale ·
// E-20/A-15: erano invalidate solo nel processo che serviva la mutation.
import './lib/notificationRuleCache.js'

// Instrument every Neo4j session.run() — covers all 400+ call sites
registerSessionTracker((durationMs, query) => {
  neo4jQueryDurationSeconds.observe({ operation: 'QUERY' }, durationMs / 1000)
  if (durationMs > 500) recordSlowQuery(query || 'unknown', durationMs)
})
import { startReportScheduler } from './jobs/reportScheduler.js'
import { startAnomalyScanner } from './anomaly/anomalyEngine.js'
import { startProposalScanner } from './jobs/proposalScanner.js'
import { startWorkflowJobWorker, startNotificationJobWorker } from './jobs/workflowJobWorker.js'
import { startWebhookDeliveryWorker } from './jobs/webhookDeliveryWorker.js'
import { startAutoanalisiWorker } from './jobs/autoanalisiWorker.js'
import { startEventIngestWorker } from './jobs/eventIngestWorker.js'
import { startEventCorrelateWorker, startEventMaintenanceWorker } from './jobs/eventCorrelateWorker.js'
import { startServiceImpactWorker } from './jobs/serviceImpactWorker.js'
import { startEmbeddingWorker } from './jobs/embeddingWorker.js'
import { startEmailDigestWorker } from './jobs/emailDigestWorker.js'
import { registerAllConnectors } from './discovery/registerConnectors.js'
import { startSyncWorker } from './discovery/syncWorker.js'
import { startMaintenanceWorker } from './workers/maintenance.worker.js'
import { logger } from './lib/logger.js'
import { assertMigrationsAppliedAtBoot } from './lib/migrationState.js'
import { startInAppBus, stopInAppBus } from './lib/inAppBus.js'
import { assertEmailConfigured } from '@opengraphity/notifications'

async function main() {
  // Revisione del 14 set 2026 · F8: migrazioni pendenti dette all'avvio (e,
  // con REQUIRE_APPLIED_MIGRATIONS=true, avvio fermato).
  await assertMigrationsAppliedAtBoot({ require: config.requireAppliedMigrations, log: logger })
  // L'API invia e-mail (menzioni, osservatori, riepilogo): senza chiave in
  // produzione non parte. Il pacchetto non lancia più all'import, perché i
  // worker, che non inviano, lo importano anche loro.
  assertEmailConfigured()

  // Prima del server: una mutation sul metamodello servita subito dopo l'avvio
  // deve già trovare il canale aperto, altrimenti le altre repliche non
  // vengono avvisate e nessuno se ne accorge.
  startMetamodelBus()
  // F10: consegne in-app salvate e condivise fra i processi.
  startInAppBus()

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

  // Trigger e Business Rule su ogni evento che le pagine offrono (AU-1).
  const automationConsumer = new AutomationConsumer()
  await automationConsumer.start()

  // Report programmati (ogni minuto per tenant), anomalie (ogni ora), proposte
  // di miglioramento (un giro a notte): una coda per tenant ciascuno.
  const reportScheduler = startReportScheduler()
  const anomalyWorker = startAnomalyScanner()
  const proposalWorker = startProposalScanner()

  // Il giro dell'Autoanalisi che si chiude: porta il fascicolo su GitHub quando
  // nasce un Problem da una proposta, e ogni quarto d'ora chiede com'è finita.
  // Sta nell'API e non nel processo `events-worker`: è di PIATTAFORMA, uno per
  // installazione, e il lavoro che fa è una richiesta HTTP ogni tanto.
  const autoanalisiWorker = await startAutoanalisiWorker()

  // Workflow (scadenze dei passi, OLA, ripresa delle transizioni: le passate
  // di ogni tenant nella sua coda), riprove dei webhook, trigger a tempo.
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
  const eventWorkers: Closable[] = []
  const eventConsumers: Closable[] = []
  if (workGroups.includes('events')) {
    const serviceImpactConsumer = new ServiceImpactConsumer()
    await serviceImpactConsumer.start()
    eventConsumers.push({ name: 'service-impact-consumer', close: () => serviceImpactConsumer.stop() })
    eventWorkers.push(
      startEventIngestWorker(),
      startEventCorrelateWorker(),
      startEventMaintenanceWorker(),
      startServiceImpactWorker(),
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
  const emailDigestWorker = startEmailDigestWorker()

  // Register discovery connectors and start sync worker (the scheduled syncs
  // of each tenant are registered in its queue when its worker is created).
  registerAllConnectors()
  const syncWorker        = startSyncWorker()

  // Start maintenance worker (backup scheduler)
  const maintenanceWorker = await startMaintenanceWorker()

  /*
   * IL SINK DEI LOG DEL SERVER (20 set 2026, ondata 3). Da qui in poi ogni
   * riga `error`/`fatal` di QUESTO processo finisce nel grafo come template
   * scrubbato. Si accende dopo il driver, perché la prima cosa che fa è
   * aprire una sessione; le righe di avvio precedenti restano solo su stdout,
   * ed è un limite dichiarato — un errore che impedisce l'avvio non si legge
   * in un database a cui il processo non è ancora arrivato.
   */
  await accendiSinkDeiLog()

  /*
   * THE WORKERS FOLLOW THE TENANTS (23 Sep 2026). Every pool is registered by
   * now: each tenant gets its workers and its recurring jobs, and from here on
   * a tenant created, suspended, resumed or deleted is followed within
   * seconds (lib/tenantQueueLifecycle.ts). A failure at boot stops the boot.
   */
  await startTenantQueueLifecycle()

  // BullMQ queue-depth gauges for /metrics and the admin "System metrics" page
  // (A-14). The platform queues, and every tenant's queue of every base —
  // those whose workers run in another process included (revisione 2 ·
  // D2.2) — not only the ones this process happened to open. Getter: the
  // tenants of the last reconciliation. Interval is unref'd.
  for (const name of PLATFORM_QUEUE_NAMES) getQueue(name)
  startBullMQMetricsCollector(() => [
    ...getAllQueues(),
    ...tenantsWithQueues().flatMap((t) => TENANT_QUEUE_BASES.map((base) => getTenantQueue(base, t.id))),
  ])

  logger.info({ profile: config.workerProfile, workGroups }, 'All consumers started')

  // Every worker/consumer must be closed on shutdown; a job left in-flight is
  // redelivered at-least-once on the next boot (idempotency in BaseConsumer and
  // the SLAStatus MERGE keep that safe, but draining cleanly avoids the churn).
  const bullWorkers: Closable[] = [
    anomalyWorker, proposalWorker, autoanalisiWorker, workflowWorker, syncWorker, maintenanceWorker,
    notificationWorker, webhookDeliveryWorker, ...eventWorkers,
    emailDigestWorker, reportScheduler,
    ...(embeddingWorker ? [embeddingWorker] : []),
  ]
  const closables: Closable[] = [
    // Stop following the tenants first: no worker is created while the others close.
    { name: 'tenant-queue-lifecycle', close: () => stopTenantQueueLifecycle() },
    ...bullWorkers.map((w) => ({ name: w.name, close: () => w.close() })),
    { name: 'notification-service', close: () => notificationDispatcher.stop() },
    { name: 'sla-engine',           close: () => slaEngine.stop() },
    { name: 'escalation-consumer',  close: () => escalationConsumer.stop() },
    { name: 'automation-consumer',  close: () => automationConsumer.stop() },
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
        // Per primo: scrive le righe in attesa, e ha bisogno del driver che
        // viene chiuso in fondo a questa stessa lista.
        { name: 'server-log-sink',  close: () => spegniSinkDeiLog() },
        { name: 'metamodel-bus',    close: () => stopMetamodelBus() },
        { name: 'inapp-bus',        close: () => stopInAppBus() },
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
