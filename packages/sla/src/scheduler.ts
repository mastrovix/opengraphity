import { randomUUID } from 'crypto'
import type { Job } from 'bullmq'
import { publish, tenantQueue, TenantWorkerPool } from '@opengraphity/events'
import type { DomainEvent, SLAWarningPayload, SLABreachedPayload } from '@opengraphity/types'
import { markBreached, markResponseBreachNotified, markWarningSent, getSLAStatus, ticketReference } from './status.js'
import type { SLAStatus } from './status.js'

/**
 * The SLA timers of a tenant live in that tenant's queue (`sla-jobs@<tenant>`,
 * 23 Sep 2026): the queues and the Redis connection come from
 * @opengraphity/events, the one place that knows how a tenant queue is named
 * and opened (D-14: same REDIS_URL / REDIS_PASSWORD rules as every consumer).
 */
export const SLA_JOBS_QUEUE = 'sla-jobs'

/**
 * On every timer, not as queue defaults: a tenant queue can be opened first by
 * anyone (the console, the metrics), and defaults set by whoever opened it
 * would silently be someone else's. Keep the last N failed jobs for
 * diagnosis; `false` would let them accumulate in Redis forever (D-10).
 */
const SLA_JOB_OPTIONS = { removeOnComplete: true, removeOnFail: 200 } as const

let _pool: TenantWorkerPool<SLAJobData> | null = null

// ── Job data type ─────────────────────────────────────────────────────────────

export interface SLAJobData {
  entityId:       string
  entityType:     string
  tenantId:       string
  resolveDeadline: string
  // Present only on 'ola.breach' jobs.
  contractId?:    string
  contractName?:  string
  contractType?:  string
}

// ── Worker processor ──────────────────────────────────────────────────────────

/**
 * Re-reads the SLAStatus at fire time and tells whether the timer is still
 * relevant. Timers are cancelled on met/resolve/pause, but a cancel can race a
 * fire or fail: this is the defense in depth (D-01) — a met target never
 * produces a breach/warning event. Returns null (with a log) when the job must
 * be skipped, otherwise the current status.
 */
async function statusIfStillRelevant(
  name: string,
  data: SLAJobData,
  target: 'response' | 'resolve',
): Promise<SLAStatus | null> {
  const { tenantId, entityId, entityType } = data
  const status = await getSLAStatus(tenantId, entityId)
  const label = `${name} for ${entityType} ${entityId}`
  if (!status) {
    console.log(`[sla:scheduler] ${label} skipped: no SLAStatus (entity deleted or SLA replaced)`)
    return null
  }
  if (target === 'response' && status.response_met) {
    console.log(`[sla:scheduler] ${label} skipped: already met (response)`)
    return null
  }
  if (status.resolve_met || status.resolved_at) {
    console.log(`[sla:scheduler] ${label} skipped: already met (resolve)`)
    return null
  }
  if (status.paused_at) {
    console.log(`[sla:scheduler] ${label} skipped: SLA paused since ${status.paused_at}`)
    return null
  }
  return status
}

/** Exported for unit tests; the BullMQ worker calls it for every sla-jobs job. */
export async function processSLAJob(job: Job<SLAJobData>): Promise<void> {
  await fireSLATimer(job.name, job.data)
}

/**
 * What a timer does when it fires, whoever fires it: its delayed job, or the
 * SLA sweep when Redis lost the job (review of 23 Sep 2026). Every branch
 * re-reads the status first, and the events carry deterministic ids, so a
 * timer fired twice (job and sweep) is dropped the second time.
 */
