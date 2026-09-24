/**
 * knowledgeBase.ts — rateKBArticle (contatori helpful/not_helpful, scoping,
 * NOT_FOUND, comportamento reale sul doppio voto), versioning
 * (updateKBArticle crea uno snapshot KBArticleVersion, kbArticleVersions
 * scoped per tenant, restoreKBArticleVersion passa da updateKBArticle).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(),
  toNumber: (v: unknown) => (v == null ? 0 : typeof v === 'object' && 'toNumber' in v ? (v as { toNumber(): number }).toNumber() : Number(v)),
}))
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { createInstance: vi.fn() } }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../lib/logger.js', () => {
  const l = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { ...l, child: () => l } }
})
// F5: la categoria si valida contro `kb_category`; questi test provano altro.
vi.mock('../../../lib/domainMatrix.js', () => ({ assertDomainValue: vi.fn(async (_t: string, _v: string, value: unknown) => value) }))
vi.mock('../../../jobs/embeddingWorker.js', () => ({ enqueueEmbedding: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../../services/embeddings.js', () => ({
  normalizeKbTags: (raw: unknown) => (raw == null || raw === '' ? [] : Array.isArray(raw) ? raw.map(String) : (JSON.parse(raw as string) as unknown[]).map(String)),
}))

const { knowledgeBaseResolvers } = await import('../knowledgeBase.js')
const { getSession } = await import('@opengraphity/neo4j')
const { enqueueEmbedding } = await import('../../../jobs/embeddingWorker.js')
const { audit } = await import('../../../lib/audit.js')

const ctx: GraphQLContext = { tenantId: 'tenant-1', userId: 'user-1', userEmail: 'op@test.io', role: 'operator', permissions: perms('operator') }
const rec = (map: Record<string, unknown>) => ({ get: (k: string) => (k in map ? map[k] : null) })

const ARTICLE = {
  id: 'a1', title: 'Reset password', slug: 'reset-password-a1', body: 'Come fare', category: 'howto', tags: '["auth"]', status: 'draft',
  authorId: 'user-0', authorName: 'autore@test.io', views: 3, helpfulCount: 2, notHelpfulCount: 1,
  createdAt: 'c', updatedAt: 'u', publishedAt: null, workflowInstanceId: 'wi-1', currentStep: 'draft', version: 3, lastEditedByName: 'x@test.io',
}

/** Sessione finta: ogni tx.run consuma la prossima risposta della coda (default: nessun record). */
function fakeSession(responses: Array<{ records: unknown[] }>) {
  const queue = [...responses]
  const txRun = vi.fn().mockImplementation(async () => queue.shift() ?? { records: [] })
  const tx = { run: txRun }
  const s = {
    txRun,
    executeRead:  vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
    executeWrite: vi.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
    close: vi.fn().mockResolvedValue(undefined),
  }
  vi.mocked(getSession).mockReturnValue(s as never)
  return s
}

describe('rateKBArticle', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a vote is the person\'s: MERGE of RATED_KB for the user, scoped per tenant, the updated article in answer (G8, 24 Sep 2026)', async () => {
    const s = fakeSession([{ records: [rec({ ...ARTICLE, helpfulCount: 3 })] }])

    const out = await knowledgeBaseResolvers.Mutation.rateKBArticle(null, { id: 'a1', helpful: true }, ctx)

    const [cypher, params] = s.txRun.mock.calls[0]!
    expect(cypher).toContain('MATCH (a:KBArticle {id: $id, tenant_id: $tenantId})')
    expect(cypher).toContain('MATCH (u:User {id: $userId, tenant_id: $tenantId})')
    expect(cypher).toContain('MERGE (u)-[r:RATED_KB]->(a)')
    // A first vote adds one; the same vote again adds nothing; the other vote moves one.
    expect(cypher).toContain('CASE WHEN $helpful AND (was IS NULL OR was = false) THEN 1 ELSE 0 END')
    expect(cypher).toContain('CASE WHEN NOT $helpful AND was = true THEN 1 ELSE 0 END')
    expect(params).toMatchObject({ id: 'a1', tenantId: 'tenant-1', userId: 'user-1', helpful: true })
    expect(out).toMatchObject({ id: 'a1', helpfulCount: 3, notHelpfulCount: 1, tags: ['auth'], version: 3 })
    expect(s.close).toHaveBeenCalledOnce()
  })

  it('helpful=false passes the vote as it is', async () => {
    const s = fakeSession([{ records: [rec({ ...ARTICLE, notHelpfulCount: 2 })] }])
    const out = await knowledgeBaseResolvers.Mutation.rateKBArticle(null, { id: 'a1', helpful: false }, ctx)
    expect(s.txRun.mock.calls[0]![1]).toMatchObject({ helpful: false })
    expect(out.notHelpfulCount).toBe(2)
  })

  it('articolo di un altro tenant → NOT_FOUND', async () => {
    fakeSession([{ records: [] }])
    const err = await knowledgeBaseResolvers.Mutation.rateKBArticle(null, { id: 'a-altrui', helpful: true }, ctx).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(GraphQLError)
    expect((err as GraphQLError).extensions['code']).toBe('NOT_FOUND')
  })

  // The arithmetic of a second vote (same: nothing; other: moves one) is checked on a real Neo4j: integration/kbVote.int.test.ts.
})

