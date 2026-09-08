import { randomUUID } from 'crypto'
import { Queue, Worker, Job } from 'bullmq'
import { publish } from '@opengraphity/events'
import type { DomainEvent, SLAWarningPayload, SLABreachedPayload } from '@opengraphity/types'
import { markBreached, getSLAStatus } from './status.js'
import type { SLAStatus } from './status.js'
import { calculateDeadline } from './policy.js'
import { isEntityResolved, type OLAContractLite } from './olaBreach.js'

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379'

// Pass plain connection options — avoids IORedis version conflicts with BullMQ's peer dep
function parseRedisOptions() {
  const url      = new URL(REDIS_URL)
  const port     = parseInt(url.port, 10) || 6379
  const password = url.password || undefined
  return { host: url.hostname, port, password, maxRetriesPerRequest: null as null }
}

const REDIS_OPTIONS = parseRedisOptions()

const QUEUE_NAME = 'sla-jobs'

let _queue: Queue | null = null
let _worker: Worker | null = null

function getQueue(): Queue {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, {
      connection: REDIS_OPTIONS,
      defaultJobOptions: {
        removeOnComplete: true,
        // Keep the last N failed jobs for diagnosis; `false` would let them
        // accumulate in Redis forever (D-10).
        removeOnFail:     200,
      },
    })
  }
  return _queue
}

// ── Job data type ─────────────────────────────────────────────────────────────

