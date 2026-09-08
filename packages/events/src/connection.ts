import type { Queue } from 'bullmq'

// Redis connection options live in ./redis.ts (getRedisConnection) — the one
// parser shared by every package and by apps/api.

// ── Queue registry ────────────────────────────────────────────────────────────
// Every Queue this package opens (publisher fan-out queues) registers here so
// that closeConnection() can actually release the Redis connections on
// shutdown instead of leaving them to process.exit (D-24).

interface QueueEntry { queue: Queue; onClosed?: () => void }

const openQueues = new Map<Queue, QueueEntry>()

/**
 * Registers a Queue for closing at shutdown. `onClosed` lets the owner drop
 * its cached reference so a later use re-opens a fresh queue.
 */
export function registerQueue(queue: Queue, onClosed?: () => void): void {
  openQueues.set(queue, { queue, onClosed })
}

/** Number of queues currently open through this package (diagnostics/tests). */
export function openQueueCount(): number {
  return openQueues.size
}

/**
 * Closes every Queue opened by this package. Consumers (Workers) are closed by
 * their owners via BaseConsumer.stop(). Safe to call more than once; a queue
 * that fails to close makes this reject — the shutdown sequence must see it.
 */
export async function closeConnection(): Promise<void> {
  const entries = [...openQueues.values()]
  openQueues.clear()
  await Promise.all(entries.map(async (e) => {
    await e.queue.close()
    e.onClosed?.()
  }))
  if (entries.length > 0) console.log(`[events] Closed ${entries.length} queue(s)`)
}
