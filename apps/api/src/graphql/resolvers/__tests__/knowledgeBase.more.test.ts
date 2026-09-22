/**
 * knowledgeBase.ts — the reads by id / slug, the list filters, deletion, and
 * the failure paths the other KB test files leave out.
 *
 * Why these behaviours matter:
 *  - a portal user (no `kb.read`) must only ever see PUBLISHED articles, by
 *    list, id or slug — reading a draft by guessing its slug was a real leak;
 *  - every query is scoped to the tenant: an article of another tenant is
 *    NOT_FOUND, never read, rated or deleted;
 *  - deleting an article also removes what lives only for it (workflow,
 *    versions, comments, pending approvals), or approvals for a vanished
 *    article keep showing up in "My approvals";
 *  - an oversized body is refused before any database work;
 *  - a failed embedding enqueue must not fail the save (the similarity index
 *    catches up on backfill), but it must be logged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : Number(v)),
}))
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { createInstance: vi.fn() } }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
const logError = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/logger.js', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: logError, debug: vi.fn() }
  return { logger: { ...l, child: () => l } }
})
vi.mock('../../../lib/domainMatrix.js', () => ({ assertDomainValue: vi.fn(async (_t: string, _v: string, value: unknown) => value) }))
vi.mock('../../../lib/workflowHelpers.js', () => ({ getInitialStepName: vi.fn().mockResolvedValue('draft') }))
vi.mock('../../../jobs/embeddingWorker.js', () => ({ enqueueEmbedding: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../services/embeddings.js', () => ({
  normalizeKbTags: (raw: unknown) => (raw == null || raw === '' ? [] : (JSON.parse(raw as string) as unknown[]).map(String)),
}))

const { knowledgeBaseResolvers, createKBArticle, updateKBArticle } = await import('../knowledgeBase.js')
const { getSession } = await import('@opengraphity/neo4j')
const { enqueueEmbedding } = await import('../../../jobs/embeddingWorker.js')
const { audit } = await import('../../../lib/audit.js')
const { workflowEngine } = await import('@opengraphity/workflow')

const operator: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'op@test.io', role: 'operator', permissions: perms('operator') }
/** A portal user: can read the portal, not the KB workspace. */
const portalUser: GraphQLContext = { ...operator, userId: 'eu-1', role: 'end_user', permissions: new Set(['portal.read']) as never }

const rec = (map: Record<string, unknown>) => ({ get: (k: string) => (k in map ? map[k] : null) })
const ARTICLE = {
  id: 'a1', title: 'Reset password', slug: 'reset-password-a1', body: 'How to', category: 'howto', tags: '["auth"]', status: 'published',
  authorId: 'user-0', authorName: 'author@test.io', views: 4, helpfulCount: 0, notHelpfulCount: 0,
  createdAt: 'c', updatedAt: 'u', publishedAt: 'p', workflowInstanceId: 'wi-1', currentStep: 'published', version: 2, lastEditedByName: 'x',
}

/** Fake session: each tx.run consumes the next queued response (default: no records). */
function fakeSession(responses: Array<{ records: unknown[] }> = []) {
  const queue = [...responses]
  const txRun = vi.fn().mockImplementation(async () => queue.shift() ?? { records: [] })
  const tx = { run: txRun }
  const s = {
    txRun,
    executeRead: vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
    executeWrite: vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
    close: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(getSession).mockReturnValue(s as never)
  return s
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const e = await p.then(() => null, (err: unknown) => err)
  return e instanceof GraphQLError ? String(e.extensions['code']) : `not a GraphQLError: ${String(e)}`
}

beforeEach(() => { vi.clearAllMocks() })

describe('kbArticles', () => {
  it('status, category and search become tenant-scoped conditions; the portal sees only published', async () => {
    const s = fakeSession([{ records: [rec(ARTICLE)] }, { records: [rec({ total: 1 })] }])
    const out = await knowledgeBaseResolvers.Query.kbArticles(null, { status: 'draft', category: 'howto', search: 'Reset' }, portalUser)
    const [cypher, params] = s.txRun.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).toContain('a.tenant_id = $tenantId')
    // Even asking for drafts, a portal user gets the published filter on top.
    expect(cypher).toContain("{category: 'published'}")
    expect(cypher).toContain('a.category = $category')
    expect(cypher).toContain('CONTAINS toLower($search)')
    expect(params).toMatchObject({ tenantId: 'tenant-1', status: 'draft', category: 'howto', search: 'Reset', skip: 0, limit: 20 })
    expect(out).toMatchObject({ total: 1, items: [{ id: 'a1', tags: ['auth'] }] })
    expect(s.close).toHaveBeenCalledOnce()
  })

  it('a KB worker sees every state, and pages are clamped', async () => {
    const s = fakeSession()
    const out = await knowledgeBaseResolvers.Query.kbArticles(null, { page: 3, pageSize: 500 }, operator)
    const [cypher, params] = s.txRun.mock.calls[0]! as [string, Record<string, unknown>]
    expect(cypher).not.toContain("{category: 'published'}")
    expect(params).toMatchObject({ skip: 200, limit: 100 })
    expect(out).toEqual({ items: [], total: 0 })
  })
})

