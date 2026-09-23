/**
 * Registro UNICO delle code BullMQ della piattaforma (revisione 2 · D2.2).
 *
 * Prima la pagina Code (`queueStats`/`queueJobs`/`retryQueueJob`) aveva una
 * lista a mano di sei code — nessuna dell'Event Management né dei Servizi
 * monitorati — e il collector di `bullmq_queue_depth` vedeva solo le code
 * aperte con `getQueue` nel processo API: un job di ingest fallito
 * definitivamente non era né visibile né rigiocabile, e le quattro code dei
 * consumer di dominio (packages/events) erano fuori da ogni metrica.
 *
 * Qui c'è una voce per ogni coda che il codice crea, con:
 *  - `group`     il sottosistema, per raggruppare nell'interfaccia senza
 *                conoscere i nomi: `events` (allarmi), `services` (servizi
 *                monitorati), `itsm` (ticket, workflow, SLA, notifiche),
 *                `analysis` (integrazioni, report, anomalie, proposte,
 *                discovery, embedding: code di un tenant), `platform`
 *                (backup e Autoanalisi: code della piattaforma, che nessun
 *                tenant vede);
 *  - `retryable` se un job fallito si può rimettere in coda dalla console.
 *                È `false` per le code dei consumer di dominio
 *                (`CONSUMER_QUEUES` di packages/events): un evento di dominio
 *                esaurito ha già avuto 4 tentativi con i canali riusciti a
 *                metà (revisione 2 · D2.3, in-app già inviato) e non porta lo
 *                stato del job ma la copia dell'evento — rigiocarlo a mano
 *                ripete gli effetti collaterali già riusciti. Il rimedio è
 *                ripubblicare dall'azione di origine; il guasto resta visibile
 *                in `events_failed_total{queue,type}` e nella pagina Code.
 *
 *  - `scope`     `tenant`: una coda PER TENANT, `<nome>@<tenant>` (decisione del
 *                proprietario, 23 set 2026 — packages/events/src/tenantQueues.ts):
 *                il lavoro di un cliente sta solo nella sua coda, e la console
 *                di un tenant vede e rigioca solo quello. `platform`: una coda
 *                sola della piattaforma (backup, Autoanalisi), che nessun
 *                tenant vede.
 *
 * Il test `lib/__tests__/queueRegistry.test.ts` confronta questo registro
 * con i nomi usati da `getQueue`/`getTenantQueue`/`tenantQueue`/`new Queue`/
 * `createWorker`/`createTenantWorkers`/`super(...)` nel codice: una coda nuova
 * senza voce qui fa fallire il test, e così una coda aperta con l'API
 * dell'ambito sbagliato.
 *
 * Solo dati, nessun import di runtime: chi crea le code (jobs/*, consumers/*,
 * packages) non importa questo modulo, e questo modulo non importa loro.
 */
import { CONSUMER_QUEUES } from '@opengraphity/events'

export const QUEUE_GROUPS = ['events', 'services', 'itsm', 'analysis', 'platform'] as const
export type QueueGroup = (typeof QUEUE_GROUPS)[number]

export const QUEUE_SCOPES = ['tenant', 'platform'] as const
export type QueueScope = (typeof QUEUE_SCOPES)[number]

export interface QueueRegistryEntry {
  readonly name: string
  readonly group: QueueGroup
  /** Un job fallito si può rimettere in coda dalla console (`retryQueueJob`). */
  readonly retryable: boolean
  /** Coda di fan-out degli eventi di dominio (packages/events BaseConsumer). */
  readonly consumer: boolean
  /** Dove vive il worker (per chi legge il registro). */
  readonly owner: string
  /** Una coda per tenant (`<nome>@<tenant>`) o una sola della piattaforma. */
  readonly scope: QueueScope
}

function consumerEntry(name: (typeof CONSUMER_QUEUES)[number], group: QueueGroup, owner: string): QueueRegistryEntry {
  return { name, group, retryable: false, consumer: true, owner, scope: 'tenant' }
}

