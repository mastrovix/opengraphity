import { Channel } from 'amqplib'
import type { DomainEvent } from '@opengraphity/types'
import { getConnection } from './connection.js'

const EXCHANGE_MAP: Record<string, string> = {
  incident: 'opengraphity.incidents',
  problem:  'opengraphity.problems',
  change:   'opengraphity.changes',
  request:  'opengraphity.requests',
  workflow: 'opengraphity.workflows',
  sla:      'opengraphity.sla',
  ci:       'opengraphity.cmdb',
}

function resolveExchange(eventType: string): string {
  const prefix = eventType.split('.')[0] ?? ''
  const exchange = EXCHANGE_MAP[prefix]
  if (!exchange) {
    throw new Error(
      `[publisher] No exchange mapped for event type "${eventType}". ` +
        `Known prefixes: ${Object.keys(EXCHANGE_MAP).join(', ')}`,
    )
  }
  return exchange
}

let _channel: Channel | null = null

async function getChannel(): Promise<Channel> {
  if (_channel) return _channel

  const conn = await getConnection()
  const channel = await conn.createChannel()

  channel.on('error', (err: Error) => {
    console.error('[publisher] Channel error:', err.message)
    _channel = null
  })

  channel.on('close', () => {
    console.warn('[publisher] Channel closed')
    _channel = null
  })

  _channel = channel
  return channel
}

export async function publish<T>(event: DomainEvent<T>): Promise<void> {
  const exchange = resolveExchange(event.type)
  const routingKey = event.type
  const channel = await getChannel()

  const content = Buffer.from(JSON.stringify(event))

  const ok = channel.publish(exchange, routingKey, content, {
    persistent: true,
    contentType: 'application/json',
    headers: {
      'x-tenant-id':      event.tenant_id,
      'x-correlation-id': event.correlation_id,
      'x-timestamp':      event.timestamp,
    },
  })

  if (!ok) {
    console.warn(
      `[publisher] Channel write buffer full for event ${event.id} — message may be delayed`,
    )
  }

  console.log(
    `[publisher] Published: ${event.type} (id: ${event.id}) → ${exchange} / ${routingKey}`,
  )
}
