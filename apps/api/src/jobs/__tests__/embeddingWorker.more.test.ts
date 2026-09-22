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
vi.mock('../../lib/bullmq.js', () => ({
  createWorker: vi.fn((_name: string, p: Processor, opts: { onFailed: OnFailed }) => { processor = p; onFailed = opts.onFailed; return {} }),
  getQueue: vi.fn(() => ({ add: vi.fn() })),
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

const { startEmbeddingWorker, embeddingJobId } = await import('../embeddingWorker.js')
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