export const QUEUE_REGISTRY: readonly QueueRegistryEntry[] = [
  // ── Event Management (allarmi) ─────────────────────────────────────────────
  { name: 'events-ingest',      group: 'events', retryable: true, consumer: false, owner: 'jobs/eventIngestWorker.ts', scope: 'tenant' },
  { name: 'events-correlate',   group: 'events', retryable: true, consumer: false, owner: 'jobs/eventCorrelateWorker.ts', scope: 'tenant' },
  { name: 'events-maintenance', group: 'events', retryable: true, consumer: false, owner: 'jobs/eventCorrelateWorker.ts', scope: 'tenant' },
  // ── Servizi monitorati ─────────────────────────────────────────────────────
  { name: 'services-impact',    group: 'services', retryable: true, consumer: false, owner: 'jobs/serviceImpactWorker.ts', scope: 'tenant' },
  consumerEntry('service-impact-consumer', 'services', 'consumers/serviceImpactConsumer.ts'),
  // ── ITSM ───────────────────────────────────────────────────────────────────
  consumerEntry('notification-service', 'itsm', 'packages/notifications dispatcher'),
  consumerEntry('sla-engine',           'itsm', 'packages/sla engine'),
  consumerEntry('escalation-consumer',  'itsm', 'consumers/escalationConsumer.ts'),
  consumerEntry('automation-consumer',  'itsm', 'consumers/automationConsumer.ts'),
  { name: 'workflow-jobs',      group: 'itsm', retryable: true, consumer: false, owner: 'jobs/workflowJobWorker.ts', scope: 'tenant' },
  { name: 'notification-jobs',  group: 'itsm', retryable: true, consumer: false, owner: 'jobs/workflowJobWorker.ts', scope: 'tenant' },
  { name: 'sla-jobs',           group: 'itsm', retryable: true, consumer: false, owner: 'packages/sla scheduler', scope: 'tenant' },
  { name: 'email-digest',       group: 'itsm', retryable: true, consumer: false, owner: 'jobs/emailDigestWorker.ts', scope: 'tenant' },
  // ── Integrazioni e analisi (del tenant) · Piattaforma ─────────────────────
  { name: 'webhook-delivery',   group: 'analysis', retryable: true, consumer: false, owner: 'jobs/webhookDeliveryWorker.ts', scope: 'tenant' },
  { name: 'report-scheduler',   group: 'analysis', retryable: true, consumer: false, owner: 'jobs/reportScheduler.ts', scope: 'tenant' },
  { name: 'anomaly-scanner',    group: 'analysis', retryable: true, consumer: false, owner: 'anomaly/anomalyEngine.ts', scope: 'tenant' },
  { name: 'proposal-scanner',   group: 'analysis', retryable: true, consumer: false, owner: 'jobs/proposalScanner.ts', scope: 'tenant' },
  { name: 'autoanalisi',        group: 'platform', retryable: true, consumer: false, owner: 'jobs/autoanalisiWorker.ts', scope: 'platform' },
  { name: 'discovery-sync',     group: 'analysis', retryable: true, consumer: false, owner: 'discovery/syncWorker.ts', scope: 'tenant' },
  { name: 'embeddings',         group: 'analysis', retryable: true, consumer: false, owner: 'jobs/embeddingWorker.ts', scope: 'tenant' },
  { name: 'maintenance',        group: 'platform', retryable: true, consumer: false, owner: 'workers/maintenance.worker.ts', scope: 'platform' },
]

const BY_NAME: ReadonlyMap<string, QueueRegistryEntry> = new Map(QUEUE_REGISTRY.map((e) => [e.name, e]))

/** Tutti i nomi, nell'ordine del registro. */
export const QUEUE_NAMES: readonly string[] = QUEUE_REGISTRY.map((e) => e.name)

/** Le basi delle code per tenant: `<base>@<tenant>`. */
export const TENANT_QUEUE_BASES: readonly string[] = QUEUE_REGISTRY.filter((e) => e.scope === 'tenant').map((e) => e.name)

/** Le code della piattaforma: una sola ciascuna, di nessun tenant. */
export const PLATFORM_QUEUE_NAMES: readonly string[] = QUEUE_REGISTRY.filter((e) => e.scope === 'platform').map((e) => e.name)

export function isTenantQueueBase(name: string): boolean {
  return BY_NAME.get(name)?.scope === 'tenant'
}

export function isRegisteredQueue(name: string): boolean {
  return BY_NAME.has(name)
}

/** La voce del registro, o un errore che elenca le code conosciute. */
export function queueEntry(name: string): QueueRegistryEntry {
  const entry = BY_NAME.get(name)
  if (!entry) throw new Error(`Unknown queue: ${name} (known: ${QUEUE_NAMES.join(', ')})`)
  return entry
}