export async function fireSLATimer(name: string, data: SLAJobData): Promise<void> {
  const { entityId, entityType, tenantId, resolveDeadline } = data

  const baseEvent = {
    tenant_id:      tenantId,
    correlation_id: randomUUID(),
    actor_id:       'sla-engine',
    timestamp:      new Date().toISOString(),
  }

  switch (name) {
    case 'sla.warning': {
      const status = await statusIfStillRelevant(name, data, 'resolve')
      if (!status) break
      const ref = await ticketReference(tenantId, entityId)
      if (!ref) { console.log(`[sla:scheduler] sla.warning for ${entityType} ${entityId} skipped: ticket gone`); break }
      const minutesRemaining = Math.round(
        (new Date(resolveDeadline).getTime() - Date.now()) / 60_000,
      )
      // Id DETERMINISTICO per questo SLAStatus e questo preavviso (revisione
      // totale · E-7): con `randomUUID()` un fallimento del fan-out (una sola
      // `add` su cinque) faceva ritentare il job, che ripubblicava un evento
      // NUOVO — e i consumatori, che deduplicano per id, mandavano due volte
      // «SLA in scadenza».
      const event: DomainEvent<SLAWarningPayload> = {
        ...baseEvent,
        id:      `warning-${status.id}`,
        type:    'sla.warning',
        payload: { entity_id: entityId, entity_type: entityType, minutes_remaining: minutesRemaining, target: 'resolve', ...ref },
      }
      await publish(event)
      // For THIS deadline: the sweep does not send it again (see markWarningSent).
      await markWarningSent(tenantId, entityId, status.resolve_deadline)
      console.log(`[sla:scheduler] Warning fired for ${entityType} ${entityId} (${minutesRemaining}min remaining)`)
      break
    }

    case 'sla.breach': {
      const status = await statusIfStillRelevant(name, data, 'resolve')
      if (!status) break
      // State first, event second: if the publish fails and the job is
      // retried, the status is already consistent. The event id is
      // deterministic per SLAStatus so a retry re-publishes the SAME event and
      // the consumers' per-id dedup drops the duplicate instead of escalating
      // twice (D-10).
      await markBreached(tenantId, entityId)
      const ref = await ticketReference(tenantId, entityId)
      if (!ref) { console.log(`[sla:scheduler] sla.breach for ${entityType} ${entityId}: ticket gone, state marked, no notification`); break }
      const event: DomainEvent<SLABreachedPayload> = {
        ...baseEvent,
        id:      `breach-${status.id}`,
        type:    'sla.breached',
        payload: { entity_id: entityId, entity_type: entityType, breached_at: new Date().toISOString(), ...ref },
      }
      await publish(event)
      console.log(`[sla:scheduler] Breach fired for ${entityType} ${entityId}`)
      break
    }

    case 'sla.response_breach': {
      const status = await statusIfStillRelevant(name, data, 'response')
      if (!status) break
      const ref = await ticketReference(tenantId, entityId)
      if (!ref) { console.log(`[sla:scheduler] sla.response_breach for ${entityType} ${entityId} skipped: ticket gone`); break }
      const event: DomainEvent<SLAWarningPayload> = {
        ...baseEvent,
        id:      `response-breach-${status.id}`,
        type:    'sla.warning',
        payload: { entity_id: entityId, entity_type: entityType, minutes_remaining: 0, target: 'response', ...ref },
      }
      await publish(event)
      // L'avviso è uscito: alla ripresa di una pausa non se ne manda un
      // secondo identico (revisione totale · E-12).
      await markResponseBreachNotified(tenantId, entityId, event.timestamp)
      console.log(`[sla:scheduler] Response breach fired for ${entityType} ${entityId}`)
      break
    }

    case 'ola.breach': {
      // Job per ticket armati prima della passata OLA dell'API (secondo giro UI
      // del 15 set 2026): si scaricano senza avvisare. Gli avvisi li dà
      // `apps/api/src/lib/olaSweep.ts`, sul tempo in cui il ticket è del team.
      console.log(`[sla:scheduler] OLA job for ${entityType} ${entityId} superseded by the OLA sweep — dropped`)
      break
    }

    default:
      throw new Error(`[sla:scheduler] Unknown job type: ${name}`)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Registers the pool of SLA workers: one worker per tenant, created when the
 * host reconciles the pools with the tenants (`reconcileTenantPools`).
 */
export function initScheduler(): void {
  if (_pool) return
  _pool = new TenantWorkerPool<SLAJobData>(SLA_JOBS_QUEUE, processSLAJob)
  console.log('[sla:scheduler] Worker pool registered (one worker per tenant)')
}

/**
 * Closes the SLA workers (draining in-flight jobs). The producer queues are
 * closed with the other tenant queues (`closeConnection` of
 * @opengraphity/events). Called by the API shutdown sequence before the Neo4j
 * driver is closed (D-24). Idempotent.
 */
export async function closeScheduler(): Promise<void> {
  const pool = _pool
  _pool = null
  if (pool) {
    await pool.close()
    console.log('[sla:scheduler] Workers closed')
  }
}

async function scheduleJob(
  jobName: string,
  jobId: string,
  data: SLAJobData,
  delayMs: number,
): Promise<void> {
  if (delayMs < 0) {
    console.warn(`[sla:scheduler] Skipping ${jobName} (${jobId}) — target time already past`)
    return
  }

  const queue = tenantQueue<SLAJobData>(SLA_JOBS_QUEUE, data.tenantId)

  /**
   * Il job vecchio con lo stesso id si toglie per idempotenza, ma un job
   * ATTIVO non si può rimuovere (revisione totale · E-22): BullMQ rifiuta
   * `remove()` su un job che un worker ha in mano, quindi la ripianificazione
   * lanciava e l'evento che l'aveva chiesta (una ripresa dalla pausa, un
   * cambio di policy) finiva nei falliti. Se il job sta girando non c'è
   * niente da togliere: sta già facendo il suo, e quello nuovo lo si accoda
   * con un id distinto per non perderlo.
   */
  const existing = await queue.getJob(jobId)
  let scheduledId = jobId
  if (existing) {
    try {
      await existing.remove()
    } catch (err) {
      const state = await existing.getState().catch(() => 'unknown')
      if (state !== 'active') throw err
      scheduledId = `${jobId}:re${String(Date.now())}`
      console.warn(`[sla:scheduler] ${jobName} (${jobId}) is running: the new one is queued as ${scheduledId}`)
    }
  }

  await queue.add(jobName, data, { ...SLA_JOB_OPTIONS, jobId: scheduledId, delay: delayMs })
  console.log(`[sla:scheduler] Scheduled ${jobName} (${scheduledId}) in ${Math.round(delayMs / 1000)}s`)
}

export async function scheduleWarning(status: SLAStatus): Promise<void> {
  // Il preavviso è della policy (NT-8/F6): era 30 minuti fissi per tutti.
  const lead = Number(status.tier.warning_minutes)
  if (!Number.isInteger(lead) || lead <= 0) {
    throw new Error(`[sla:scheduler] SLAStatus ${status.id} has no valid warning lead (tier_warning_minutes=${String(status.tier.warning_minutes)})`)
  }
  const warningMs = new Date(status.resolve_deadline).getTime() - lead * 60_000 - Date.now()
  // Clamp like breach/response checks: an SLA shorter than the warning lead
  // fires the warning immediately instead of silently never.
  await scheduleJob('sla.warning', `warning-${status.entity_id}`, {
    entityId:       status.entity_id,
    entityType:     status.entity_type,
    tenantId:       status.tenant_id,
    resolveDeadline: status.resolve_deadline,
  }, Math.max(warningMs, 0))
}

export async function scheduleBreachCheck(status: SLAStatus): Promise<void> {
  const delayMs = new Date(status.resolve_deadline).getTime() - Date.now()
  await scheduleJob('sla.breach', `breach-${status.entity_id}`, {
    entityId:        status.entity_id,
    entityType:      status.entity_type,
    tenantId:        status.tenant_id,
    resolveDeadline: status.resolve_deadline,
  }, Math.max(delayMs, 0))
}

export async function scheduleResponseCheck(status: SLAStatus): Promise<void> {
  const delayMs = new Date(status.response_deadline).getTime() - Date.now()
  await scheduleJob('sla.response_breach', `response-${status.entity_id}`, {
    entityId:        status.entity_id,
    entityType:      status.entity_type,
    tenantId:        status.tenant_id,
    resolveDeadline: status.resolve_deadline,
  }, Math.max(delayMs, 0))
}

/**
 * Rimuove i timer di breach OLA/UC di un'entità (es. change eliminata): gli
 * id erano quelli dei vecchi controlli per ticket (`ola-<contractId>-<entityId>`):
 * sostituiti dalla passata OLA dell'API, restano da togliere quelli già in coda.
 */
export async function cancelOLABreaches(tenantId: string, entityId: string, contractIds: string[]): Promise<void> {
  const queue = tenantQueue(SLA_JOBS_QUEUE, tenantId)
  for (const contractId of contractIds) {
    const jobId = `ola-${contractId}-${entityId}`
    const job = await queue.getJob(jobId)
    if (job) await job.remove()
  }
}

/**
 * Cancels the SLA timers for an entity. `which` selects the target: 'resolve'
 * cancels the warning + breach timers (both keyed to the resolve deadline),
 * 'response' cancels the response timer, 'both' cancels all three. Used both
 * on resolution ('both') and on a per-type pause. The timers are in the
 * tenant's own queue: the tenant is part of where they are.
 */
export async function cancelSLAJobs(tenantId: string, entityId: string, which: 'resolve' | 'response' | 'both' = 'both'): Promise<void> {
  const queue = tenantQueue(SLA_JOBS_QUEUE, tenantId)

  const ids: string[] = []
  if (which === 'resolve' || which === 'both') ids.push(`warning-${entityId}`, `breach-${entityId}`)
  if (which === 'response' || which === 'both') ids.push(`response-${entityId}`)

  for (const jobId of ids) {
    const job = await queue.getJob(jobId)
    if (job) {
      await job.remove()
      console.log(`[sla:scheduler] Cancelled job ${jobId}`)
    }
  }
}
