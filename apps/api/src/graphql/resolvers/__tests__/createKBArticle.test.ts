import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
  // Stub of the real helper (D-22): plain numbers and Integer-like objects.
  toNumber: (v: unknown) => (v == null ? 0 : typeof v === 'object' && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : Number(v)),
}))
vi.mock('@opengraphity/workflow', () => ({
  workflowEngine: { createInstance: vi.fn() },
}))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../../lib/workflowHelpers.js', () => ({ getInitialStepName: vi.fn().mockResolvedValue('draft') }))
vi.mock('../../../jobs/embeddingWorker.js', () => ({ enqueueEmbedding: vi.fn().mockResolvedValue(undefined) }))

const { createKBArticle } = await import('../knowledgeBase.js')
const { getSession } = await import('@opengraphity/neo4j')
const { workflowEngine } = await import('@opengraphity/workflow')
const { enqueueEmbedding } = await import('../../../jobs/embeddingWorker.js')

const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator' }

const ARTICLE_ROW = {
  id: 'a1', title: 'T', slug: 't-a1', body: 'b', category: 'c', tags: '["x"]', status: 'draft',
  authorId: 'u1', authorName: 'u@x', views: 0, helpfulCount: 0, notHelpfulCount: 0,
  createdAt: 'now', updatedAt: 'now', publishedAt: null, workflowInstanceId: null, currentStep: null,
  version: 1, lastEditedByName: 'u@x',
}

function fakeSession() {
  const txRun = vi.fn().mockResolvedValue({ records: [{ get: (k: string) => (ARTICLE_ROW as Record<string, unknown>)[k] }] })
  const tx = { run: txRun }
  const s = {
    tx,
    executeRead:  vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
    executeWrite: vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
    close: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(getSession).mockReturnValue(s as never)
  return s
}

describe('createKBArticle (C-12) — article and workflow instance in one transaction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('createInstance runs on the SAME tx as the CREATE and its id is returned', async () => {
    const s = fakeSession()
    vi.mocked(workflowEngine.createInstance).mockResolvedValue({ id: 'wi-1' } as never)

    const out = await createKBArticle(null, { title: 'T', body: 'b', category: 'c', tags: ['x'] }, ctx)

    expect(workflowEngine.createInstance).toHaveBeenCalledWith(s.tx, 't1', expect.any(String), 'kb_article')
    const articleId = vi.mocked(workflowEngine.createInstance).mock.calls[0]![2]
    expect(out.id).toBe('a1')
    expect(out.workflowInstanceId).toBe('wi-1')
    expect(out.currentStep).toBe('draft')
    expect(out.tags).toEqual(['x'])
    // the CREATE statement used the same id passed to the workflow engine
    const createCall = s.tx.run.mock.calls.find(c => (c[0] as string).includes('CREATE (a:KBArticle'))!
    expect((createCall[1] as Record<string, unknown>)['id']).toBe(articleId)
    expect(enqueueEmbedding).toHaveBeenCalledWith({ entityType: 'kb_article', entityId: articleId, tenantId: 't1' })
  })

  it('a workflow failure propagates and the transaction (article CREATE) is rolled back with it — no article "without workflow"', async () => {
    const s = fakeSession()
    vi.mocked(workflowEngine.createInstance).mockRejectedValue(new Error('No active workflow definition for "kb_article"'))

    await expect(createKBArticle(null, { title: 'T', body: 'b', category: 'c' }, ctx))
      .rejects.toThrow('No active workflow definition')

    // The CREATE and createInstance ran inside the same executeWrite callback,
    // which rejected → the driver rolls back everything run on that tx.
    expect(s.executeWrite).toHaveBeenCalledTimes(1)
    expect(s.tx.run).toHaveBeenCalledTimes(1)   // only the article CREATE, on the tx that was then rolled back
    expect(enqueueEmbedding).not.toHaveBeenCalled()
    expect(s.close).toHaveBeenCalled()
  })
})
