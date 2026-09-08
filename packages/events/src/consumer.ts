import { Worker, type Job } from 'bullmq'
import { Redis } from 'ioredis'
import type { DomainEvent } from '@opengraphity/types'
import { getRedisConnection } from './redis.js'

/** Days to remember a processed event id for idempotency. */
const PROCESSED_TTL_SECONDS = 24 * 60 * 60

/** Retry delays in ms: 5s, 30s, 5min — mirrors original RabbitMQ retry logic */
const RETRY_DELAYS = [5_000, 30_000, 300_000] as const

function backoffStrategy(attemptsMade: number): number {
  const idx = Math.min(attemptsMade - 1, RETRY_DELAYS.length - 1)
  return RETRY_DELAYS[idx] ?? 300_000
}

// ── Exhausted-event accounting (D-33) ─────────────────────────────────────────
// An event that failed its LAST attempt is lost for good (no DLQ). Besides the
// log line, expose a counter and a hook so the API can surface it as a metric
// (`events_failed_total{queue,type}`) or an alert. The metric wiring itself
// lives in apps/api, not here.

export interface FailedEventInfo {
  queue:     string
  eventType: string
  eventId:   string | undefined
  attempts:  number
  error:     Error
}

let failedEventCount = 0
const failedEventListeners = new Set<(info: FailedEventInfo) => void>()

/** Total events that exhausted all retry attempts since process start. */
export function getFailedEventCount(): number {
  return failedEventCount
}

/**
 * Registers a callback invoked every time an event exhausts its attempts.
 * Returns an unsubscribe function. A throwing listener is logged, never
 * allowed to break the worker.
 */
export function onEventFailed(cb: (info: FailedEventInfo) => void): () => void {
  failedEventListeners.add(cb)
  return () => { failedEventListeners.delete(cb) }
}

function recordExhaustedEvent(info: FailedEventInfo): void {
  failedEventCount += 1
  for (const cb of failedEventListeners) {
    try {
      cb(info)
    } catch (err) {
      console.error(`[consumer:${info.queue}] onEventFailed listener threw:`, err)
    }
  }
}

export abstract class BaseConsumer<T> {
  private worker: Worker | null = null
  private redis: Redis | null = null

  constructor(protected readonly queueName: string) {}

  abstract process(event: DomainEvent<T>): Promise<void>

  async start(): Promise<void> {
    this.redis = new Redis(getRedisConnection())
    this.worker = new Worker(
      this.queueName,
      async (job: Job) => {
        const event = job.data as DomainEvent<T>
        console.log(`[consumer:${this.queueName}] Received: ${event.type} (id: ${event.id})`)
        // Idempotency: BullMQ is at-least-once. A stalled/redelivered job whose
        // first attempt already succeeded must not fire the side effects again
        // (double notification / double SLAStatus). Mark processed only AFTER
        // success, so a genuine failure still retries.
        const dedupKey = `evt:processed:${this.queueName}:${event.id}`
        if (this.redis && (await this.redis.exists(dedupKey))) {
          console.log(`[consumer:${this.queueName}] Already processed, skipping: ${event.id}`)
          return
        }
        try {
          await this.process(event)
          if (this.redis) await this.redis.set(dedupKey, '1', 'EX', PROCESSED_TTL_SECONDS)
          console.log(`[consumer:${this.queueName}] Processed successfully: ${event.id}`)
        } catch (err) {
          console.error(`[consumer:${this.queueName}] process() threw:`, err)
          throw err
        }
      },
      {
        connection: getRedisConnection(),
        concurrency: 10,
        settings: { backoffStrategy },
      },
    )

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      const event = job?.data as DomainEvent<T> | undefined
      const attemptsMade = job?.attemptsMade ?? 0
      const maxAttempts  = job?.opts.attempts ?? 1
      const exhausted    = !job || attemptsMade >= maxAttempts
      console.error(
        `[consumer:${this.queueName}] Job failed: ${job?.name ?? '?'} ` +
          `(attempt ${attemptsMade}/${maxAttempts}${exhausted ? ', EXHAUSTED — event lost' : ''}) — ${err.message}`,
      )
      if (exhausted) {
        recordExhaustedEvent({
          queue:     this.queueName,
          eventType: event?.type ?? job?.name ?? 'unknown',
          eventId:   event?.id,
          attempts:  attemptsMade,
          error:     err,
        })
      }
    })

    console.log(`[consumer:${this.queueName}] Started — concurrency: 10`)
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.close()
      this.worker = null
      console.log(`[consumer:${this.queueName}] Stopped`)
    }
    if (this.redis) {
      this.redis.disconnect()
      this.redis = null
    }
  }
}
