/**
 * resolvers/queueStats.ts (revisione 2 · D2.2): le code vengono dal registro
 * unico — anche `events-ingest`, `services-impact` e i quattro consumer —,
 * ogni `QueueStat` porta `group` e `retryable`, `queueJobs('events-ingest')`
 * non dice più «Unknown queue», e il rigioco è rifiutato dove non ha senso.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../lib/__tests__/testPermissions.js'
import { CONSUMER_QUEUES } from '@opengraphity/events'

const queues = new Map<string, { name: string; getJobCounts: ReturnType<typeof vi.fn>; getJobs: ReturnType<typeof vi.fn>; getJob: ReturnType<typeof vi.fn> }>()
vi.mock('../../../lib/bullmq.js', () => ({
  getQueue: vi.fn((name: string) => {
    let q = queues.get(name)
    if (!q) {
      q = {
        name,
        getJobCounts: vi.fn().mockResolvedValue({ waiting: 1, active: 0, completed: 5, failed: 2, delayed: 0 }),
        isPaused: vi.fn().mockResolvedValue(false),
        getJobs: vi.fn().mockResolvedValue([]),
        getJob: vi.fn().mockResolvedValue(null),
      }
      queues.set(name, q)
    }
    return q
  }),
}))

const { queueStatsResolvers } = await import('../queueStats.js')
const { QUEUE_REGISTRY } = await import('../../../lib/queueRegistry.js')

const admin = { role: 'admin', tenantId: 't1', permissions: perms('admin') } as never
const operator = { role: 'operator', tenantId: 't1', permissions: perms('operator') } as never

beforeEach(() => { queues.clear(); vi.clearAllMocks() })

describe('queueStats', () => {
  it('una voce per ogni coda del registro, con group e retryable dal registro e i conteggi di BullMQ', async () => {
    const stats = await queueStatsResolvers.Query.queueStats(null, {}, admin)
    expect(stats.map((s) => s.name)).toEqual(QUEUE_REGISTRY.map((e) => e.name))
    const ingest = stats.find((s) => s.name === 'events-ingest')!
    // `paused` non e' piu' un conteggio ma uno stato DELLA CODA (BullMQ 6).
    expect(ingest).toEqual({ name: 'events-ingest', group: 'events', retryable: true, paused: false, counts: { waiting: 1, active: 0, completed: 5, failed: 2, delayed: 0 } })
    for (const name of CONSUMER_QUEUES) {
      expect(stats.find((s) => s.name === name)).toMatchObject({ retryable: false })
    }
    expect(stats.find((s) => s.name === 'services-impact')).toMatchObject({ group: 'services', retryable: true })
    expect(stats.find((s) => s.name === 'workflow-jobs')).toMatchObject({ group: 'itsm' })
    expect(stats.find((s) => s.name === 'webhook-delivery')).toMatchObject({ group: 'platform' })
  })

  it('richiede il ruolo admin', async () => {
    await expect(queueStatsResolvers.Query.queueStats(null, {}, operator)).rejects.toThrow(/admin\.system/)
  })
})

describe('queueJobs', () => {
  it('events-ingest è una coda conosciuta: legge i job falliti (default) e mappa i campi; i job spariti da Redis vengono saltati', async () => {
    const jobs = await queueStatsResolvers.Query.queueJobs(null, { queueName: 'events-ingest' }, admin)
    expect(jobs).toEqual([])
    const q = queues.get('events-ingest')!
    expect(q.getJobs).toHaveBeenCalledWith(['failed'], 0, 199)

    q.getJobs.mockResolvedValueOnce([
      undefined,
      { id: 'ev-t1-fp-1', name: 'ingest', data: { tenantId: 't1' }, timestamp: 1_700_000_000_000, processedOn: 1_700_000_001_000, finishedOn: null, failedReason: 'Neo4j down', stacktrace: ['x'], attemptsMade: 5, opts: { attempts: 5 }, returnvalue: null },
    ])
    const [job] = await queueStatsResolvers.Query.queueJobs(null, { queueName: 'events-ingest', status: 'failed', limit: 10 }, admin)
    expect(job).toMatchObject({ id: 'ev-t1-fp-1', queueName: 'events-ingest', status: 'failed', failedReason: 'Neo4j down', attemptsMade: 5, maxAttempts: 5, data: '{"tenantId":"t1"}', finishedOn: null })
  })

  // Review of 23 Sep 2026: the queues are shared by every tenant, and every
  // tenant's admin holds admin.system.
  it('lists only the jobs of the caller\'s tenant: another tenant\'s and platform jobs stay out', async () => {
    await queueStatsResolvers.Query.queueJobs(null, { queueName: 'events-ingest' }, admin)
    const q = queues.get('events-ingest')!
    const job = (id: string, data: unknown) => ({ id, name: 'x', data, timestamp: 0, processedOn: null, finishedOn: null, failedReason: null, stacktrace: [], attemptsMade: 1, opts: {}, returnvalue: null })
    q.getJobs.mockResolvedValueOnce([
      job('mine', { tenantId: 't1' }), job('theirs', { tenantId: 't2', body: 'ticket data' }),
      job('event', { event: { tenant_id: 't1' } }), job('platform', { sweep: true }),
    ])
    const jobs = await queueStatsResolvers.Query.queueJobs(null, { queueName: 'events-ingest', limit: 10 }, admin)
    expect(jobs.map((j) => j.id)).toEqual(['mine', 'event'])
  })

  it('reads further pages when the first holds only other tenants\' jobs', async () => {
    await queueStatsResolvers.Query.queueJobs(null, { queueName: 'events-ingest' }, admin)
    const q = queues.get('events-ingest')!
    const job = (id: string, tenantId: string) => ({ id, name: 'x', data: { tenantId }, timestamp: 0, processedOn: null, finishedOn: null, failedReason: null, stacktrace: [], attemptsMade: 1, opts: {}, returnvalue: null })
    q.getJobs.mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => job(`o${i}`, 't2')))
    q.getJobs.mockResolvedValueOnce([job('mine', 't1')])
    const jobs = await queueStatsResolvers.Query.queueJobs(null, { queueName: 'events-ingest', limit: 5 }, admin)
    expect(jobs.map((j) => j.id)).toEqual(['mine'])
    expect(q.getJobs).toHaveBeenLastCalledWith(['failed'], 200, 399)
  })

  it('coda sconosciuta → BAD_USER_INPUT; stato sconosciuto → errore (lookupOrError)', async () => {
    await expect(queueStatsResolvers.Query.queueJobs(null, { queueName: 'nope' }, admin)).rejects.toThrow('Unknown queue: nope')
    await expect(queueStatsResolvers.Query.queueJobs(null, { queueName: 'events-ingest', status: 'weird' }, admin)).rejects.toThrow()
  })
})

describe('retryQueueJob', () => {
  it('rimette in coda un job fallito di una coda rigiocabile', async () => {
    const retry = vi.fn().mockResolvedValue(undefined)
    const q = queues.get('events-ingest') ?? (await queueStatsResolvers.Query.queueJobs(null, { queueName: 'events-ingest' }, admin), queues.get('events-ingest')!)
    q.getJob.mockResolvedValueOnce({ id: 'j1', data: { tenantId: 't1' }, retry })
    await expect(queueStatsResolvers.Mutation.retryQueueJob(null, { queueName: 'events-ingest', jobId: 'j1' }, admin)).resolves.toBe(true)
    expect(retry).toHaveBeenCalled()
  })

  it('another tenant\'s job cannot be retried: it is not found', async () => {
    const retry = vi.fn()
    await queueStatsResolvers.Query.queueJobs(null, { queueName: 'events-ingest' }, admin)
    const q = queues.get('events-ingest')!
    q.getJob.mockResolvedValueOnce({ id: 'j2', data: { tenantId: 't2' }, retry })
    await expect(queueStatsResolvers.Mutation.retryQueueJob(null, { queueName: 'events-ingest', jobId: 'j2' }, admin)).rejects.toThrow('Job j2 not found')
    expect(retry).not.toHaveBeenCalled()
  })

  it('coda di un consumer di dominio → rifiuto esplicito (BAD_USER_INPUT), senza toccare la coda', async () => {
    await expect(queueStatsResolvers.Mutation.retryQueueJob(null, { queueName: 'service-impact-consumer', jobId: 'j1' }, admin))
      .rejects.toThrow(/service-impact-consumer is a domain-event consumer queue: its jobs cannot be retried from the console/)
    expect(queues.get('service-impact-consumer')).toBeUndefined()
  })

  it('job inesistente → NOT_FOUND; coda sconosciuta → Unknown queue; non admin → Forbidden', async () => {
    await expect(queueStatsResolvers.Mutation.retryQueueJob(null, { queueName: 'events-ingest', jobId: 'missing' }, admin)).rejects.toThrow('Job missing not found in queue events-ingest')
    await expect(queueStatsResolvers.Mutation.retryQueueJob(null, { queueName: 'nope', jobId: 'j' }, admin)).rejects.toThrow('Unknown queue: nope')
    await expect(queueStatsResolvers.Mutation.retryQueueJob(null, { queueName: 'events-ingest', jobId: 'j' }, operator)).rejects.toThrow(/admin\.system/)
  })
})
