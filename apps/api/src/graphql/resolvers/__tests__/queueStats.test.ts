/**
 * resolvers/queueStats.ts (revisione 2 · D2.2): le code vengono dal registro
 * unico — anche `events-ingest`, `services-impact` e i quattro consumer —,
 * ogni `QueueStat` porta `group` e `retryable`, e il rigioco è rifiutato dove
 * non ha senso.
 *
 * Dal 23 set 2026 le code di un tenant sono sue (`<nome>@<tenant>`): la
 * pagina legge e rigioca solo quelle del tenant di chi chiama, e non vede le
 * code della piattaforma.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { perms } from '../../../lib/__tests__/testPermissions.js'
import { CONSUMER_QUEUES } from '@opengraphity/events'

interface FakeQueue {
  name: string
  getJobCounts: ReturnType<typeof vi.fn>
  isPaused: ReturnType<typeof vi.fn>
  getJobs: ReturnType<typeof vi.fn>
  getJob: ReturnType<typeof vi.fn>
}
const queues = new Map<string, FakeQueue>()
vi.mock('../../../lib/bullmq.js', () => ({
  getTenantQueue: vi.fn((base: string, tenantId: string) => {
    const name = `${base}@${tenantId}`
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
const { QUEUE_REGISTRY, TENANT_QUEUE_BASES } = await import('../../../lib/queueRegistry.js')

const admin = { role: 'admin', tenantId: 't1', permissions: perms('admin') } as never
const operator = { role: 'operator', tenantId: 't1', permissions: perms('operator') } as never
const queueOf = (base: string, tenant = 't1') => queues.get(`${base}@${tenant}`)!

beforeEach(() => { queues.clear(); vi.clearAllMocks() })

describe('queueStats', () => {
  it('una voce per ogni coda di tenant del registro, con group e retryable dal registro e i conteggi della coda DEL TENANT', async () => {
    const stats = await queueStatsResolvers.Query.queueStats(null, {}, admin)
    expect(stats.map((s) => s.name)).toEqual(TENANT_QUEUE_BASES)
    expect([...queues.keys()].every((k) => k.endsWith('@t1'))).toBe(true)
    const ingest = stats.find((s) => s.name === 'events-ingest')!
    // `paused` non e' piu' un conteggio ma uno stato DELLA CODA (BullMQ 6).
    expect(ingest).toEqual({ name: 'events-ingest', group: 'events', retryable: true, paused: false, counts: { waiting: 1, active: 0, completed: 5, failed: 2, delayed: 0 } })
    for (const name of CONSUMER_QUEUES) {
      expect(stats.find((s) => s.name === name)).toMatchObject({ retryable: false })
    }
    expect(stats.find((s) => s.name === 'services-impact')).toMatchObject({ group: 'services', retryable: true })
    expect(stats.find((s) => s.name === 'workflow-jobs')).toMatchObject({ group: 'itsm' })
    expect(stats.find((s) => s.name === 'webhook-delivery')).toMatchObject({ group: 'analysis' })
  })

  it('le code della piattaforma (backup, Autoanalisi) non sono di nessun tenant: la pagina non le mostra', async () => {
    const stats = await queueStatsResolvers.Query.queueStats(null, {}, admin)
    const platform = QUEUE_REGISTRY.filter((e) => e.scope === 'platform').map((e) => e.name)
    expect(platform).toEqual(['autoanalisi', 'maintenance'])
    for (const name of platform) expect(stats.map((s) => s.name)).not.toContain(name)
  })

  it('richiede il ruolo admin', async () => {
    await expect(queueStatsResolvers.Query.queueStats(null, {}, operator)).rejects.toThrow(/admin\.system/)
  })
})

describe('queueJobs', () => {
  it('legge i job falliti (default) della coda del tenant e mappa i campi; i job spariti da Redis vengono saltati', async () => {
    const jobs = await queueStatsResolvers.Query.queueJobs(null, { queueName: 'events-ingest' }, admin)
    expect(jobs).toEqual([])
    const q = queueOf('events-ingest')
    expect(q.getJobs).toHaveBeenCalledWith(['failed'], 0, 49)

    q.getJobs.mockResolvedValueOnce([
      undefined,
      { id: 'ev-t1-fp-1', name: 'ingest', data: { tenantId: 't1' }, timestamp: 1_700_000_000_000, processedOn: 1_700_000_001_000, finishedOn: null, failedReason: 'Neo4j down', stacktrace: ['x'], attemptsMade: 5, opts: { attempts: 5 }, returnvalue: null },
    ])
    const [job] = await queueStatsResolvers.Query.queueJobs(null, { queueName: 'events-ingest', status: 'failed', limit: 10 }, admin)
    expect(job).toMatchObject({ id: 'ev-t1-fp-1', queueName: 'events-ingest', status: 'failed', failedReason: 'Neo4j down', attemptsMade: 5, maxAttempts: 5, data: '{"tenantId":"t1"}', finishedOn: null })
  })

  it('un altro tenant legge la SUA coda: i job di t1 non gli arrivano', async () => {
    const other = { role: 'admin', tenantId: 't2', permissions: perms('admin') } as never
    await queueStatsResolvers.Query.queueJobs(null, { queueName: 'events-ingest' }, other)
    expect([...queues.keys()]).toEqual(['events-ingest@t2'])
  })

  it('coda sconosciuta o della piattaforma → BAD_USER_INPUT; stato sconosciuto → errore (lookupOrError)', async () => {
    await expect(queueStatsResolvers.Query.queueJobs(null, { queueName: 'nope' }, admin)).rejects.toThrow('Unknown queue: nope')
    await expect(queueStatsResolvers.Query.queueJobs(null, { queueName: 'maintenance' }, admin)).rejects.toThrow('Unknown queue: maintenance')
    await expect(queueStatsResolvers.Query.queueJobs(null, { queueName: 'events-ingest', status: 'weird' }, admin)).rejects.toThrow()
  })
})

describe('retryQueueJob', () => {
  it('rimette in coda un job fallito della coda del tenant', async () => {
    const retry = vi.fn().mockResolvedValue(undefined)
    await queueStatsResolvers.Query.queueJobs(null, { queueName: 'events-ingest' }, admin)
    queueOf('events-ingest').getJob.mockResolvedValueOnce({ id: 'j1', data: { tenantId: 't1' }, retry })
    await expect(queueStatsResolvers.Mutation.retryQueueJob(null, { queueName: 'events-ingest', jobId: 'j1' }, admin)).resolves.toBe(true)
    expect(retry).toHaveBeenCalled()
  })

  it('coda di un consumer di dominio → rifiuto esplicito (BAD_USER_INPUT), senza toccare la coda', async () => {
    await expect(queueStatsResolvers.Mutation.retryQueueJob(null, { queueName: 'service-impact-consumer', jobId: 'j1' }, admin))
      .rejects.toThrow(/service-impact-consumer is a domain-event consumer queue: its jobs cannot be retried from the console/)
    expect(queues.get('service-impact-consumer@t1')).toBeUndefined()
  })

  it('job inesistente → NOT_FOUND; coda sconosciuta o della piattaforma → Unknown queue; non admin → Forbidden', async () => {
    await expect(queueStatsResolvers.Mutation.retryQueueJob(null, { queueName: 'events-ingest', jobId: 'missing' }, admin)).rejects.toThrow('Job missing not found in queue events-ingest')
    await expect(queueStatsResolvers.Mutation.retryQueueJob(null, { queueName: 'nope', jobId: 'j' }, admin)).rejects.toThrow('Unknown queue: nope')
    await expect(queueStatsResolvers.Mutation.retryQueueJob(null, { queueName: 'maintenance', jobId: 'j' }, admin)).rejects.toThrow('Unknown queue: maintenance')
    await expect(queueStatsResolvers.Mutation.retryQueueJob(null, { queueName: 'events-ingest', jobId: 'j' }, operator)).rejects.toThrow(/admin\.system/)
  })
})
