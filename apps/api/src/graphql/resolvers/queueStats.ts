import { Queue } from 'bullmq'
import { getRedisOptions } from '@opengraphity/events'
import type { GraphQLContext } from '../../context.js'
import { GraphQLError } from 'graphql'

const QUEUE_NAMES = [
  'notification-service',
  'sla-engine',
  'report-scheduler',
  'anomaly-scanner',
  'workflow-jobs',
  'sla-jobs',
]

const redisConn = getRedisOptions()

export const queueStatsResolvers = {
  Query: {
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
}
