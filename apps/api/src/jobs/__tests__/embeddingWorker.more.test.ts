/**
 * Embedding worker, the paths the main suite does not reach:
 *  - an organisation that turned embeddings OFF (ondata 6): the entity text
 *    must not leave for the provider at all — not read, not embedded, not
 *    written. This is a data-sharing promise to the customer, not a tuning knob;
 *  - a malformed `updatedAt` makes the job id throw instead of producing
 *    `embed-…-NaN`: a NaN id would collide for every broken edit and BullMQ
 *    would silently drop the re-embeds (the C-17 staleness, back again);
 *  - a failed job is logged with its id and data, the only trace an operator
 *    has of why "similar incidents" went stale.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Job } from 'bullmq'

type Processor = (job: Job) => Promise<unknown>
type OnFailed = (job: Job | undefined, err: Error) => void
let processor: Processor | null = null
let onFailed: OnFailed | null = null
vi.mock('../../lib/aiSettings.js', () => import('../../lib/__tests__/aiSettingsFake.js'))
const queue = { add: vi.fn(), getJob: vi.fn() }
const getTenantQueue = vi.fn((_base: string, _tenantId: string) => queue)
vi.mock('../../lib/bullmq.js', () => ({
  createTenantWorkers: vi.fn((_name: string, p: Processor, opts: { onFailed: OnFailed }) => { processor = p; onFailed = opts.onFailed; return {} }),
  getTenantQueue: (base: string, tenantId: string) => getTenantQueue(base, tenantId),
}))

const getSession = vi.fn(() => ({ executeWrite: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }))
const runQueryOne = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => getSession(),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a),
}))

const embed = vi.fn()
vi.mock('../../services/embeddings.js', () => ({
  getEmbedder: () => ({ provider: 'local', model: 'm', dimensions: 3, embed }),
  vectorIndexName: (label: string) => `${label}_idx`,
  incidentEmbeddingText: () => 'text',
  kbEmbeddingText: () => 'text',
}))

const logInfo = vi.fn()
const logError = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ info: logInfo, warn: vi.fn(), error: logError, debug: vi.fn() }) },
}))

const { startEmbeddingWorker, embeddingJobId, requestEmbedding } = await import('../embeddingWorker.js')
const { aiOff, aiResetFake } = await import('../../lib/__tests__/aiSettingsFake.js')

beforeEach(async () => {
  vi.clearAllMocks()
  aiResetFake()
  await startEmbeddingWorker()
  getSession.mockClear()
})

describe('embeddings turned off by the organisation', () => {
  it('skips the job without reading the entity or calling the provider', async () => {
    aiOff('embeddings')
    await processor!({ data: { entityType: 'incident', entityId: 'inc-1', tenantId: 't1' } } as Job)
    expect(runQueryOne).not.toHaveBeenCalled()
    expect(embed).not.toHaveBeenCalled()
    expect(getSession).not.toHaveBeenCalled()
    expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', entityId: 'inc-1' }), expect.stringContaining('turned off'))
  })
})

describe('embeddingJobId', () => {
  it('a malformed updatedAt throws, naming the entity', () => {
    expect(() => embeddingJobId({ entityType: 'kb_article', entityId: 'kb-7', tenantId: 't1', updatedAt: 'yesterday' }))
      .toThrow(/invalid updatedAt "yesterday" for kb_article kb-7/)
  })

  it('two versions of the same entity get two job ids', () => {
    const a = embeddingJobId({ entityType: 'incident', entityId: 'i1', tenantId: 't1', updatedAt: '2026-09-01T00:00:00Z' })
    const b = embeddingJobId({ entityType: 'incident', entityId: 'i1', tenantId: 't1', updatedAt: '2026-09-02T00:00:00Z' })
    expect(a).not.toBe(b)
    expect(a).toBe(`embed-incident-i1-${Date.parse('2026-09-01T00:00:00Z')}`)
  })
})

describe('failed jobs', () => {
  it('are logged with job id, data and reason', () => {
    const data = { entityType: 'incident', entityId: 'inc-1', tenantId: 't1' }
    onFailed!({ id: 'j-9', data } as unknown as Job, new Error('provider 503'))
    expect(logError).toHaveBeenCalledWith({ jobId: 'j-9', data, err: 'provider 503' }, expect.stringContaining('job failed'))
  })

  it('a failure without a job (BullMQ can report one) is still logged', () => {
    onFailed!(undefined, new Error('stalled'))
    expect(logError).toHaveBeenCalledWith({ jobId: undefined, data: undefined, err: 'stalled' }, expect.any(String))
  })
})

/**
 * D15 (tour of 23 Sep 2026): the similarity panel asks for the embedding of
 * the incident it shows. «Under way» must be true: the job is queued if it is
 * not there, left alone while it waits or runs, and a job that used up its
 * attempts is reported with its reason instead of being queued again.
 */
describe('requestEmbedding', () => {
  const data = { entityType: 'incident' as const, entityId: 'i1', tenantId: 't1', updatedAt: '2026-09-23T04:20:00.000Z' }
  const jobId = `embed-incident-i1-${Date.parse('2026-09-23T04:20:00.000Z')}`

  it('queues the job of this version when there is none', async () => {
    queue.getJob.mockResolvedValue(undefined)
    await expect(requestEmbedding(data)).resolves.toEqual({ state: 'queued' })
    // The job is looked up in the tenant's own queue: another tenant's job is never seen.
    expect(getTenantQueue).toHaveBeenCalledWith('embeddings', 't1')
    expect(queue.getJob).toHaveBeenCalledWith(jobId)
    expect(queue.add).toHaveBeenCalledWith('embed', data, expect.objectContaining({ jobId }))
  })

  it('leaves a waiting or running job alone', async () => {
    queue.getJob.mockResolvedValue({ isFailed: async () => false })
    await expect(requestEmbedding(data)).resolves.toEqual({ state: 'queued' })
    expect(queue.add).not.toHaveBeenCalled()
  })

  it('reports a failed job with its reason, and does not queue it again', async () => {
    queue.getJob.mockResolvedValue({ isFailed: async () => true, failedReason: 'model not loaded' })
    await expect(requestEmbedding(data)).resolves.toEqual({ state: 'failed', reason: 'model not loaded' })
    expect(queue.add).not.toHaveBeenCalled()
  })
})