describe('updateKBArticle — versioning', () => {
  beforeEach(() => vi.clearAllMocks())

  it('modifica di contenuto → snapshot KBArticleVersion (tenant_id, article_id, version corrente) + bump version + editor', async () => {
    const s = fakeSession([
      { records: [rec({ id: 'a1' })] },                              // load
      { records: [rec({ ...ARTICLE, body: 'Nuovo corpo', version: 4 })] }, // write
    ])

    const out = await knowledgeBaseResolvers.Mutation.updateKBArticle(null, { id: 'a1', body: 'Nuovo corpo' }, ctx)

    expect(s.executeWrite).toHaveBeenCalledOnce()
    const [cypher, params] = s.txRun.mock.calls[1]!
    expect(cypher).toContain('MATCH (a:KBArticle {id: $id, tenant_id: $tenantId})')
    expect(cypher).toContain('CREATE (v:KBArticleVersion {')
    expect(cypher).toContain('tenant_id:      $tenantId')
    expect(cypher).toContain('article_id:     $id')
    expect(cypher).toContain('version:        coalesce(a.version, 1)')
    expect(cypher).toContain('CREATE (a)-[:HAS_VERSION]->(v)')
    expect(cypher).toContain('a.version           = coalesce(a.version, 1) + 1')
    expect(cypher).toContain('a.body = $body')
    expect(cypher).not.toContain('a.title = $title')
    // lo snapshot viene creato PRIMA del SET (storia = 1..N-1, live = N)
    expect(cypher.indexOf('CREATE (v:KBArticleVersion')).toBeLessThan(cypher.indexOf('SET a.body'))
    expect(params).toMatchObject({ id: 'a1', tenantId: 'tenant-1', body: 'Nuovo corpo', editorId: 'user-1', editorName: 'op@test.io' })
    expect(out).toMatchObject({ id: 'a1', body: 'Nuovo corpo', version: 4 })
    expect(enqueueEmbedding).toHaveBeenCalledWith({ entityType: 'kb_article', entityId: 'a1', tenantId: 'tenant-1' })
    expect(audit).toHaveBeenCalledWith(ctx, 'kb_article.updated', 'KBArticle', 'a1')
  })

  it('nessun campo di contenuto → nessuna versione, nessuna scrittura, articolo restituito com\'è', async () => {
    const s = fakeSession([
      { records: [rec({ id: 'a1' })] },
      { records: [rec(ARTICLE)] },
    ])
    const out = await knowledgeBaseResolvers.Mutation.updateKBArticle(null, { id: 'a1' }, ctx)
    expect(s.executeWrite).not.toHaveBeenCalled()
    expect(out.version).toBe(3)
    expect(enqueueEmbedding).not.toHaveBeenCalled()
  })

  it('articolo di un altro tenant → NOT_FOUND, nessuna scrittura', async () => {
    const s = fakeSession([{ records: [] }])
    await expect(knowledgeBaseResolvers.Mutation.updateKBArticle(null, { id: 'a-altrui', title: 'X' }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } })
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('body oltre 50000 caratteri → BAD_REQUEST prima di aprire la sessione', async () => {
    await expect(knowledgeBaseResolvers.Mutation.updateKBArticle(null, { id: 'a1', body: 'x'.repeat(50_001) }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'BAD_REQUEST' } })
    expect(getSession).not.toHaveBeenCalled()
  })
})

