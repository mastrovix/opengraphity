/**
 * Reading one vocabulary as THIS tenant sees it.
 *
 * Why these behaviours matter:
 *  - The tenant's own copy must win over the shipped (system) one: a customer
 *    who renamed a KB category or recoloured a risk band must see their choice
 *    in the portal and in the PDFs, not the factory one.
 *  - Only the tenant's own copy and the system copy are ever read — another
 *    tenant's vocabulary must never leak in.
 *  - A missing vocabulary, or one whose `values` is not a list, is a loud error
 *    (no silent empty list that would render an empty picker).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const txRun = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
const executeRead = vi.fn(async (fn: (tx: { run: typeof txRun }) => unknown) => fn({ run: txRun }))
const getSession = vi.fn((..._a: unknown[]) => ({ executeRead, close }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: (...a: unknown[]) => getSession(...a) }))

const { loadVocabularyEntries } = await import('../vocabularyEntries.js')

const rec = (m: Record<string, unknown>) => ({ get: (k: string) => m[k] })
const rows = (...r: Array<Record<string, unknown>>) => txRun.mockResolvedValueOnce({ records: r.map(rec) })

beforeEach(() => { vi.clearAllMocks() })

describe('loadVocabularyEntries', () => {
  it('the tenant copy wins over the shipped one, whatever the row order', async () => {
    rows(
      { owner: 'system', values: ['low', 'high'], labels: null, colors: null },
      { owner: 't1', values: ['basso', 'alto'], labels: JSON.stringify({ alto: { it: 'Alto' } }), colors: JSON.stringify({ alto: 'danger' }) },
    )
    const v = await loadVocabularyEntries('t1', 'risk_band')
    expect(v).toEqual({ values: ['basso', 'alto'], labels: { alto: { it: 'Alto' } }, colors: { alto: 'danger' }, icons: {} })
    // Only the tenant and the system scope are queried.
    expect(txRun.mock.calls[0]![1]).toEqual({ name: 'risk_band', tenantId: 't1', systemTenant: 'system' })
    expect(getSession).toHaveBeenCalledWith(undefined, 'READ')
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('without a tenant copy the shipped vocabulary is used, with empty labels/colors when none are set', async () => {
    rows({ owner: 'system', values: ['low', 'high'], labels: null, colors: '' })
    await expect(loadVocabularyEntries('t1', 'risk_band')).resolves.toEqual({ values: ['low', 'high'], labels: {}, colors: {}, icons: {} })
  })

  it('a row owned by some other tenant is never picked', async () => {
    // Defence in depth: even if the query returned it, it is neither ours nor shipped.
    rows({ owner: 't2', values: ['x'], labels: null, colors: null })
    await expect(loadVocabularyEntries('t1', 'kb_category')).rejects.toThrow('Vocabulary "kb_category" does not exist for tenant t1 nor as shipped')
  })

  it('a vocabulary whose values is not a list is an error naming the owner', async () => {
    rows({ owner: 't1', values: 'low,high', labels: null, colors: null })
    await expect(loadVocabularyEntries('t1', 'risk_band')).rejects.toThrow('Vocabulary "risk_band" of t1: values is not a list')
    expect(close).toHaveBeenCalledTimes(1)
  })
})
