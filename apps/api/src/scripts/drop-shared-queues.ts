/**
 * Drops the queues the tenants used to share, now that each tenant has its own
 * (owner's decision, 23 Sep 2026 — see lib/sharedQueues.ts).
 *
 * Without --yes-delete it only SAYS what it would remove: every tenant queue
 * base of lib/queueRegistry.ts whose shared name still has keys in Redis, with
 * its jobs, its recurring jobs and its connected workers. With --yes-delete it
 * obliterates them. The tenants' own queues (`<base>@<tenant>`) and the
 * platform's (`maintenance`, `autoanalisi`) are never touched, and neither is
 * a shared queue that some process still works.
 *
 * Run it after every process runs the tenant queues: before, the shared
 * queues are the live ones.
 *
 *   pnpm --filter @opengraphity/api queues:drop-shared                 # what would go
 *   pnpm --filter @opengraphity/api queues:drop-shared -- --yes-delete  # drop it
 */
import { closeAllQueues, getSharedRedis, openRetiredSharedQueue } from '../lib/bullmq.js'
import { TENANT_QUEUE_BASES } from '../lib/queueRegistry.js'
import { hasFlag } from './lib/scriptArgs.js'
import { runScript } from './lib/runScript.js'
import { dropSharedQueues, formatSharedQueueReport } from './lib/sharedQueues.js'

/** Whether Redis holds any key of the shared queue (BullMQ's default prefix `bull`; `bull:<base>@…` is a tenant's). */
async function sharedQueueExists(base: string): Promise<boolean> {
  const redis = getSharedRedis()
  let cursor = '0'
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `bull:${base}:*`, 'COUNT', 1000)
    if (keys.length > 0) return true
    cursor = next
  } while (cursor !== '0')
  return false
}

runScript('drop-shared-queues', async () => {
  const apply = hasFlag('--yes-delete')
  try {
    const reports = await dropSharedQueues({
      bases: TENANT_QUEUE_BASES, exists: sharedQueueExists, open: openRetiredSharedQueue, apply,
    })
    if (reports.length === 0) {
      console.log('No shared queue left in Redis: nothing to do.')
      return
    }
    for (const r of reports) console.log(formatSharedQueueReport(r))
    const stillWorked = reports.filter((r) => r.outcome === 'still-worked')
    if (!apply) console.log('\nNothing was removed. To remove them, run again with --yes-delete.')
    if (stillWorked.length > 0) {
      throw new Error(`${String(stillWorked.length)} shared queue(s) still have workers: deploy the tenant queues to every process first (api, worker, events-worker)`)
    }
  } finally {
    await closeAllQueues()
  }
})
