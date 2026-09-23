import { closeTenantQueues, openTenantQueues } from './tenantQueues.js'

// Redis connection options live in ./redis.ts (getRedisConnection) — the one
// parser shared by every package and by apps/api.
//
// Every queue this package opens is a tenant queue (tenantQueues.ts, 23 Sep
// 2026): the fan-out of the domain events writes to `<consumer>@<tenant>`.
// closeConnection() releases them and their shared Redis connection on
// shutdown, instead of leaving them to process.exit (D-24).

/** Number of producer queues currently open through this package (diagnostics/tests). */
export function openQueueCount(): number {
  return openTenantQueues().length
}

/**
 * Closes every producer queue opened by this package and their connection.
 * Consumers (Workers) are closed by their owners via BaseConsumer.stop().
 * Safe to call more than once; a queue that fails to close makes this reject
 * — the shutdown sequence must see it.
 */
export async function closeConnection(): Promise<void> {
  const count = openTenantQueues().length
  await closeTenantQueues()
  if (count > 0) console.log(`[events] Closed ${count} queue(s)`)
}