describe('kbArticle / kbArticleBySlug', () => {
  it('by id: counts the view and returns the article, scoped to the tenant', async () => {
    const s = fakeSession([{ records: [rec(ARTICLE)] }])
    const out = await knowledgeBaseResolvers.Query.kbArticle(null, { id: 'a1' }, operator)
    expect(out).toMatchObject({ id: 'a1', views: 4 })
    expect(s.txRun.mock.calls[0]![1]).toEqual({ id: 'a1', tenantId: 'tenant-1' })
    expect(s.txRun.mock.calls[0]![0]).toContain('SET a.views = coalesce(a.views, 0) + 1')
  })

  it('by slug: a KB worker reads any state; a portal user only published, else NOT_FOUND', async () => {
    let s = fakeSession([{ records: [rec(ARTICLE)] }])
    await expect(knowledgeBaseResolvers.Query.kbArticleBySlug(null, { slug: 'reset-password-a1' }, operator)).resolves.toMatchObject({ slug: 'reset-password-a1' })
    expect(s.txRun.mock.calls[0]![0]).not.toContain("{category: 'published'}")
    expect(s.txRun.mock.calls[0]![1]).toEqual({ slug: 'reset-password-a1', tenantId: 'tenant-1' })

    s = fakeSession([{ records: [] }])
    expect(await codeOf(knowledgeBaseResolvers.Query.kbArticleBySlug(null, { slug: 'draft-slug' }, portalUser))).toBe('NOT_FOUND')
    expect(s.txRun.mock.calls[0]![0]).toContain("{category: 'published'}")
    expect(s.close).toHaveBeenCalledOnce()
  })
})

describe('createKBArticle — refusals and side effects', () => {
  it('a body over 50000 characters is refused before any session is opened', async () => {
    const err = await createKBArticle(null, { title: 'T', body: 'x'.repeat(50_001), category: 'howto' }, operator).catch((e: unknown) => e)
    expect((err as GraphQLError).extensions['code']).toBe('BAD_REQUEST')
    expect(getSession).not.toHaveBeenCalled()
  })

  it('a CREATE that returns nothing is an error and no workflow instance is created', async () => {
    fakeSession([{ records: [] }])
    await expect(createKBArticle(null, { title: 'T', body: 'b', category: 'howto' }, operator)).rejects.toThrow(/was not created/)
    expect(workflowEngine.createInstance).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })

  it('a failed embedding enqueue does not fail the save, and is logged', async () => {
    fakeSession([{ records: [rec(ARTICLE)] }])
    vi.mocked(workflowEngine.createInstance).mockResolvedValue({ id: 'wi-9' } as never)
    vi.mocked(enqueueEmbedding).mockRejectedValueOnce(new Error('redis down'))
    const out = await createKBArticle(null, { title: 'T', body: 'b', category: 'howto' }, operator)
    expect(out.workflowInstanceId).toBe('wi-9')
    await vi.waitFor(() => expect(logError).toHaveBeenCalled())
  })
})

describe('updateKBArticle — embedding failure', () => {
  it('a failed enqueue after a content change does not fail the update, and is logged', async () => {
    fakeSession([{ records: [rec({ id: 'a1', version: 2 })] }, { records: [rec(ARTICLE)] }])
    vi.mocked(enqueueEmbedding).mockRejectedValueOnce(new Error('redis down'))
    await expect(updateKBArticle(null, { id: 'a1', title: 'New title' }, operator)).resolves.toMatchObject({ id: 'a1' })
    await vi.waitFor(() => expect(logError).toHaveBeenCalled())
  })
})

describe('deleteKBArticle', () => {
  it('an article of another tenant is NOT_FOUND and nothing is deleted', async () => {
    const s = fakeSession([{ records: [] }])
    expect(await codeOf(knowledgeBaseResolvers.Mutation.deleteKBArticle(null, { id: 'a-other' }, operator))).toBe('NOT_FOUND')
    expect(s.executeWrite).not.toHaveBeenCalled()
    expect(s.close).toHaveBeenCalledOnce()
  })

  it('removes the article with its workflow, versions, comments and pending approvals, and audits it', async () => {
    const s = fakeSession([{ records: [rec({ id: 'a1' })] }, { records: [] }])
    await expect(knowledgeBaseResolvers.Mutation.deleteKBArticle(null, { id: 'a1' }, operator)).resolves.toBe(true)
    const [cypher, params] = s.txRun.mock.calls[1]! as [string, Record<string, unknown>]
    expect(params).toEqual({ id: 'a1', tenantId: 'tenant-1' })
    for (const what of ['WorkflowInstance', 'WorkflowStepExecution', 'KBArticleVersion', 'Comment', 'ApprovalRequest']) {
      expect(cypher).toContain(what)
    }
    expect(audit).toHaveBeenCalledWith(operator, 'kb_article.deleted', 'KBArticle', 'a1')
    expect(s.close).toHaveBeenCalledOnce()
  })
})
