import { Worker, type Job } from 'bullmq'
import { Redis } from 'ioredis'
import type { DomainEvent } from '@opengraphity/types'
import { getRedisOptions } from './connection.js'

/** Days to remember a processed event id for idempotency. */
const PROCESSED_TTL_SECONDS = 24 * 60 * 60

/** Retry delays in ms: 5s, 30s, 5min — mirrors original RabbitMQ retry logic */
const RETRY_DELAYS = [5_000, 30_000, 300_000] as const

function backoffStrategy(attemptsMade: number): number {
  const idx = Math.min(attemptsMade - 1, RETRY_DELAYS.length - 1)
  return RETRY_DELAYS[idx] ?? 300_000
}

export abstract class BaseConsumer<T> {
  private worker: Worker | null = null
  private redis: Redis | null = null

  constructor(protected readonly queueName: string) {}

  abstract process(event: DomainEvent<T>): Promise<void>

  async start(): Promise<void> {
    this.redis = new Redis(getRedisOptions())
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
        connection: getRedisOptions(),
        concurrency: 10,
        settings: { backoffStrategy },
      },
    )

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      console.error(
        `[consumer:${this.queueName}] Job failed: ${job?.name ?? '?'} — ${err.message}`,
      )
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
