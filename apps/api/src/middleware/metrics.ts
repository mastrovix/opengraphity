import type { Request, Response, NextFunction } from 'express'
import { config } from '../lib/config.js'
import type { Queue } from 'bullmq'
import type { ApolloServerPlugin } from '@apollo/server'
import type { GraphQLContext } from '../context.js'
import { logger } from '../lib/logger.js'

// ── Types ─────────────────────────────────────────────────────────────────────

type Labels = Record<string, string>

export interface CounterSample { labels: Labels; value: number }
export interface GaugeSample   { labels: Labels; value: number }
export interface HistogramSample {
  labels: Labels
  sum:    number
  count:  number
  max:    number
  /** Cumulative bucket counts, parallel to `buckets` (then +Inf as the last entry). */
  bucketCounts: number[]
}

interface Counter {
  inc(labels: Labels, value?: number): void
  collect(): string
  /** Structured read of the internal map (A-14): no re-parsing of the text exposition. */
  snapshot(): CounterSample[]
}

interface Histogram {
  observe(labels: Labels, value: number): void
  collect(): string
  snapshot(): HistogramSample[]
  readonly buckets: readonly number[]
}

interface Gauge {
  set(labels: Labels, value: number): void
  collect(): string
  snapshot(): GaugeSample[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',')
}

function labelStr(labels: Labels): string {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`)
  return parts.length > 0 ? `{${parts.join(',')}}` : ''
}

function now(): number {
  return Date.now()
}

// ── Counter ───────────────────────────────────────────────────────────────────

export function createCounter(name: string, help: string, _labelNames: string[]): Counter {
  const counts = new Map<string, number>()
  const labelsMap = new Map<string, Labels>()

  return {
    inc(labels: Labels, value = 1): void {
      const key = labelKey(labels)
      counts.set(key, (counts.get(key) ?? 0) + value)
      labelsMap.set(key, labels)
    },
    collect(): string {
      const lines: string[] = [
        `# HELP ${name} ${help}`,
        `# TYPE ${name} counter`,
      ]
      for (const [key, count] of counts) {
        const labels = labelsMap.get(key) ?? {}
        lines.push(`${name}${labelStr(labels)} ${count} ${now()}`)
      }
      return lines.join('\n')
    },
    snapshot(): CounterSample[] {
      return [...counts].map(([key, value]) => ({ labels: labelsMap.get(key) ?? {}, value }))
    },
  }
}

// ── Histogram ─────────────────────────────────────────────────────────────────

export function createHistogram(
  name: string,
  help: string,
  _labelNames: string[],
  buckets: number[],
): Histogram {
  const sortedBuckets = [...buckets].sort((a, b) => a - b)

  interface BucketState {
    labels: Labels
    counts: number[]   // parallel to sortedBuckets, then +Inf
    sum:    number
    total:  number
    max:    number
  }

  const states = new Map<string, BucketState>()

  function getOrCreate(labels: Labels): BucketState {
    const key = labelKey(labels)
    if (!states.has(key)) {
      states.set(key, {
        labels,
        counts: new Array<number>(sortedBuckets.length + 1).fill(0),
        sum:    0,
        total:  0,
        max:    0,
      })
    }
    return states.get(key)!
  }

  return {
    buckets: sortedBuckets,
    observe(labels: Labels, value: number): void {
      const state = getOrCreate(labels)
      state.sum += value
      state.total += 1
      if (value > state.max) state.max = value
      for (let i = 0; i < sortedBuckets.length; i++) {
        if (value <= sortedBuckets[i]!) {
          state.counts[i]! += 1
        }
      }
      // +Inf bucket always gets the observation
      state.counts[sortedBuckets.length]! += 1
    },
    collect(): string {
      const lines: string[] = [
        `# HELP ${name} ${help}`,
        `# TYPE ${name} histogram`,
      ]
      for (const state of states.values()) {
        const base = labelStr(state.labels)
        const labelEntries = Object.entries(state.labels)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}="${v}"`)

        for (let i = 0; i < sortedBuckets.length; i++) {
          const le = sortedBuckets[i]!.toString()
          const bucketLabels = [...labelEntries, `le="${le}"`].join(',')
          lines.push(`${name}_bucket{${bucketLabels}} ${state.counts[i]} ${now()}`)
        }
        const infLabels = [...labelEntries, `le="+Inf"`].join(',')
        lines.push(`${name}_bucket{${infLabels}} ${state.counts[sortedBuckets.length]} ${now()}`)
        lines.push(`${name}_sum${base} ${state.sum} ${now()}`)
        lines.push(`${name}_count${base} ${state.total} ${now()}`)
      }
      return lines.join('\n')
    },
    snapshot(): HistogramSample[] {
      return [...states.values()].map(s => ({
        labels: s.labels, sum: s.sum, count: s.total, max: s.max, bucketCounts: [...s.counts],
      }))
    },
  }
}

// ── Gauge ─────────────────────────────────────────────────────────────────────

export function createGauge(name: string, help: string, _labelNames: string[]): Gauge {
  const values = new Map<string, number>()
  const labelsMap = new Map<string, Labels>()

  return {
    set(labels: Labels, value: number): void {
      const key = labelKey(labels)
      values.set(key, value)
      labelsMap.set(key, labels)
    },
    collect(): string {
      const lines: string[] = [
        `# HELP ${name} ${help}`,
        `# TYPE ${name} gauge`,
      ]
      for (const [key, value] of values) {
        const labels = labelsMap.get(key) ?? {}
        lines.push(`${name}${labelStr(labels)} ${value} ${now()}`)
      }
      return lines.join('\n')
    },
    snapshot(): GaugeSample[] {
      return [...values].map(([key, value]) => ({ labels: labelsMap.get(key) ?? {}, value }))
    },
  }
}

