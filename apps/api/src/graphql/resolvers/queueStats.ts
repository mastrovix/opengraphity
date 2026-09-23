/**
 * Pagina Code dell'amministrazione di un tenant: conteggi, job per stato, rigioco.
 *
 * Le code vengono dal registro unico `lib/queueRegistry.ts` (revisione 2 ·
 * D2.2): ogni `QueueStat` porta `group` e `retryable` così l'interfaccia
 * raggruppa e mostra il pulsante senza conoscere i nomi.
 *
 * LE CODE DEL TENANT, E BASTA (23 set 2026). Ogni coda che contiene il lavoro
 * di un tenant è sua: `<nome>@<tenant>` (packages/events/src/tenantQueues.ts).
 * La pagina mostra quelle del tenant di chi chiama, con i SUOI conteggi, e
 * rigioca solo i suoi job. Prima le code erano condivise: un amministratore
 * leggeva e rigiocava i job di tutti i tenant (revisione del 23 set 2026,
 * ondata 1). Le code della piattaforma (backup, Autoanalisi) non sono di
 * nessun tenant: si guardano dalla console di piattaforma.
 */
import type { JobType } from 'bullmq'
import type { GraphQLContext } from '../../context.js'
import { GraphQLError } from 'graphql'
import { lookupOrError } from '../../lib/lookupOrError.js'
import { getTenantQueue } from '../../lib/bullmq.js'
import { QUEUE_REGISTRY, isTenantQueueBase, queueEntry } from '../../lib/queueRegistry.js'
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

/** The queues a tenant has: every base of the registry whose scope is the tenant. */
const TENANT_ENTRIES = QUEUE_REGISTRY.filter((e) => e.scope === 'tenant')

function requireSystemPermission(ctx: GraphQLContext): void {
  requirePermission(ctx, 'admin.system')
}

/** A queue of the caller's tenant; a platform queue, or a name that is no queue, is not one. */
function requireTenantQueue(queueName: string): void {
  if (!isTenantQueueBase(queueName)) {
    throw new GraphQLError(`Unknown queue: ${queueName}`, { extensions: { code: 'BAD_USER_INPUT' } })
  }
}

export const queueStatsResolvers = {
  Query: {
    queueJobs: async (_: unknown, args: { queueName: string; status?: string; limit?: number }, ctx: GraphQLContext) => {
      requireSystemPermission(ctx)
      const { queueName, status = 'failed', limit = 50 } = args
      requireTenantQueue(queueName)
      const types = lookupOrError(STATUS_TYPES, status, 'STATUS_TYPES')
      const rawJobs = await getTenantQueue(queueName, ctx.tenantId).getJobs(types, 0, limit - 1)
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
      requireSystemPermission(ctx)
      return Promise.all(
        TENANT_ENTRIES.map(async (entry) => {
          const coda = getTenantQueue(entry.name, ctx.tenantId)
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
      requireTenantQueue(queueName)
      const entry = queueEntry(queueName)
      if (!entry.retryable) {
        throw new GraphQLError(
          `Queue ${queueName} is a domain-event consumer queue: its jobs cannot be retried from the console (re-publish from the originating action instead)`,
          { extensions: { code: 'BAD_USER_INPUT' } },
        )
      }
      const job = await getTenantQueue(queueName, ctx.tenantId).getJob(jobId)
      if (!job) throw new GraphQLError(`Job ${jobId} not found in queue ${queueName}`, { extensions: { code: 'NOT_FOUND' } })
      await job.retry()
      return true
    },
  },
}