describe('kbArticleVersions — scoped per tenant', () => {
  beforeEach(() => vi.clearAllMocks())

  it('MATCH passa dall\'articolo del tenant; versioni ordinate DESC e mappate', async () => {
    const s = fakeSession([{ records: [
      rec({ version: 2, title: 'v2', body: 'b2', category: 'c', tags: '["a"]', editedById: 'u-2', editedByName: 'u2@test.io', editedAt: 'e2' }),
      rec({ version: 1, title: 'v1', body: 'b1', category: 'c', tags: null, editedById: null, editedByName: 'autore@test.io', editedAt: 'e1' }),
    ] }])

    const out = await knowledgeBaseResolvers.Query.kbArticleVersions(null, { articleId: 'a1' }, ctx)

    const [cypher, params] = s.txRun.mock.calls[0]!
    expect(cypher).toContain('MATCH (a:KBArticle {id: $articleId, tenant_id: $tenantId})-[:HAS_VERSION]->(v:KBArticleVersion)')
    expect(cypher).toContain('ORDER BY v.version DESC')
    expect(params).toEqual({ articleId: 'a1', tenantId: 'tenant-1' })
    expect(out).toEqual([
      { version: 2, title: 'v2', body: 'b2', category: 'c', tags: ['a'], editedById: 'u-2', editedByName: 'u2@test.io', editedAt: 'e2' },
      { version: 1, title: 'v1', body: 'b1', category: 'c', tags: [], editedById: null, editedByName: 'autore@test.io', editedAt: 'e1' },
    ])
  })

  it('articolo di un altro tenant → lista vuota', async () => {
    fakeSession([{ records: [] }])
    await expect(knowledgeBaseResolvers.Query.kbArticleVersions(null, { articleId: 'a-altrui' }, ctx)).resolves.toEqual([])
  })
})

describe('restoreKBArticleVersion', () => {
  beforeEach(() => vi.clearAllMocks())

  it('versione inesistente (o articolo di altro tenant) → NOT_FOUND, nessuna scrittura', async () => {
    const s = fakeSession([{ records: [] }])
    await expect(knowledgeBaseResolvers.Mutation.restoreKBArticleVersion(null, { articleId: 'a1', version: 9 }, ctx))
      .rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' }, message: 'Version 9 not found for article' })
    const [cypher, params] = s.txRun.mock.calls[0]!
    expect(cypher).toContain('MATCH (a:KBArticle {id: $articleId, tenant_id: $tenantId})-[:HAS_VERSION]->(v:KBArticleVersion {version: $version})')
    expect(params).toEqual({ articleId: 'a1', tenantId: 'tenant-1', version: 9 })
    expect(s.executeWrite).not.toHaveBeenCalled()
  })

  it('versione esistente → il contenuto dello snapshot passa da updateKBArticle (nuovo snapshot del corrente + bump), audit version_restored', async () => {
    const s = fakeSession([
      { records: [rec({ title: 'Vecchio titolo', body: 'Vecchio corpo', category: 'faq', tags: '["old"]' })] }, // snapshot
      { records: [rec({ id: 'a1' })] },                                                                        // update: load
      { records: [rec({ ...ARTICLE, title: 'Vecchio titolo', body: 'Vecchio corpo', category: 'faq', tags: '["old"]', version: 4 })] }, // update: write
    ])

    const out = await knowledgeBaseResolvers.Mutation.restoreKBArticleVersion(null, { articleId: 'a1', version: 1 }, ctx)

    expect(s.executeWrite).toHaveBeenCalledOnce()
    const [cypher, params] = s.txRun.mock.calls[2]!
    expect(cypher).toContain('CREATE (v:KBArticleVersion {')
    expect(cypher).toContain('a.title = $title, a.body = $body, a.category = $category, a.tags = $tags')
    expect(params).toMatchObject({ id: 'a1', tenantId: 'tenant-1', title: 'Vecchio titolo', body: 'Vecchio corpo', category: 'faq', tags: '["old"]', editorId: 'user-1' })
    expect(out).toMatchObject({ title: 'Vecchio titolo', body: 'Vecchio corpo', version: 4, tags: ['old'] })
    expect(audit).toHaveBeenCalledWith(ctx, 'kb_article.version_restored', 'KBArticle', 'a1')
    // due sessioni (restore + update) entrambe chiuse
    expect(s.close).toHaveBeenCalledTimes(2)
  })
})

// ── Tour of 24 Sep 2026: related articles (G9) and the reader's own vote (G8) ──

