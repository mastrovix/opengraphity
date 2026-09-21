/**
 * Revisione totale del 16 set 2026 · H-1: bozze, articoli in revisione e
 * archiviati sono di chi lavora la Knowledge Base (`kb.read`). Prima
 * `kbArticles`, `kbArticle` e `kbArticleBySlug` erano aperti a `portal.read` e
 * non guardavano lo stato: dal portale si leggeva una bozza passando
 * `status: "draft"` o lo slug.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'

const runs: Array<{ cypher: string; params: Record<string, unknown> }> = []
const records: unknown[] = []

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async (w: (tx: unknown) => unknown) => w({ run: (cypher: string, params: Record<string, unknown>) => { runs.push({ cypher, params }); return { records } } }),
    executeWrite: async (w: (tx: unknown) => unknown) => w({ run: (cypher: string, params: Record<string, unknown>) => { runs.push({ cypher, params }); return { records } } }),
    close: async () => undefined,
  }),
  toNumber: (v: unknown) => Number(v ?? 0),
}))
vi.mock('../../../lib/logger.js', () => {
  const l = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn(() => l) }
  return { logger: l, authLogger: l }
})
vi.mock('../../../jobs/embeddingWorker.js', () => ({ enqueueEmbedding: vi.fn() }))

const { kbArticles, kbArticle, kbArticleBySlug } = await import('../knowledgeBase.js')

const ctx = (...permissions: string[]): GraphQLContext => ({
  tenantId: 'c-test', userId: 'u-1', userEmail: 'u@c-test.local',
  role: 'operator' as GraphQLContext['role'], permissions: new Set(permissions) as GraphQLContext['permissions'],
})
const PUBLISHED = "WorkflowStep {category: 'published'}"

beforeEach(() => { runs.length = 0; records.length = 0 })

describe('la Knowledge Base dal portale vede solo il pubblicato', () => {
  it('kbArticles con `portal.read`: il filtro sul pubblicato è del server, qualunque status chieda il client', async () => {
    await kbArticles(null, { status: 'draft' }, ctx('portal.read'))
    expect(runs[0]!.cypher).toContain(PUBLISHED)
  })

  it('kbArticles con `kb.read` (staff): nessun filtro imposto, lo status chiesto vale', async () => {
    await kbArticles(null, { status: 'draft' }, ctx('kb.read', 'portal.read'))
    expect(runs[0]!.cypher).not.toContain(PUBLISHED)
    expect(runs[0]!.params['status']).toBe('draft')
  })

  it.each([
    ['kbArticleBySlug', () => kbArticleBySlug(null, { slug: 'una-bozza' }, ctx('portal.read'))],
    ['kbArticle', () => kbArticle(null, { id: 'a-1' }, ctx('portal.read'))],
  ])('%s dal portale: una bozza risponde «non trovato» e non ne conta la lettura', async (_name, call) => {
    await expect(call()).rejects.toThrow(/not found/)
    expect(runs[0]!.cypher).toContain(PUBLISHED)
  })
})
