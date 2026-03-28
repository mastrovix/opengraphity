import { Worker, type Job } from 'bullmq'
import type { DomainEvent } from '@opengraphity/types'
import { getRedisOptions } from './connection.js'

/** Retry delays in ms: 5s, 30s, 5min — mirrors original RabbitMQ retry logic */
const RETRY_DELAYS = [5_000, 30_000, 300_000] as const

function backoffStrategy(attemptsMade: number): number {
  const idx = Math.min(attemptsMade - 1, RETRY_DELAYS.length - 1)
  return RETRY_DELAYS[idx] ?? 300_000
}

export abstract class BaseConsumer<T> {
  private worker: Worker | null = null

  constructor(protected readonly queueName: string) {}

  abstract process(event: DomainEvent<T>): Promise<void>

  async start(): Promise<void> {
    this.worker = new Worker(
      this.queueName,
      async (job: Job) => {
        const event = job.data as DomainEvent<T>
        console.log(`[consumer:${this.queueName}] Received: ${event.type} (id: ${event.id})`)
        await this.process(event)
        console.log(`[consumer:${this.queueName}] Processed successfully: ${event.id}`)
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
  }
}