describe('kbRelatedArticles', () => {
  beforeEach(() => vi.clearAllMocks())
  const row = (id: string, tags: string[], category: string, views: number, mine: string[] = ['auth', 'vpn'], myCategory = 'howto') =>
    rec({ mine: JSON.stringify(mine), myCategory, id, title: `T ${id}`, slug: `s-${id}`, category, tags: JSON.stringify(tags), views })

  it('related = sharing a tag: more tags in common first, then the same category, then the most read; no shared tag, not related', async () => {
    const s = fakeSession([{ records: [
      row('one-tag-other-cat', ['auth'], 'faq', 90),
      row('two-tags', ['AUTH', 'vpn'], 'faq', 1),
      row('one-tag-same-cat', ['vpn'], 'howto', 5),
      row('unrelated', ['printer'], 'howto', 500),
      row('one-tag-other-cat-less-read', ['auth'], 'faq', 10),
    ] }])
    const out = await knowledgeBaseResolvers.Query.kbRelatedArticles(null, { id: 'a1', limit: 10 }, ctx)
    expect(out.map((a) => [a.id, a.sharedTags])).toEqual([
      ['two-tags', 2], ['one-tag-same-cat', 1], ['one-tag-other-cat', 1], ['one-tag-other-cat-less-read', 1],
    ])
    const [cypher, params] = s.txRun.mock.calls[0]!
    expect(cypher).toContain('MATCH (me:KBArticle {id: $id, tenant_id: $tenantId})')
    expect(cypher).toContain('a.id <> me.id')
    // The staff reads every published article; the portal only those for everyone.
    expect(cypher).toContain('($readsAll OR ')
    expect(cypher).toContain("a.audience = 'everyone'")
    expect(params).toEqual({ id: 'a1', tenantId: 'tenant-1', readsAll: true })
    expect(s.close).toHaveBeenCalledOnce()
  })

  it('a portal reader is filtered to the articles for everyone, and the list is capped (4 by default, 10 at most)', async () => {
    const endUser: GraphQLContext = { ...ctx, role: 'end_user', permissions: perms('end_user') }
    const many = Array.from({ length: 12 }, (_, i) => row(`r${String(i)}`, ['auth'], 'faq', i))
    const s = fakeSession([{ records: many }])
    expect(await knowledgeBaseResolvers.Query.kbRelatedArticles(null, { id: 'a1' }, endUser)).toHaveLength(4)
    expect(s.txRun.mock.calls[0]![1]).toMatchObject({ readsAll: false })
    fakeSession([{ records: many }])
    expect(await knowledgeBaseResolvers.Query.kbRelatedArticles(null, { id: 'a1', limit: 50 }, endUser)).toHaveLength(10)
    fakeSession([{ records: many }])
    expect(await knowledgeBaseResolvers.Query.kbRelatedArticles(null, { id: 'a1', limit: 0 }, endUser)).toHaveLength(1)
  })

  it('an article that is not there (or has no neighbour) has no related articles', async () => {
    fakeSession([{ records: [] }])
    expect(await knowledgeBaseResolvers.Query.kbRelatedArticles(null, { id: 'nope' }, ctx)).toEqual([])
  })
})

describe('KBArticle.myVote', () => {
  beforeEach(() => vi.clearAllMocks())

  it("the reader's own vote, read on their RATED_KB in the tenant; no vote is null", async () => {
    const s = fakeSession([{ records: [rec({ helpful: false })] }])
    expect(await knowledgeBaseResolvers.KBArticle.myVote({ id: 'a1' }, null, ctx)).toBe(false)
    const [cypher, params] = s.txRun.mock.calls[0]!
    expect(cypher).toContain('MATCH (:User {id: $userId, tenant_id: $tenantId})-[r:RATED_KB]->(:KBArticle {id: $id, tenant_id: $tenantId})')
    expect(params).toEqual({ id: 'a1', userId: 'user-1', tenantId: 'tenant-1' })
    expect(s.close).toHaveBeenCalledOnce()
    fakeSession([{ records: [rec({ helpful: true })] }])
    expect(await knowledgeBaseResolvers.KBArticle.myVote({ id: 'a1' }, null, ctx)).toBe(true)
    fakeSession([{ records: [] }])
    expect(await knowledgeBaseResolvers.KBArticle.myVote({ id: 'a1' }, null, ctx)).toBeNull()
  })
})
