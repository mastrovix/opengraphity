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

const STATUS_TYPES: Record<string, JobType[]> = {
  waiting:   ['waiting'],
  active:    ['active'],
  completed: ['completed'],
  failed:    ['failed'],
  delayed:   ['delayed'],
  paused:    ['paused'],
}

function requireAdmin(ctx: GraphQLContext): void {
  if (ctx.role !== 'admin') {
    throw new GraphQLError('Forbidden — admin role required', { extensions: { code: 'FORBIDDEN' } })
  }
}

function requireRegistered(queueName: string): void {
  if (!isRegisteredQueue(queueName)) {
    throw new GraphQLError(`Unknown queue: ${queueName}`, { extensions: { code: 'BAD_USER_INPUT' } })
  }
}

export const queueStatsResolvers = {
  Query: {
    queueJobs: async (_: unknown, args: { queueName: string; status?: string; limit?: number }, ctx: GraphQLContext) => {
      requireAdmin(ctx)
      const { queueName, status = 'failed', limit = 50 } = args
      requireRegistered(queueName)
      const types = lookupOrError(STATUS_TYPES, status, 'STATUS_TYPES')
      const queue = getQueue(queueName)
      const rawJobs = await queue.getJobs(types, 0, limit - 1)
      // BullMQ returns undefined for job IDs whose hash data is gone from Redis
      // (e.g. auto-cleaned completed/failed jobs whose IDs still linger in sorted sets).
      // Filter them out so the resolver never crashes on undefined.id.
      const jobs = rawJobs.filter((j): j is NonNullable<typeof j> => j != null)
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
      requireAdmin(ctx)
      return Promise.all(
        QUEUE_REGISTRY.map(async (entry) => {
          const counts = await getQueue(entry.name).getJobCounts(
            'waiting', 'active', 'completed', 'failed', 'delayed', 'paused',
          )
          return {
            name:      entry.name,
            group:     entry.group,
            retryable: entry.retryable,
            counts: {
              waiting:   counts['waiting']   ?? 0,
              active:    counts['active']    ?? 0,
              completed: counts['completed'] ?? 0,
              failed:    counts['failed']    ?? 0,
              delayed:   counts['delayed']   ?? 0,
              paused:    counts['paused']    ?? 0,
            },
          }
        }),
      )
    },
  },
  Mutation: {
    retryQueueJob: async (_: unknown, args: { queueName: string; jobId: string }, ctx: GraphQLContext) => {
      requireAdmin(ctx)
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
      if (!job) throw new GraphQLError(`Job ${jobId} not found in queue ${queueName}`, { extensions: { code: 'NOT_FOUND' } })
      await job.retry()
      return true
    },
  },
}
