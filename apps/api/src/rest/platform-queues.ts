/**
 * THE QUEUES, SEEN BY WHOEVER RUNS THE PLATFORM (23 Sep 2026).
 *
 * Since the owner's decision of 23 Sep 2026 every tenant has its own queues
 * (`<base>@<tenant>`), and a tenant admin sees and retries only its own
 * (Amministrazione → Code). Two queues belong to no tenant: `maintenance`
 * (backups, purges) and `autoanalisi`. Until then every tenant admin was shown
 * them, and could retry a backup of the whole platform.
 *
 * Here, for the platform identity only:
 *  - the platform queues, with their failed jobs and the retry;
 *  - for every tenant, the totals of its queues and the ones with failed jobs:
 *    which tenant has work piling up or failing, without entering its console.
 *    A tenant's jobs are retried from its own console, by its own admin.
 *
 * REST and not GraphQL for the same reason as the rest of the console
 * (`rest/platform-tenants.ts`): the GraphQL schema is bound to a tenant, and
 * this page has none.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import type { JobType, Queue } from 'bullmq'
import { platformAuthMiddleware } from '../auth/platformAuth.js'
import { asyncHandler, restErrorHandler } from './errorHandler.js'
import { parametro } from './parametroDiRotta.js'
import { NotFoundError, ValidationError } from '../lib/errors.js'
import { getQueue, getTenantQueue } from '../lib/bullmq.js'
import { PLATFORM_QUEUE_NAMES, TENANT_QUEUE_BASES } from '../lib/queueRegistry.js'
import { tenantsWithQueues } from '../lib/tenantQueueLifecycle.js'
import { logger } from '../lib/logger.js'

const log = logger.child({ module: 'platform-queues' })

const router: ExpressRouter = Router()

router.use('/platform', platformAuthMiddleware)

const COUNTED = ['waiting', 'active', 'delayed', 'failed', 'completed'] as const
type Counts = Record<(typeof COUNTED)[number], number>
const JOB_STATUSES: readonly JobType[] = ['failed', 'waiting', 'active', 'delayed', 'completed']
/** How many jobs a page shows at most: a declared ceiling, not an endless page. */
const MAX_JOBS = 100

async function countsOf(queue: Queue): Promise<Counts> {
  const raw = await queue.getJobCounts(...COUNTED)
  return Object.fromEntries(COUNTED.map((s) => [s, raw[s] ?? 0])) as Counts
}

/** A platform queue by name, or 404: a tenant's queue is not retried from here. */
function platformQueue(req: Request): Queue {
  const name = parametro(req, 'name')
  if (!PLATFORM_QUEUE_NAMES.includes(name)) {
    throw new NotFoundError('Queue', `${name} (platform queues: ${PLATFORM_QUEUE_NAMES.join(', ')})`)
  }
  return getQueue(name)
}

router.get('/platform/queues', asyncHandler(async (_req: Request, res: Response) => {
  const platform = await Promise.all(PLATFORM_QUEUE_NAMES.map(async (name) => {
    const queue = getQueue(name)
    const [counts, paused] = await Promise.all([countsOf(queue), queue.isPaused()])
    return { name, counts, paused }
  }))
  const tenants = await Promise.all(tenantsWithQueues().map(async (t) => {
    const perBase = await Promise.all(TENANT_QUEUE_BASES.map(async (base) => ({ base, counts: await countsOf(getTenantQueue(base, t.id)) })))
    const counts = Object.fromEntries(COUNTED.map((s) => [s, perBase.reduce((n, q) => n + q.counts[s], 0)])) as Counts
    return {
      tenantId: t.id,
      // A suspended tenant's queues are paused (tenantQueueLifecycle.ts): its jobs wait, they are not lost.
      suspended: t.suspended,
      counts,
      failedQueues: perBase.filter((q) => q.counts.failed > 0).map((q) => ({ name: q.base, failed: q.counts.failed })),
    }
  }))
  res.json({ platform, tenants })
}))

router.get('/platform/queues/:name/jobs', asyncHandler(async (req: Request, res: Response) => {
  const queue = platformQueue(req)
  const status = typeof req.query['status'] === 'string' ? req.query['status'] : 'failed'
  if (!(JOB_STATUSES as readonly string[]).includes(status)) {
    throw new ValidationError(`status must be one of ${JOB_STATUSES.join(', ')}`)
  }
  const limit = Math.min(Math.max(Number(req.query['limit'] ?? 50) || 50, 1), MAX_JOBS)
  // BullMQ answers undefined for a job whose data is gone from Redis: it is skipped, not a crash.
  const jobs = (await queue.getJobs([status as JobType], 0, limit - 1)).filter((j): j is NonNullable<typeof j> => j != null)
  res.json({
    queue: queue.name,
    status,
    jobs: jobs.map((job) => ({
      id:           job.id ?? '',
      name:         job.name,
      data:         JSON.stringify(job.data ?? {}),
      timestamp:    new Date(job.timestamp).toISOString(),
      finishedOn:   job.finishedOn != null ? new Date(job.finishedOn).toISOString() : null,
      failedReason: job.failedReason ?? null,
      attemptsMade: job.attemptsMade,
      maxAttempts:  job.opts.attempts ?? 1,
    })),
  })
}))

router.post('/platform/queues/:name/jobs/:id/retry', asyncHandler(async (req: Request, res: Response) => {
  const queue = platformQueue(req)
  const id = parametro(req, 'id')
  const job = await queue.getJob(id)
  if (!job) throw new NotFoundError('Job', `${id} in queue ${queue.name}`)
  await job.retry()
  log.info({ actor: req.platformActor?.email, queue: queue.name, jobId: id, job: job.name }, 'platform queue job retried')
  res.json({ queue: queue.name, id, retried: true })
}))

router.use(restErrorHandler)

export { router as platformQueuesRouter }
