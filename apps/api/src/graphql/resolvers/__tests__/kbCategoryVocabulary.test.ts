/**
 * Revisione del 14 set 2026 · F5: le categorie della Knowledge Base sono il
 * vocabolario `kb_category` del Dizionario. La creazione e la modifica di un
 * articolo accettano solo i suoi valori, e `kbCategories` restituisce il
 * vocabolario (con etichetta, colore e quanti articoli pubblicati) invece delle
 * sole categorie già usate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { GraphQLContext } from '../../../context.js'
import { perms } from '../../../lib/__tests__/testPermissions.js'

const txRun = vi.fn()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({
    executeRead:  (fn: (t: { run: typeof txRun }) => unknown) => fn({ run: txRun }),
    executeWrite: (fn: (t: { run: typeof txRun }) => unknown) => fn({ run: txRun }),
    close: vi.fn(async () => {}),
  })),
  toNumber: (v: unknown) => Number(v),
}))
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: { createInstance: vi.fn(async () => ({ id: 'wi' })) } }))
vi.mock('../../../lib/audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../../lib/workflowHelpers.js', () => ({ getInitialStepName: vi.fn(async () => 'draft') }))
vi.mock('../../../jobs/embeddingWorker.js', () => ({ enqueueEmbedding: vi.fn(async () => {}) }))
const assertDomainValue = vi.fn(async (_t: string, _v: string, value: unknown) => {
  if (value !== 'database' && value !== 'network') throw Object.assign(new Error(`kb_category: "${String(value)}" is not in the dictionary`), { name: 'ValidationError' })
  return value
})
vi.mock('../../../lib/domainMatrix.js', () => ({ assertDomainValue }))
const loadVocabularyEntries = vi.fn(async () => ({
  values: ['database', 'network', 'faq'],
  labels: { database: { it: 'Database', en: 'Database' }, network: { it: 'Rete', en: 'Network' } },
  colors: { database: 'orange', network: 'info' },
}))
vi.mock('../../../lib/vocabularyEntries.js', () => ({ loadVocabularyEntries }))
vi.mock('../../../lib/tenantLanguage.js', () => ({ languageFor: vi.fn(async () => 'it') }))

const { createKBArticle, updateKBArticle, kbCategories } = await import('../knowledgeBase.js')
const ctx: GraphQLContext = { tenantId: 't1', userId: 'u1', userEmail: 'u@x', role: 'operator', permissions: perms('operator') }

describe('categorie KB dal Dizionario', () => {
  beforeEach(() => { txRun.mockReset(); vi.clearAllMocks() })

  it('creare un articolo con una categoria fuori vocabolario è rifiutato prima di scrivere', async () => {
    await expect(createKBArticle(null, { title: 'T', body: 'b', category: 'access' }, ctx)).rejects.toThrow(/access/)
    expect(assertDomainValue).toHaveBeenCalledWith('t1', 'kb_category', 'access')
    expect(txRun).not.toHaveBeenCalled()
  })

  it('modificare la categoria la valida allo stesso modo', async () => {
    await expect(updateKBArticle(null, { id: 'a1', category: 'access' }, ctx)).rejects.toThrow(/access/)
    expect(txRun).not.toHaveBeenCalled()
  })

  it('kbCategories: il vocabolario nell\'ordine dei valori, con etichetta nella lingua chiesta, colore e articoli pubblicati (anche zero)', async () => {
    txRun.mockResolvedValueOnce({ records: [{ get: (k: string) => ({ name: 'database', count: 20 } as Record<string, unknown>)[k] }] })
    const out = await kbCategories(null, { language: 'en' }, ctx)
    expect(out).toEqual([
      { name: 'database', label: 'Database', color: 'orange',  count: 20 },
      { name: 'network',  label: 'Network',  color: 'info',    count: 0 },
      { name: 'faq',      label: 'Faq',      color: null,      count: 0 },
    ])
    expect(loadVocabularyEntries).toHaveBeenCalledWith('t1', 'kb_category')
  })
})