interface SLAJobData {
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
  job: Job<SLAJobData>,
  target: 'response' | 'resolve',
): Promise<SLAStatus | null> {
  const { tenantId, entityId, entityType } = job.data
  const status = await getSLAStatus(tenantId, entityId)
  const label = `${job.name} for ${entityType} ${entityId}`
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
  const { entityId, entityType, tenantId, resolveDeadline } = job.data

  const baseEvent = {
    tenant_id:      tenantId,
    correlation_id: randomUUID(),
    actor_id:       'sla-engine',
    timestamp:      new Date().toISOString(),
  }

  switch (job.name) {
    case 'sla.warning': {
      if (!(await statusIfStillRelevant(job, 'resolve'))) break
      const minutesRemaining = Math.round(
        (new Date(resolveDeadline).getTime() - Date.now()) / 60_000,
      )
      const event: DomainEvent<SLAWarningPayload> = {
        ...baseEvent,
        id:      randomUUID(),
        type:    'sla.warning',
        payload: { entity_id: entityId, entity_type: entityType, minutes_remaining: minutesRemaining },
      }
      await publish(event)
      console.log(`[sla:scheduler] Warning fired for ${entityType} ${entityId} (${minutesRemaining}min remaining)`)
      break
    }

    case 'sla.breach': {
      const status = await statusIfStillRelevant(job, 'resolve')
      if (!status) break
      // State first, event second: if the publish fails and the job is
      // retried, the status is already consistent. The event id is
      // deterministic per SLAStatus so a retry re-publishes the SAME event and
      // the consumers' per-id dedup drops the duplicate instead of escalating
      // twice (D-10).
      await markBreached(tenantId, entityId)
      const event: DomainEvent<SLABreachedPayload> = {
        ...baseEvent,
        id:      `breach-${status.id}`,
        type:    'sla.breached',
        payload: { entity_id: entityId, entity_type: entityType, breached_at: new Date().toISOString() },
      }
      await publish(event)
      console.log(`[sla:scheduler] Breach fired for ${entityType} ${entityId}`)
      break
    }

    case 'sla.response_breach': {
      const status = await statusIfStillRelevant(job, 'response')
      if (!status) break
      const event: DomainEvent<SLAWarningPayload> = {
        ...baseEvent,
        id:      `response-breach-${status.id}`,
        type:    'sla.warning',
        payload: { entity_id: entityId, entity_type: entityType, minutes_remaining: 0 },
      }
      await publish(event)
      console.log(`[sla:scheduler] Response breach fired for ${entityType} ${entityId}`)
      break
    }

    case 'ola.breach': {
      // OLA/UC target elapsed. Alert only if the entity is still open — a
      // resolved entity met (or already reported) its outcome; no false alarm.
      const stillOpen = !(await isEntityResolved(job.data.tenantId, entityType, entityId))
      if (!stillOpen) {
        console.log(`[sla:scheduler] OLA "${job.data.contractName}" check skipped for ${entityType} ${entityId} — already resolved`)
        break
      }
      const event: DomainEvent<Record<string, unknown>> = {
        ...baseEvent,
        id:      randomUUID(),
        type:    'ola.breached',
        payload: {
          entity_id:     entityId,
          entity_type:   entityType,
          contract_id:   job.data.contractId ?? null,
          contract_name: job.data.contractName ?? null,
          contract_type: job.data.contractType ?? null,
          breached_at:   new Date().toISOString(),
        },
      }
      await publish(event)
      console.log(`[sla:scheduler] OLA/UC breach fired: "${job.data.contractName}" on ${entityType} ${entityId}`)
      break
    }

    default:
      throw new Error(`[sla:scheduler] Unknown job type: ${job.name}`)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Starts the BullMQ worker that processes SLA jobs. */
export function initScheduler(): void {
  if (_worker) return

  _worker = new Worker(QUEUE_NAME, processSLAJob, { connection: REDIS_OPTIONS })

  _worker.on('completed', (job) => {
    console.log(`[sla:scheduler] Job completed: ${job.name} (id: ${job.id})`)
  })

  _worker.on('failed', (job, err) => {
    console.error(`[sla:scheduler] Job failed: ${job?.name} (id: ${job?.id}) — ${err.message}`)
  })

  console.log('[sla:scheduler] Worker started')
}

/**
 * Closes the sla-jobs Worker (draining in-flight jobs) and the Queue used to
 * schedule timers. Called by the API shutdown sequence before the Neo4j driver
 * is closed (D-24). Idempotent.
 */
export async function closeScheduler(): Promise<void> {
  const worker = _worker
  const queue  = _queue
  _worker = null
  _queue  = null
  if (worker) {
    await worker.close()
    console.log('[sla:scheduler] Worker closed')
  }
  if (queue) {
    await queue.close()
    console.log('[sla:scheduler] Queue closed')
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

  const queue = getQueue()

  // Remove stale job with the same ID (idempotency)
  const existing = await queue.getJob(jobId)
  if (existing) {
    await existing.remove()
  }

  await queue.add(jobName, data, { jobId, delay: delayMs })
  console.log(`[sla:scheduler] Scheduled ${jobName} (${jobId}) in ${Math.round(delayMs / 1000)}s`)
}

export async function scheduleWarning(status: SLAStatus): Promise<void> {
  const warningMs = new Date(status.resolve_deadline).getTime() - 30 * 60_000 - Date.now()
  // Clamp like breach/response checks: an SLA shorter than the 30-minute
  // warning window fires the warning immediately instead of silently never.
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
 * Cancels the SLA timers for an entity. `which` selects the target: 'resolve'
 * cancels the warning + breach timers (both keyed to the resolve deadline),
 * 'response' cancels the response timer, 'both' cancels all three. Used both
 * on resolution ('both') and on a per-type pause.
 */
/**
 * Schedules one breach-check timer per OLA/UC contract covering the entity.
 * Each fires at created_at + the contract's resolve target; the processor
 * alerts only if the entity is still open at that point. Fire-time is the
 * guard — no cancellation on resolve is needed.
 */
export async function scheduleOLABreaches(
  params: { entityId: string; entityType: string; tenantId: string; timezone: string; contracts: OLAContractLite[] },
): Promise<void> {
  const { entityId, entityType, tenantId, timezone, contracts } = params
  const now = new Date()
  for (const c of contracts) {
    const deadline = calculateDeadline(now, c.resolve_minutes, c.business_hours, timezone)
    const delayMs = deadline.getTime() - now.getTime()
    await scheduleJob('ola.breach', `ola-${c.id}-${entityId}`, {
      entityId,
      entityType,
      tenantId,
      resolveDeadline: deadline.toISOString(),
      contractId:      c.id,
      contractName:    c.name,
      contractType:    c.type,
    }, Math.max(delayMs, 0))
  }
}

/**
 * Rimuove i timer di breach OLA/UC di un'entità (es. change eliminata): gli
 * id sono quelli generati da scheduleOLABreaches (`ola-<contractId>-<entityId>`).
 */
export async function cancelOLABreaches(entityId: string, contractIds: string[]): Promise<void> {
  const queue = getQueue()
  for (const contractId of contractIds) {
    const jobId = `ola-${contractId}-${entityId}`
    const job = await queue.getJob(jobId)
    if (job) await job.remove()
  }
}

export async function cancelSLAJobs(entityId: string, which: 'resolve' | 'response' | 'both' = 'both'): Promise<void> {
  const queue = getQueue()

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