// ── Metric instances ──────────────────────────────────────────────────────────

export const httpRequestsTotal = createCounter(
  'http_requests_total',
  'Total HTTP requests',
  ['method', 'route', 'status_code'],
)

export const httpRequestDurationSeconds = createHistogram(
  'http_request_duration_seconds',
  'HTTP request duration in seconds',
  ['method', 'route'],
  [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
)

export const graphqlResolverDurationSeconds = createHistogram(
  'graphql_resolver_duration_seconds',
  'GraphQL resolver execution duration in seconds',
  ['resolver'],
  [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
)

export const neo4jQueryDurationSeconds = createHistogram(
  'neo4j_query_duration_seconds',
  'Neo4j query execution duration in seconds',
  ['operation'],
  [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
)

// Scheduled backup outcome (workers/maintenance.worker.ts): result = ok |
// backup_failed | verify_failed. Alert on `verify_failed` and on the
// last-success gauge going stale (> 25h): both mean "no valid backup".
export const backupRunsTotal = createCounter(
  'opengrafo_backup_runs_total',
  'Scheduled Neo4j backups by outcome',
  ['result'],
)

export const backupLastSuccessTimestamp = createGauge(
  'opengrafo_backup_last_success_timestamp_seconds',
  'Unix time of the last backup that passed verification',
  [],
)

export const bullmqQueueDepth = createGauge(
  'bullmq_queue_depth',
  'BullMQ queue depth by status',
  ['queue'],
)

// ── Event Management (ondata 4) ──────────────────────────────────────────────
// Incrementate dalla pipeline (services/eventService.ts, eventCorrelation.ts,
// eventStorm.ts) e dal job di conservazione (services/eventRetention.ts).
// `connector` è il connector_kind della sorgente (bounded: CONNECTOR_KINDS).

export const eventsReceivedTotal      = createCounter('events_received_total',      'Monitoring events ingested (new or repeated) by connector kind', ['connector'])
export const eventsDeduplicatedTotal  = createCounter('events_deduplicated_total',  'Monitoring events merged into an existing Event (same fingerprint)', [])
export const eventsOrphanTotal        = createCounter('events_orphan_total',        'Monitoring events ingested without a recognised CI', [])
/** Riconoscimento per nome con più CI candidati (A2): non agganciato, orfano con match_reason = ambiguous (conta anche in events_orphan_total). */
export const eventsAmbiguousTotal     = createCounter('events_ambiguous_total',     'Monitoring events left orphan because more than one CI matched the resource name (match_reason = ambiguous)', [])
export const eventsSuppressedTotal    = createCounter('events_suppressed_total',    'Monitoring events silenced by a change window', [])
export const eventsFlappingTotal      = createCounter('events_flapping_total',      'Monitoring events that entered the flapping state', [])
/**
 * Una regola di dominio ha cercato i passi con uno SCOPO (`WORKFLOW_STEP_PURPOSES`)
 * e nel workflow del tenant non ce n'è nessuno: la regola non si applica a
 * niente. `rule` è il nome della regola (bounded: oggi solo `change_window`).
 * Serve perché una regola spenta da una configurazione incompleta deve VEDERSI:
 * senza questo contatore, un tenant che non ha assegnato lo scopo al passo di
 * rilascio smetterebbe di silenziare gli allarmi durante i rilasci senza che
 * nessuno lo sappia (ondata 4 · A4-1).
 */
export const workflowPurposeMissingTotal = createCounter('workflow_step_purpose_missing_total', 'Domain rules that found no workflow step declaring the purpose they look for, by rule', ['rule'])

/**
 * Quante cose mancano a un cliente per essere usabile (revisione delle otto
 * ondate · D·D4). Il prodotto lo sapeva già (`tenantProvisioningGaps`) ma lo
 * diceva solo a chi lanciava `migrate --status`: un tenant incompleto restava
 * incompleto finché qualcuno non apriva un ticket e vedeva l'errore.
 */
export const tenantProvisioningGapsGauge = createGauge('tenant_provisioning_gaps', 'Configuration gaps that make a tenant unusable (0 = complete), by tenant', ['tenant'])
export const incidentsAutoOpenedTotal = createCounter('incidents_auto_opened_total', 'Incidents opened automatically by event correlation (storm incidents included)', [])
export const incidentsAutoResolvedTotal = createCounter('incidents_auto_resolved_total', 'Incidents resolved automatically when every correlated event cleared', [])
export const incidentsReopenedTotal   = createCounter('incidents_reopened_total',   'Resolved incidents reopened by a returning monitoring event', [])
export const eventsPurgedTotal        = createCounter('events_purged_total',        'Resolved monitoring events deleted by the purge_events retention job', [])
/**
 * Payload più vecchio dell'ultimo applicato alla stessa impronta ma con uno
 * stato DIVERSO: applicato lo stesso (revisione 2 · B2-06) e loggato a warn —
 * lo scarto silenzioso lasciava acceso per sempre un allarme il cui `resolved`
 * era arrivato "vecchio" (repliche API con orologi diversi, salto NTP).
 * Un payload vecchio con lo STESSO stato resta `duplicate` e non conta qui.
 */
export const eventsOutOfOrderTotal    = createCounter('events_out_of_order_total',  'Monitoring event payloads applied out of order (older than the last applied one, different status) by connector kind', ['connector'])
/** Job events-ingest fallito all'ultimo tentativo: l'allarme è perso e la sorgente porta last_error. */
export const eventsIngestFailedTotal  = createCounter('events_ingest_failed_total', 'Monitoring event ingest jobs that failed after the last retry by connector kind', ['connector'])
/** Elementi di un payload scartati dalla normalizzazione (A1: accettazione parziale del batch, il resto è stato accodato); la sorgente porta il riepilogo in last_error. */
export const eventsRejectedTotal      = createCounter('events_rejected_total',      'Monitoring alerts rejected by normalisation (invalid element of an otherwise accepted payload, or the whole payload) by connector kind', ['connector'])
/** `resolved` di un allarme mai visto (B5): l'Event nasce già risolto, senza avviso event.received/resolved/orphan. */
export const eventsResolvedUnknownTotal = createCounter('events_resolved_unknown_total', 'Resolved payloads for alerts never seen before (Event created already resolved, no notification) by connector kind', ['connector'])
export const eventStormsActive        = createGauge('event_storms_active',          'Monitoring sources currently in an alert storm', [])
/**
 * Richieste al webhook in ingresso rifiutate con 429 (rest/webhooks-inbound.ts).
 * `connector` = connector_kind per le sorgenti evento, entity_type
 * (incident | problem) per i webhook che creano ticket: insieme bounded.
 * Un valore che cresce durante una tempesta dice "alza rate_limit_per_minute
 * o raggruppa di più nello strumento", non "la sorgente è rotta".
 */
export const webhookRateLimitedTotal  = createCounter('webhook_rate_limited_total', 'Inbound webhook requests rejected with 429 by connector kind', ['connector'])

// ── Event Management, revisione (§4 Osservabilità) ─────────────────────────
// `outcome` è l'esito finale della pipeline (CORRELATION_OUTCOMES +
// auto_resolved/auto_resolve_skipped + `error` quando la pipeline lancia):
// insieme bounded. I cinque contatori sopra restano per i pannelli esistenti;
// questo dice TUTTI gli esiti, anche attached/skipped_*/delayed/none/storm.
export const eventsCorrelatedTotal    = createCounter('events_correlated_total',    'Event pipeline runs by final outcome (error = the pipeline threw)', ['outcome'])
export const eventPipelineDurationSeconds = createHistogram('event_pipeline_duration_seconds', 'Event correlation pipeline duration in seconds by mode (ingest | reevaluate | resume)', ['mode'], [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30])
/** Passate del job periodico `events-maintenance` (jobs/eventCorrelateWorker.ts): pass = closed_windows | pending | flapping | storms | gauges; result = ok | failed. */
export const eventPassTotal           = createCounter('event_pass_total',           'Periodic event maintenance passes by pass and result', ['pass', 'result'])
export const eventPassDurationSeconds = createHistogram('event_pass_duration_seconds', 'Periodic event maintenance pass duration in seconds', ['pass'], [0.1, 0.5, 1, 5, 10, 30, 60, 120, 300])
/** Eventi `delayed` con `correlation_due_at` scaduta da più di OVERDUE_DELAYED_GRACE_MINUTES: il job `correlate` non è arrivato (services/events/gauges.ts). */
export const eventsOverdueDelayed     = createGauge('events_overdue_delayed',       'Delayed monitoring events whose correlation due time passed more than 5 minutes ago', [])
/** Eventi firing con correlazione none/pending da più di UNCORRELATED_AFTER_MINUTES: pipeline fallita e mai ripresa. */
export const eventsFiringUncorrelated = createGauge('events_firing_uncorrelated',   'Firing monitoring events without a correlation outcome for more than 15 minutes', [])
/** Ritardo del job `correlate` rispetto alla scadenza del ritardo (processedAt − dueAt): coda in affanno. */
export const eventCorrelateJobLagSeconds = createHistogram('event_correlate_job_lag_seconds', 'Delay between a correlate job due time and its processing, in seconds', [], [0.5, 1, 5, 10, 30, 60, 300, 900])

// ── Servizi monitorati (mappa del servizio + albero d'impatto, ondata 1) ────
// Incrementate dal motore (services/serviceImpact/engine.ts): una valutazione
// per (mappa, innesco); `result` = changed | unchanged | error (bounded).
/** Valutazioni delle mappe per esito: `changed` (salute cambiata: voce di cronologia + service.health_changed), `unchanged`, `error` (il job ritenta). */
export const serviceEvaluationsTotal        = createCounter('service_evaluations_total', 'Service map evaluations by result (changed | unchanged | hold = suspended by a storming source | error)', ['result'])
export const serviceEvaluationDurationSeconds = createHistogram('service_evaluation_duration_seconds', 'Service map evaluation duration in seconds (read + rules + write)', [], [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10])
/** Mappe per salute su tutti i tenant, riallineato dalla passata periodica (jobs/serviceImpactWorker.ts). */
export const servicesHealth                 = createGauge('services_health', 'Service maps by current health (all tenants)', ['health'])

// ── Servizi monitorati (ondata 4: osservabilità) ────────────────────────────
/**
 * Incident di servizio aperti dal monitoraggio (services/serviceImpact/incident.ts).
 * La RIAPERTURA di un incident risolto conta come apertura: dal punto di vista
 * dell'esercizio il servizio è di nuovo fuori servizio, ed è quello che il
 * cruscotto deve mostrare; non c'è un secondo incident, quindi
 * `service_incidents_opened_total − service_incidents_resolved_total` non è il
 * numero di incident aperti ma il saldo delle transizioni.
 */
export const serviceIncidentsOpenedTotal   = createCounter('service_incidents_opened_total',   'Service incidents opened by the monitoring (a reopened incident counts as an opening)', [])
/** Incident di servizio risolti automaticamente al rientro del servizio (mai una chiusura forzata: `resolve_skipped` non conta). */
export const serviceIncidentsResolvedTotal = createCounter('service_incidents_resolved_total', 'Service incidents resolved automatically when the service came back (auto-resolve skipped does not count)', [])
/** Ritardo del job `evaluate` rispetto all'istante in cui era atteso (accodamento + delay): coda `services-impact` in affanno. */
export const serviceEvaluationLagSeconds   = createHistogram('service_evaluation_lag_seconds', 'Delay between a service map evaluation job due time and the start of the evaluation, in seconds', [], [0.5, 1, 5, 10, 30, 60, 300, 900])
/** Mappe con `stale = true` (un componente non esiste più nella CMDB) su tutti i tenant, riallineato dalla passata periodica insieme a `services_health`. */
export const serviceMapsStale              = createGauge('service_maps_stale', 'Service maps flagged stale (an included CI no longer exists in the CMDB, all tenants)', [])

// ── Servizi monitorati (ondata 5: mappa viva) ───────────────────────────────
/**
 * Sincronizzazioni della mappa con la CMDB per esito
 * (services/serviceImpact/sync.ts): `changed` (composizione cambiata: versione
 * nuova, voce di cronologia, rivalutazione), `unchanged` (solo `synced_at`),
 * `skipped_limit` (proposta oltre il tetto dei 500 nodi: NIENTE è stato
 * scritto se non `stale`, l'amministratore deve ridurre la profondità o
 * escludere) ed `error` (il job ritenta; la passata di sicurezza recupera).
 */
export const serviceMapSyncsTotal          = createCounter('service_map_syncs_total', 'Service map synchronizations with the CMDB by result (changed | unchanged | skipped_limit | error)', ['result'])

// ── Operatività (revisione 2, ondata 4: D2.2 / D7.2) ────────────────────────
/**
 * Ritardo fra la ricezione dell'allarme dal webhook (`receivedAt` del job) e
 * l'inizio del suo ingest (jobs/eventIngestWorker.ts): l'unica metrica che
 * dice «gli allarmi arrivano in ritardo» — coda `events-ingest` in affanno,
 * worker fermo, Redis ripartito con job accumulati. Stessi bucket dei ritardi
 * di correlazione e di valutazione (code a confronto).
 */
export const eventIngestLagSeconds = createHistogram('event_ingest_lag_seconds', 'Delay between the reception of a monitoring alert by the inbound webhook and the start of its ingest, in seconds', [], [0.5, 1, 5, 10, 30, 60, 300, 900])
/**
 * Eventi di dominio che hanno esaurito i tentativi di un consumer
 * (packages/events `onEventFailed`, cablato da lib/domainEventFailures.ts):
 * una notifica non inviata, uno SLA non avviato, una mappa non rivalutata.
 * `queue` = coda del consumer (CONSUMER_QUEUES), `type` = tipo dell'evento:
 * entrambi insiemi chiusi.
 */
export const eventsFailedTotal = createCounter('events_failed_total', 'Domain events lost after the last retry of a consumer, by consumer queue and event type', ['queue', 'type'])
/**
 * Lock Redis (lib/redisLock.ts): attese scadute e durata della sezione
 * critica. `lock` = famiglia della chiave (`events:group`, `events:storm-open`,
 * `services:incident`), mai la chiave intera (che porta tenant e id).
 * Un timeout non è un guasto (il job ritenta), ma tanti timeout, o sezioni
 * critiche vicine al TTL di 30 s, dicono che il lock scade sotto il lavoro
 * (revisione 2 · D2.6) e la gara che evita torna possibile.
 */
export const redisLockTimeoutsTotal = createCounter('redis_lock_timeouts_total', 'Redis lock acquisitions abandoned after the wait timeout (the job retries), by lock family', ['lock'])
export const redisLockHoldSeconds   = createHistogram('redis_lock_hold_seconds', 'Time a Redis lock was held (critical section duration) in seconds, by lock family', ['lock'], [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60])

// ── Schema GraphQL per tenant (ondata 5, A-1) ────────────────────────────────
// Lo schema non è più uno solo: ogni tenant ha il proprio, generato dal suo
// metamodello e tenuto in una cache limitata. Queste metriche dicono se la
// cache sta lavorando e — soprattutto — se lo schema di un tenant NON si
// costruisce: in quel caso l'API serve lo schema «sicuro» (base + ITIL, senza
// i tipi del cliente) per non lasciare il tenant senza API e senza la mutation
// per rimediare, e questo contatore è l'unico modo per accorgersene.

export const graphqlSchemaBuildsTotal = createCounter('graphql_schema_builds_total', 'Schemi GraphQL generati (per tenant): un valore che cresce senza modifiche al metamodello significa cache che non trattiene', [])
export const graphqlSchemaEvictionsTotal = createCounter('graphql_schema_evictions_total', 'Schemi tolti dalla cache perché è piena (GRAPHQL_SCHEMA_CACHE_MAX): se cresce, alza il limite o riduci i tenant per replica', [])
export const graphqlSchemaBuildFailedTotal = createCounter('graphql_schema_build_failed_total', 'Schemi di un tenant che NON si sono costruiti (di norma un tipo o un campo personalizzato che collide): il tenant sta ricevendo lo schema sicuro, senza i suoi tipi. Va guardato subito', [])
export const graphqlSchemaCacheEntries = createGauge('graphql_schema_cache_entries', 'Schemi GraphQL attualmente in cache in questo processo', [])

/** Metriche dello schema per tenant, nell'ordine di esposizione. */
export const SCHEMA_METRICS = [
  graphqlSchemaBuildsTotal, graphqlSchemaEvictionsTotal, graphqlSchemaBuildFailedTotal, graphqlSchemaCacheEntries,
] as const

/** Tutte le metriche dell'Event Management (e dei servizi monitorati), nell'ordine di esposizione. */
export const EVENT_MANAGEMENT_METRICS = [
  eventsReceivedTotal, eventsDeduplicatedTotal, eventsOrphanTotal, eventsAmbiguousTotal, eventsSuppressedTotal, eventsFlappingTotal,
  workflowPurposeMissingTotal,
  tenantProvisioningGapsGauge,
  incidentsAutoOpenedTotal, incidentsAutoResolvedTotal, incidentsReopenedTotal, eventsPurgedTotal,
  eventsOutOfOrderTotal, eventsIngestFailedTotal, eventsRejectedTotal, eventsResolvedUnknownTotal, eventStormsActive, webhookRateLimitedTotal,
  eventsCorrelatedTotal, eventPipelineDurationSeconds, eventPassTotal, eventPassDurationSeconds,
  eventsOverdueDelayed, eventsFiringUncorrelated, eventCorrelateJobLagSeconds,
  serviceEvaluationsTotal, serviceEvaluationDurationSeconds, servicesHealth,
  serviceIncidentsOpenedTotal, serviceIncidentsResolvedTotal, serviceEvaluationLagSeconds, serviceMapsStale,
  serviceMapSyncsTotal,
  eventIngestLagSeconds, eventsFailedTotal, redisLockTimeoutsTotal, redisLockHoldSeconds,
] as const

// ── Route label (A-15) ────────────────────────────────────────────────────────

/**
 * Bounded route label: the matched Express route pattern (mount + path) or
 * the mount point alone (e.g. `/graphql`, handled by a non-route middleware).
 * Anything unmatched collapses to `unmatched` — the previous
 * `normaliseRoute(req.path)` created a new series for every distinct 404 path,
 * an attacker-controlled memory leak.
 */
export function routeLabel(req: Pick<Request, 'route' | 'baseUrl'>): string {
  const routePath = (req.route as { path?: string | string[] } | undefined)?.path
  if (routePath) {
    const p = Array.isArray(routePath) ? routePath[0] ?? '' : routePath
    return `${req.baseUrl ?? ''}${p}` || '/'
  }
  if (req.baseUrl) return req.baseUrl
  return 'unmatched'
}

// ── Express middleware ────────────────────────────────────────────────────────

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint()

  res.on('finish', () => {
    const route      = routeLabel(req)
    const method     = req.method
    const statusCode = String(res.statusCode)
    const durationNs = process.hrtime.bigint() - start
    const durationS  = Number(durationNs) / 1e9

    httpRequestsTotal.inc({ method, route, status_code: statusCode })
    httpRequestDurationSeconds.observe({ method, route }, durationS)
  })

  next()
}

// ── Metrics handler + access guard (A-15) ─────────────────────────────────────

const PRIVATE_NET_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/

/** True for loopback and RFC1918 (docker bridge) addresses. */
export function isPrivateAddress(addr: string | undefined): boolean {
  if (!addr) return false
  const ip = addr.startsWith('::ffff:') ? addr.slice(7) : addr
  if (ip === '::1') return true
  return PRIVATE_NET_RE.test(ip)
}

/**
 * Access policy for GET /metrics:
 * - `METRICS_TOKEN` set → `Authorization: Bearer <token>` required (any source).
 * - not set → only loopback / private (docker) networks, judged on the SOCKET
 *   address (not `req.ip`: with `trust proxy` an X-Forwarded-For header could
 *   spoof it).
 */
export function metricsAccessAllowed(req: Pick<Request, 'headers' | 'socket'>, token = config.metricsToken): boolean {
  if (token) {
    const auth = req.headers['authorization'] ?? ''
    return auth === `Bearer ${token}`
  }
  return isPrivateAddress(req.socket?.remoteAddress)
}

// ── Canale del metamodello fra i processi (ondata 5 → 8) ─────────────────────
// `lib/metamodelBus.ts` porta «il metamodello di questo tenant è cambiato» alle
// altre repliche e ai worker. Finora si vedeva solo nei log, e i due guasti che
// contano sono silenziosi per chi guarda un grafico: un `PUBLISH` che trova
// **zero** ascoltatori (le altre repliche resteranno vecchie fino al TTL) e un
// processo che **non è sottoscritto** (non verrà mai avvisato). Qui diventano
// numeri, con la regola Prometheus che li sorveglia in infra/prometheus/.

export const metamodelPublishedTotal = createCounter('metamodel_published_total', 'Cambiamenti del metamodello pubblicati sul canale, per esito: delivered = almeno un processo in ascolto, no_receivers = nessuno (le altre repliche restano vecchie), error = PUBLISH fallito', ['result'])
export const metamodelReceivedTotal = createCounter('metamodel_received_total', 'Messaggi del canale del metamodello ricevuti da QUESTO processo, per esito: applied = cache svuotate, stale = versione già applicata o fuori ordine, malformed = messaggio scartato', ['result'])
export const metamodelCacheClearFailuresTotal = createCounter('metamodel_cache_clear_failures_total', 'Cache del metamodello che NON si sono svuotate (il clearer ha lanciato): quel processo resta con dati vecchi per quel tenant fino alla scadenza del TTL', ['cache'])
export const metamodelBusSubscribed = createGauge('metamodel_bus_subscribed', 'Questo processo è sottoscritto al canale del metamodello (1) oppure no (0): a 0 non viene avvisato dei cambiamenti fatti altrove', [])

/** Metriche del canale del metamodello, nell'ordine di esposizione. */
export const METAMODEL_BUS_METRICS = [
  metamodelPublishedTotal, metamodelReceivedTotal, metamodelCacheClearFailuresTotal, metamodelBusSubscribed,
] as const

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'

/** L'esposizione Prometheus completa di questo processo (API e worker la servono allo stesso modo). */
export function renderMetrics(): string {
  return [
    httpRequestsTotal.collect(),
    httpRequestDurationSeconds.collect(),
    graphqlResolverDurationSeconds.collect(),
    neo4jQueryDurationSeconds.collect(),
    bullmqQueueDepth.collect(),
    backupRunsTotal.collect(),
    backupLastSuccessTimestamp.collect(),
    ...EVENT_MANAGEMENT_METRICS.map((m) => m.collect()),
    ...SCHEMA_METRICS.map((m) => m.collect()),
    ...METAMODEL_BUS_METRICS.map((m) => m.collect()),
  ].join('\n\n')
}

export function metricsHandler(req: Request, res: Response): void {
  if (!metricsAccessAllowed(req)) {
    res.status(config.metricsToken ? 401 : 403).type('text/plain').send('metrics: forbidden')
    return
  }
  res.setHeader('Content-Type', METRICS_CONTENT_TYPE)
  res.send(renderMetrics())
}

// ── Apollo Server plugin ──────────────────────────────────────────────────────

export const graphqlMetricsPlugin: ApolloServerPlugin<GraphQLContext> = {
  async requestDidStart() {
    return {
      async executionDidStart() {
        return {
          willResolveField({ info }) {
            const start = process.hrtime.bigint()
            return () => {
              const durationNs = process.hrtime.bigint() - start
              const durationS  = Number(durationNs) / 1e9
              const resolver   = `${info.parentType.name}.${info.fieldName}`
              graphqlResolverDurationSeconds.observe({ resolver }, durationS)
            }
          },
        }
      },
      // Resolver errors (A-14): attributed to the root field of the error path
      // (`Mutation.createIncident`), which is what the admin dashboard lists.
      async didEncounterErrors(ctx) {
        const rootType = ctx.operation?.operation
          ? ctx.operation.operation.charAt(0).toUpperCase() + ctx.operation.operation.slice(1)
          : 'Unknown'
        for (const err of ctx.errors) {
          const code = (err.extensions?.['code'] as string | undefined) ?? ''
          if (code === 'UNAUTHORIZED' || code === 'GRAPHQL_VALIDATION_FAILED' || code === 'GRAPHQL_PARSE_FAILED') continue
          const root = err.path?.[0]
          const name = root != null ? `${rootType}.${String(root)}` : `${rootType}.<request>`
          recordResolverError(name, err.message)
        }
      },
    }
  },
}

// ── Structured data interfaces ────────────────────────────────────────────────

export interface RequestMetricsData {
  totalRequests: number
  requestsPerMinute: number
  averageResponseMs: number
  p95ResponseMs: number
  errorRate: number
  statusCodes: { code: string; count: number }[]
}

export interface ResolverMetricData {
  name: string
  averageMs: number
  maxMs: number
  count: number
}

export interface ResolverErrorData {
  name: string
  count: number
  lastError: string | null
}

export interface GraphQLMetricsData {
  totalOperations: number
  slowestResolvers: ResolverMetricData[]
  errorsByResolver: ResolverErrorData[]
}

export interface SlowQueryEntry {
  query: string
  durationMs: number
  timestamp: string
}

export interface Neo4jMetricsData {
  totalQueries: number
  averageQueryMs: number
  slowQueries: SlowQueryEntry[]
  connectionPoolActive: number
  connectionPoolIdle: number
}

export interface ProcessMetricsData {
  memoryUsageMb: number
  memoryRssMb: number
  cpuUsagePercent: number
  nodeVersion: string
  uptimeSeconds: number
  pid: number
}

// ── Slow query buffer ─────────────────────────────────────────────────────────

const slowQueryBuffer: SlowQueryEntry[] = []
const MAX_SLOW_QUERIES = 20

export function recordSlowQuery(query: string, durationMs: number): void {
  slowQueryBuffer.push({
    query: query.slice(0, 200),
    durationMs,
    timestamp: new Date().toISOString(),
  })
  if (slowQueryBuffer.length > MAX_SLOW_QUERIES) slowQueryBuffer.shift()
}

// ── Resolver error tracking ───────────────────────────────────────────────────

const resolverErrors = new Map<string, { count: number; lastError: string }>()

export function recordResolverError(resolverName: string, error: string): void {
  const existing = resolverErrors.get(resolverName)
  if (existing) {
    existing.count += 1
    existing.lastError = error
  } else {
    resolverErrors.set(resolverName, { count: 1, lastError: error })
  }
}

// ── Rolling requests-per-minute window ───────────────────────────────────────

const rpmWindow: number[] = []  // timestamps in ms
const RPM_WINDOW_MS = 60_000

function recordRequest(): void {
  const now = Date.now()
  rpmWindow.push(now)
  // prune stale entries
  const cutoff = now - RPM_WINDOW_MS
  while (rpmWindow.length > 0 && rpmWindow[0]! < cutoff) rpmWindow.shift()
}

// ── Structured getters (read the internal maps, never the text exposition) ───

export function getRequestMetrics(): RequestMetricsData {
  let totalRequests = 0
  let errorRequests = 0
  const statusCodeMap = new Map<string, number>()

  for (const { labels, value } of httpRequestsTotal.snapshot()) {
    const code = labels['status_code'] ?? 'unknown'
    totalRequests += value
    statusCodeMap.set(code, (statusCodeMap.get(code) ?? 0) + value)
    if (code.startsWith('5')) errorRequests += value
  }

  // Response time from histogram (all label sets merged)
  const buckets = httpRequestDurationSeconds.buckets
  const merged = new Array<number>(buckets.length + 1).fill(0)
  let histSum   = 0
  let histCount = 0
  for (const s of httpRequestDurationSeconds.snapshot()) {
    histSum   += s.sum
    histCount += s.count
    s.bucketCounts.forEach((c, i) => { merged[i]! += c })
  }

  const averageResponseMs = histCount > 0 ? (histSum / histCount) * 1000 : 0

  // p95 estimate: first bucket whose cumulative count reaches 95% of the observations
  let p95ResponseMs = 0
  if (histCount > 0) {
    const p95Target = histCount * 0.95
    const idx = merged.findIndex((c, i) => i < buckets.length && c >= p95Target)
    p95ResponseMs = (idx >= 0 ? buckets[idx]! : buckets[buckets.length - 1]!) * 1000
  }

  const statusCodes = Array.from(statusCodeMap.entries()).map(([code, count]) => ({ code, count }))

  return {
    totalRequests,
    requestsPerMinute: rpmWindow.length,
    averageResponseMs,
    p95ResponseMs,
    errorRate: totalRequests > 0 ? errorRequests / totalRequests : 0,
    statusCodes,
  }
}

export function getGraphQLMetrics(): GraphQLMetricsData {
  const resolverList: ResolverMetricData[] = graphqlResolverDurationSeconds.snapshot().map(s => ({
    name:      s.labels['resolver'] ?? 'unknown',
    averageMs: s.count > 0 ? (s.sum / s.count) * 1000 : 0,
    maxMs:     s.max * 1000,
    count:     s.count,
  }))

  resolverList.sort((a, b) => b.averageMs - a.averageMs)

  const totalOperations = resolverList.reduce((acc, r) => acc + r.count, 0)

  const errorsByResolver: ResolverErrorData[] = Array.from(resolverErrors.entries()).map(([name, e]) => ({
    name,
    count:     e.count,
    lastError: e.lastError,
  }))

  return {
    totalOperations,
    slowestResolvers: resolverList.slice(0, 10),
    errorsByResolver,
  }
}

export function getNeo4jMetrics(): Neo4jMetricsData {
  let totalSum   = 0
  let totalCount = 0
  for (const s of neo4jQueryDurationSeconds.snapshot()) {
    totalSum   += s.sum
    totalCount += s.count
  }

  return {
    totalQueries:        totalCount,
    averageQueryMs:      totalCount > 0 ? (totalSum / totalCount) * 1000 : 0,
    slowQueries:         [...slowQueryBuffer],
    connectionPoolActive: 0,
    connectionPoolIdle:   0,
  }
}

let lastCpuUsage = process.cpuUsage()
let lastCpuTime  = Date.now()

export function getProcessMetrics(): ProcessMetricsData {
  const mem = process.memoryUsage()

  const now     = Date.now()
  const elapsed = now - lastCpuTime
  const cpu     = process.cpuUsage(lastCpuUsage)
  lastCpuUsage  = process.cpuUsage()
  lastCpuTime   = now

  const cpuPercent = elapsed > 0
    ? ((cpu.user + cpu.system) / 1000 / elapsed) * 100
    : 0

  return {
    memoryUsageMb:    mem.heapUsed   / 1024 / 1024,
    memoryRssMb:      mem.rss        / 1024 / 1024,
    cpuUsagePercent:  cpuPercent,
    nodeVersion:      process.version,
    uptimeSeconds:    Math.floor(process.uptime()),
    pid:              process.pid,
  }
}

// ── BullMQ structured data ────────────────────────────────────────────────────

export interface QueueMetricsData {
  name:      string
  waiting:   number
  active:    number
  completed: number
  failed:    number
  delayed:   number
}

// Reads the current snapshot from the gauge data (set by startBullMQMetricsCollector)
export function getQueueMetricsSnapshot(): QueueMetricsData[] {
  const queueMap = new Map<string, QueueMetricsData>()

  for (const { labels, value } of bullmqQueueDepth.snapshot()) {
    const name   = labels['queue']
    const status = labels['status']
    if (!name || !status) continue
    const entry = queueMap.get(name) ?? { name, waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 }
    if (status === 'waiting')   entry.waiting   = value
    if (status === 'active')    entry.active    = value
    if (status === 'completed') entry.completed = value
    if (status === 'failed')    entry.failed    = value
    if (status === 'delayed')   entry.delayed   = value
    queueMap.set(name, entry)
  }

  return Array.from(queueMap.values())
}

// ── Patch metricsMiddleware to record rpm window ───────────────────────────────

const _origMiddleware = metricsMiddleware

export function metricsMiddlewareWithRpm(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  recordRequest()
  _origMiddleware(req, res, next)
}

// ── BullMQ gauge collector ────────────────────────────────────────────────────

/**
 * Samples job counts of the given queues every 30s into `bullmq_queue_depth`.
 * `queues` may be a getter so queues opened after wiring are included.
 * The interval is unref'd: it never keeps the process alive at shutdown.
 */
export function startBullMQMetricsCollector(queues: Queue[] | (() => Queue[]), intervalMs = 30_000): NodeJS.Timeout {
  const metricsLogger = logger.child({ module: 'metrics' })
  const list = () => (typeof queues === 'function' ? queues() : queues)

  async function collect(): Promise<void> {
    for (const queue of list()) {
      try {
        const counts = await queue.getJobCounts('active', 'waiting', 'delayed', 'failed', 'completed', 'paused')
        const name   = queue.name
        bullmqQueueDepth.set({ queue: name, status: 'active' },    counts['active']    ?? 0)
        bullmqQueueDepth.set({ queue: name, status: 'waiting' },   counts['waiting']   ?? 0)
        bullmqQueueDepth.set({ queue: name, status: 'delayed' },   counts['delayed']   ?? 0)
        bullmqQueueDepth.set({ queue: name, status: 'failed' },    counts['failed']    ?? 0)
        bullmqQueueDepth.set({ queue: name, status: 'completed' }, counts['completed'] ?? 0)
        bullmqQueueDepth.set({ queue: name, status: 'paused' },    counts['paused']    ?? 0)
      } catch (err) {
        metricsLogger.warn({ err, queue: queue.name }, 'Failed to collect BullMQ metrics')
      }
    }
  }

  void collect()
  const timer = setInterval(() => void collect(), intervalMs)
  timer.unref()
  return timer
}
