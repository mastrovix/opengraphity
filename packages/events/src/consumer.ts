import { Channel, Message } from 'amqplib'
import type { DomainEvent } from '@opengraphity/types'
import { getConnection } from './connection.js'

/** Retry delays in ms: 5s, 30s, 5min */
const RETRY_DELAYS = [5_000, 30_000, 300_000] as const
const MAX_RETRIES = RETRY_DELAYS.length

export abstract class BaseConsumer<T> {
  private channel: Channel | null = null
  /** In-memory retry counter keyed by event.id */
  private readonly retryMap = new Map<string, number>()

  constructor(protected readonly queueName: string) {}

  abstract process(event: DomainEvent<T>, msg: Message): Promise<void>

  async start(): Promise<void> {
    const conn = await getConnection()
    const channel = await conn.createChannel()

    channel.on('error', (err: Error) => {
      console.error(`[consumer:${this.queueName}] Channel error:`, err.message)
    })

    channel.on('close', () => {
      console.warn(`[consumer:${this.queueName}] Channel closed`)
      this.channel = null
    })

    await channel.prefetch(10)

    await channel.consume(this.queueName, (msg) => {
      if (!msg) {
        console.warn(`[consumer:${this.queueName}] Consumer cancelled by broker`)
        return
      }
      void this.handleMessage(channel, msg)
    })

    this.channel = channel
    console.log(`[consumer:${this.queueName}] Started — prefetch: 10`)
  }

  async stop(): Promise<void> {
    if (this.channel) {
      await this.channel.close()
      this.channel = null
      console.log(`[consumer:${this.queueName}] Stopped`)
    }
  }

  private async handleMessage(channel: Channel, msg: Message): Promise<void> {
    let event: DomainEvent<T>

    try {
      event = JSON.parse(msg.content.toString()) as DomainEvent<T>
    } catch {
      console.error(
        `[consumer:${this.queueName}] Failed to parse message — sending to DLQ immediately`,
      )
      channel.nack(msg, false, false)
      return
    }

    console.log(`[consumer:${this.queueName}] Received: ${event.type} (id: ${event.id})`)

    try {
      await this.process(event, msg)
      this.retryMap.delete(event.id)
      channel.ack(msg)
      console.log(`[consumer:${this.queueName}] Processed successfully: ${event.id}`)
    } catch (err) {
      const attempt = (this.retryMap.get(event.id) ?? 0) + 1
      const errMessage = err instanceof Error ? err.message : String(err)

      if (attempt > MAX_RETRIES) {
        this.retryMap.delete(event.id)
        console.error(
          `[consumer:${this.queueName}] Max retries (${MAX_RETRIES}) exceeded for ${event.id}` +
            ` — sending to DLQ. Error: ${errMessage}`,
        )
        channel.nack(msg, false, false)
        return
      }

      const delay = RETRY_DELAYS[attempt - 1]
      this.retryMap.set(event.id, attempt)

      console.warn(
        `[consumer:${this.queueName}] Failed (attempt ${attempt}/${MAX_RETRIES}),` +
          ` retrying in ${delay}ms — event: ${event.id}. Error: ${errMessage}`,
      )

      setTimeout(() => {
        if (!this.channel) {
          console.warn(
            `[consumer:${this.queueName}] Channel gone before retry for event ${event.id}`,
          )
          return
        }
        channel.nack(msg, false, true)
      }, delay)
    }
  }
}
