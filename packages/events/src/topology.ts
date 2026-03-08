import { getConnection } from './connection.js'

const DLX = 'opengraphity.dlx'
const DLQ = 'opengraphity.dlq'

const TOPIC_EXCHANGES = [
  'opengraphity.incidents',
  'opengraphity.problems',
  'opengraphity.changes',
  'opengraphity.requests',
  'opengraphity.workflows',
  'opengraphity.sla',
  'opengraphity.cmdb',
] as const

const DEFAULT_QUEUE_ARGS = {
  'x-dead-letter-exchange': DLX,
}

interface QueueConfig {
  name: string
  bindings: Array<{ exchange: string; routingKey: string }>
}

const QUEUES: QueueConfig[] = [
  {
    name: 'sla-engine',
    bindings: [
      { exchange: 'opengraphity.incidents', routingKey: 'incident.created' },
      { exchange: 'opengraphity.changes',   routingKey: 'change.created' },
      { exchange: 'opengraphity.requests',  routingKey: 'request.created' },
    ],
  },
  {
    name: 'notification-service',
    bindings: [
      { exchange: 'opengraphity.incidents', routingKey: '#' },
      { exchange: 'opengraphity.problems',  routingKey: '#' },
      { exchange: 'opengraphity.changes',   routingKey: '#' },
      { exchange: 'opengraphity.requests',  routingKey: '#' },
      { exchange: 'opengraphity.workflows', routingKey: '#' },
      { exchange: 'opengraphity.sla',       routingKey: '#' },
      { exchange: 'opengraphity.cmdb',      routingKey: '#' },
    ],
  },
  {
    name: 'webhook-dispatcher',
    bindings: [
      { exchange: 'opengraphity.incidents', routingKey: '#' },
      { exchange: 'opengraphity.problems',  routingKey: '#' },
      { exchange: 'opengraphity.changes',   routingKey: '#' },
      { exchange: 'opengraphity.requests',  routingKey: '#' },
      { exchange: 'opengraphity.workflows', routingKey: '#' },
      { exchange: 'opengraphity.sla',       routingKey: '#' },
      { exchange: 'opengraphity.cmdb',      routingKey: '#' },
    ],
  },
  {
    name: 'teams-integration',
    bindings: [
      { exchange: 'opengraphity.incidents', routingKey: 'incident.created' },
      { exchange: 'opengraphity.changes',   routingKey: 'change.approved' },
      { exchange: 'opengraphity.problems',  routingKey: 'problem.known_error' },
      { exchange: 'opengraphity.sla',       routingKey: '#' },
    ],
  },
  {
    name: 'audit-log',
    bindings: [
      { exchange: 'opengraphity.cmdb',     routingKey: '#' },
      { exchange: 'opengraphity.changes',  routingKey: '#' },
      { exchange: 'opengraphity.problems', routingKey: '#' },
    ],
  },
]

export async function setupTopology(): Promise<void> {
  const conn = await getConnection()
  const channel = await conn.createChannel()

  try {
    // Dead Letter Exchange (fanout)
    await channel.assertExchange(DLX, 'fanout', { durable: true })
    console.log(`[topology] Exchange declared: ${DLX} (fanout)`)

    // Dead Letter Queue
    await channel.assertQueue(DLQ, { durable: true })
    await channel.bindQueue(DLQ, DLX, '')
    console.log(`[topology] Queue declared and bound: ${DLQ} → ${DLX}`)

    // Topic exchanges
    for (const exchange of TOPIC_EXCHANGES) {
      await channel.assertExchange(exchange, 'topic', { durable: true })
      console.log(`[topology] Exchange declared: ${exchange} (topic)`)
    }

    // Consumer queues with bindings
    for (const queueConfig of QUEUES) {
      await channel.assertQueue(queueConfig.name, {
        durable: true,
        arguments: DEFAULT_QUEUE_ARGS,
      })
      console.log(`[topology] Queue declared: ${queueConfig.name}`)

      for (const { exchange, routingKey } of queueConfig.bindings) {
        await channel.bindQueue(queueConfig.name, exchange, routingKey)
        console.log(`[topology]   Binding: ${queueConfig.name} ← ${exchange} / ${routingKey}`)
      }
    }

    console.log('[topology] Setup complete')
  } finally {
    await channel.close()
  }
}
