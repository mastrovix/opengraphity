import { Queue } from 'bullmq'
import type { JobType } from 'bullmq'
import { getRedisOptions } from '@opengraphity/events'
import type { GraphQLContext } from '../../context.js'
import { GraphQLError } from 'graphql'
import { lookupOrError } from '../../lib/lookupOrError.js'

const QUEUE_NAMES = [
  'notification-service',
  'sla-engine',
  'report-scheduler',
  'anomaly-scanner',
  'workflow-jobs',
  'sla-jobs',
]

const redisConn = getRedisOptions()

const STATUS_TYPES: Record<string, JobType[]> = {
  waiting:   ['waiting'],
  active:    ['active'],
  completed: ['completed'],
  failed:    ['failed'],
  delayed:   ['delayed'],
  paused:    ['paused'],
}

export const queueStatsResolvers = {
  Query: {
    queueJobs: async (_: unknown, args: { queueName: string; status?: string; limit?: number }, ctx: GraphQLContext) => {
      if (ctx.role !== 'admin') {
        throw new GraphQLError('Forbidden — admin role required', { extensions: { code: 'FORBIDDEN' } })
      }
      const { queueName, status = 'failed', limit = 50 } = args
      if (!QUEUE_NAMES.includes(queueName)) {
        throw new GraphQLError(`Unknown queue: ${queueName}`)
      }
      const types = lookupOrError(STATUS_TYPES, status, 'STATUS_TYPES', ['failed'] as JobType[])
      const queue = new Queue(queueName, { connection: redisConn })
      try {
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
      } finally {
        await queue.close()
      }
    },

    queueStats: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      if (ctx.role !== 'admin') {
        throw new GraphQLError('Forbidden — admin role required', {
          extensions: { code: 'FORBIDDEN' },
        })
      }

      return Promise.all(
        QUEUE_NAMES.map(async (name) => {
          const queue = new Queue(name, { connection: redisConn })
          try {
            const counts = await queue.getJobCounts(
              'waiting', 'active', 'completed', 'failed', 'delayed', 'paused',
            )
            return {
              name,
              counts: {
                waiting:   counts['waiting']   ?? 0,
                active:    counts['active']    ?? 0,
                completed: counts['completed'] ?? 0,
                failed:    counts['failed']    ?? 0,
                delayed:   counts['delayed']   ?? 0,
                paused:    counts['paused']    ?? 0,
              },
            }
          } finally {
            await queue.close()
          }
        }),
      )
    },
  },
  Mutation: {
    retryQueueJob: async (_: unknown, args: { queueName: string; jobId: string }, ctx: GraphQLContext) => {
      if (ctx.role !== 'admin') {
        throw new GraphQLError('Forbidden — admin role required', { extensions: { code: 'FORBIDDEN' } })
      }
      const { queueName, jobId } = args
      if (!QUEUE_NAMES.includes(queueName)) {
        throw new GraphQLError(`Unknown queue: ${queueName}`)
      }
      const queue = new Queue(queueName, { connection: redisConn })
      try {
        const job = await queue.getJob(jobId)
        if (!job) throw new GraphQLError(`Job ${jobId} not found in queue ${queueName}`)
        await job.retry()
        return true
      } finally {
        await queue.close()
      }
    },
  },
}
