/**
 * Pagina Code dell'amministrazione: conteggi, job per stato, rigioco.
 *
 * Le code vengono dal registro unico `lib/queueRegistry.ts` (revisione 2 ·
 * D2.2): prima una lista a mano di sei nomi lasciava fuori tutte le code
 * dell'Event Management e dei Servizi monitorati — un job di ingest fallito
 * dopo l'ultimo tentativo non era né visibile né rigiocabile — e il rigioco
 * era offerto anche dove non ha senso. Ogni `QueueStat` porta `group` e
 * `retryable` così l'interfaccia raggruppa e mostra il pulsante senza
 * conoscere i nomi. Gli oggetti Queue sono i singleton di lib/bullmq.ts
 * (una connessione per coda per processo), non più uno nuovo per chiamata.
 */
import type { JobType } from 'bullmq'
import type { GraphQLContext } from '../../context.js'
import { GraphQLError } from 'graphql'
import { lookupOrError } from '../../lib/lookupOrError.js'
import { getQueue } from '../../lib/bullmq.js'
import { QUEUE_REGISTRY, isRegisteredQueue, queueEntry } from '../../lib/queueRegistry.js'
import { requirePermission } from '../../lib/permissions.js'

const STATUS_TYPES: Record<string, JobType[]> = {
  waiting:   ['waiting'],
  active:    ['active'],
  completed: ['completed'],
  failed:    ['failed'],
  delayed:   ['delayed'],
  /*
   * «paused» NON c'e' piu' (21 set 2026, BullMQ 6).
   *
   * Non e' un rinomino: e' il modello che e' cambiato. Prima «in pausa» era
   * uno STATO del job e si contava; ora una coda e' in pausa o non lo e', e i
   * suoi job restano `waiting` in entrambi i casi. Un conteggio «paused»
   * oggi sarebbe sempre zero — cioe' una bugia tranquilla a schermo.
   *
   * Al suo posto `paused` e' un booleano SULLA CODA (`queue.isPaused()`), che
   * e' l'informazione vera: non «quanti», ma «se».
   */
}

/**
 * THE QUEUES ARE THE PLATFORM'S, THE JOBS ARE A TENANT'S (review of 23 Sep 2026).
 *
 * Every tenant runs on the same BullMQ queues, and every tenant's admin holds
 * `admin.system`. The page listed and retried the jobs of all tenants: webhook
 * bodies with ticket data, alarm payloads. A tenant admin now sees and retries
 * only the jobs whose data names their tenant; a job that names none is a
 * platform job and belongs to the platform console. The counts stay the
 * queue's: they say how busy it is, not what it holds.
 */
function jobTenant(data: unknown): string | null {
  if (data === null || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  for (const key of ['tenantId', 'tenant_id']) if (typeof d[key] === 'string') return d[key] as string
  for (const inner of Object.values(d)) {
    if (inner !== null && typeof inner === 'object' && !Array.isArray(inner)) {
      const t = (inner as Record<string, unknown>)['tenantId'] ?? (inner as Record<string, unknown>)['tenant_id']
      if (typeof t === 'string') return t
    }
  }
  return null
}

/** Pages read to fill one list: a busy queue of other tenants must not hide this tenant's jobs forever. */
const SCAN_PAGE = 200
const SCAN_MAX  = 5_000

function requireSystemPermission(ctx: GraphQLContext): void {
  requirePermission(ctx, 'admin.system')
}

function requireRegistered(queueName: string): void {
  if (!isRegisteredQueue(queueName)) {
    throw new GraphQLError(`Unknown queue: ${queueName}`, { extensions: { code: 'BAD_USER_INPUT' } })
  }
}

export const queueStatsResolvers = {
  Query: {
    queueJobs: async (_: unknown, args: { queueName: string; status?: string; limit?: number }, ctx: GraphQLContext) => {
      requireSystemPermission(ctx)
      const { queueName, status = 'failed', limit = 50 } = args
      requireRegistered(queueName)
      const types = lookupOrError(STATUS_TYPES, status, 'STATUS_TYPES')
      const queue = getQueue(queueName)
      type QueueJob = NonNullable<Awaited<ReturnType<typeof queue.getJobs>>[number]>
      const jobs: QueueJob[] = []
      for (let start = 0; start < SCAN_MAX && jobs.length < limit; start += SCAN_PAGE) {
        const page = await queue.getJobs(types, start, start + SCAN_PAGE - 1)
        // BullMQ returns undefined for job IDs whose hash data is gone from Redis
        // (e.g. auto-cleaned completed/failed jobs whose IDs still linger in sorted sets).
        // Filter them out so the resolver never crashes on undefined.id.
        for (const j of page) if (j != null && jobTenant(j.data) === ctx.tenantId && jobs.length < limit) jobs.push(j)
        if (page.length < SCAN_PAGE) break
      }
      return jobs.map((job) => ({
        id:           job.id ?? '',
        name:         job.name,
        queueName,
        status,
        data:         JSON.stringify(job.data ?? {}),
        timestamp:    new Date(job.timestamp).toISOString(),
        processedOn:  job.processedOn != null ? new Date(job.processedOn).toISOString() : null,
        finishedOn:   job.finishedOn  != null ? new Date(job.finishedOn).toISOString()  : null,
        failedReason: job.failedReason ?? null,
        stacktrace:   job.stacktrace ?? [],
        attemptsMade: job.attemptsMade,
        maxAttempts:  job.opts.attempts ?? 1,
        returnValue:  job.returnvalue != null ? JSON.stringify(job.returnvalue) : null,
      }))
    },

    queueStats: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      requireSystemPermission(ctx)
      return Promise.all(
        QUEUE_REGISTRY.map(async (entry) => {
          const coda = getQueue(entry.name)
          const [counts, inPausa] = await Promise.all([
            coda.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed'),
            coda.isPaused(),
          ])
          return {
            name:      entry.name,
            group:     entry.group,
            retryable: entry.retryable,
            paused:    inPausa,
            counts: {
              waiting:   counts['waiting']   ?? 0,
              active:    counts['active']    ?? 0,
              completed: counts['completed'] ?? 0,
              failed:    counts['failed']    ?? 0,
              delayed:   counts['delayed']   ?? 0,
            },
          }
        }),
      )
    },
  },
  Mutation: {
    retryQueueJob: async (_: unknown, args: { queueName: string; jobId: string }, ctx: GraphQLContext) => {
      requireSystemPermission(ctx)
      const { queueName, jobId } = args
      requireRegistered(queueName)
      const entry = queueEntry(queueName)
      if (!entry.retryable) {
        throw new GraphQLError(
          `Queue ${queueName} is a domain-event consumer queue: its jobs cannot be retried from the console (re-publish from the originating action instead)`,
          { extensions: { code: 'BAD_USER_INPUT' } },
        )
      }
      const job = await getQueue(queueName).getJob(jobId)
      // Another tenant's job, or a platform job, is not there for this tenant.
      if (!job || jobTenant(job.data) !== ctx.tenantId) throw new GraphQLError(`Job ${jobId} not found in queue ${queueName}`, { extensions: { code: 'NOT_FOUND' } })
      await job.retry()
      return true
    },
  },
}
