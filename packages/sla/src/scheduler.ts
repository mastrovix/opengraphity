import { randomUUID } from 'crypto'
import { Queue, Worker, Job } from 'bullmq'
import { publish } from '@opengraphity/events'
import type { DomainEvent, SLAWarningPayload, SLABreachedPayload } from '@opengraphity/types'
import { markBreached } from './status.js'
import type { SLAStatus } from './status.js'

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
        removeOnFail:     false,
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
}

// ── Worker processor ──────────────────────────────────────────────────────────

async function processJob(job: Job<SLAJobData>): Promise<void> {
  const { entityId, entityType, tenantId, resolveDeadline } = job.data

  const baseEvent = {
    tenant_id:      tenantId,
    correlation_id: randomUUID(),
    actor_id:       'sla-engine',
    timestamp:      new Date().toISOString(),
  }

  switch (job.name) {
    case 'sla.warning': {
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
      const event: DomainEvent<SLABreachedPayload> = {
        ...baseEvent,
        id:      randomUUID(),
        type:    'sla.breached',
        payload: { entity_id: entityId, entity_type: entityType, breached_at: new Date().toISOString() },
      }
      await publish(event)
      await markBreached(tenantId, entityId)
      console.log(`[sla:scheduler] Breach fired for ${entityType} ${entityId}`)
      break
    }

    case 'sla.response_breach': {
      const event: DomainEvent<SLAWarningPayload> = {
        ...baseEvent,
        id:      randomUUID(),
        type:    'sla.warning',
        payload: { entity_id: entityId, entity_type: entityType, minutes_remaining: 0 },
      }
      await publish(event)
      console.log(`[sla:scheduler] Response breach fired for ${entityType} ${entityId}`)
      break
    }

    default:
      console.warn(`[sla:scheduler] Unknown job type: ${job.name}`)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Starts the BullMQ worker that processes SLA jobs. */
export function initScheduler(): void {
  if (_worker) return

  _worker = new Worker(QUEUE_NAME, processJob, { connection: REDIS_OPTIONS })

  _worker.on('completed', (job) => {
    console.log(`[sla:scheduler] Job completed: ${job.name} (id: ${job.id})`)
  })

  _worker.on('failed', (job, err) => {
    console.error(`[sla:scheduler] Job failed: ${job?.name} (id: ${job?.id}) — ${err.message}`)
  })

  console.log('[sla:scheduler] Worker started')
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
  await scheduleJob('sla.warning', `warning-${status.entity_id}`, {
    entityId:       status.entity_id,
    entityType:     status.entity_type,
    tenantId:       status.tenant_id,
    resolveDeadline: status.resolve_deadline,
  }, warningMs)
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

export async function cancelSLAJobs(entityId: string): Promise<void> {
  const queue = getQueue()

  for (const jobId of [
    `warning-${entityId}`,
    `breach-${entityId}`,
    `response-${entityId}`,
  ]) {
    const job = await queue.getJob(jobId)
    if (job) {
      await job.remove()
      console.log(`[sla:scheduler] Cancelled job ${jobId}`)
    }
  }
}
