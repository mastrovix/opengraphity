import { Queue } from 'bullmq'
import type { DomainEvent } from '@opengraphity/types'
import { getRedisOptions, registerQueue } from './connection.js'

/** One queue per consumer — fan-out by publishing to all */
const CONSUMER_QUEUES = ['notification-service', 'sla-engine', 'escalation-consumer'] as const

const JOB_OPTIONS = {
  attempts:         4,   // 1 initial + 3 retries (5s / 30s / 5min via backoffStrategy)
  backoff:          { type: 'custom' },
  removeOnComplete: true,
  removeOnFail:     100,
} as const

let _queues: Queue[] | null = null

function getQueues(): Queue[] {
  if (_queues) return _queues
  const conn = getRedisOptions()
  const queues = CONSUMER_QUEUES.map(name => new Queue(name, { connection: conn }))
  _queues = queues
  for (const q of queues) {
    // After closeConnection() a later publish must open fresh queues, not
    // reuse closed ones.
    registerQueue(q, () => { if (_queues === queues) _queues = null })
  }
  return queues
}

export async function publish<T>(event: DomainEvent<T>): Promise<void> {
  const queues = getQueues()
  await Promise.all(
    queues.map(q => q.add(event.type, event, JOB_OPTIONS))
  )
  console.log(`[publisher] Published: ${event.type} (id: ${event.id})`)
}
