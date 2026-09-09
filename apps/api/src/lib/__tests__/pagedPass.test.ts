/**
 * lib/pagedPass.ts — runPagedPass: pagine con cursore sull'ultima chiave,
 * fine su pagina vuota o corta, tetto di pagine (truncated), errori per riga
 * contati senza fermare le altre, cursore che non avanza → errore.
 */
import { describe, it, expect, vi } from 'vitest'
import { runPagedPass, PAGE_SIZE, MAX_PAGES } from '../pagedPass.js'

type Row = { id: string }
const rows = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ id: `r${String(from + i).padStart(5, '0')}` }))
/** Sorgente di `total` righe: restituisce quelle con id > cursor, al più `limit`. */
const source = (total: number) => (cursor: string, limit: number) => rows(total).filter((r) => r.id > cursor).slice(0, limit)

describe('runPagedPass', () => {
  it('legge pagine di pageSize con il cursore sull\'ultima chiave e si ferma alla pagina corta', async () => {
    const fetchPage = vi.fn(async (cursor: string, limit: number) => source(250)(cursor, limit))
    const seen: string[] = []
    const out = await runPagedPass<Row>({ fetchPage, keyOf: (r) => r.id, handle: async (r) => { seen.push(r.id) }, onError: vi.fn(), pageSize: 100 })
    expect(out).toEqual({ evaluated: 250, failed: 0, truncated: false })
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual(['', 'r00099', 'r00199'])
    expect(fetchPage.mock.calls.every((c) => c[1] === 100)).toBe(true)
    expect(seen).toHaveLength(250)
    expect(PAGE_SIZE).toBe(200)
    expect(MAX_PAGES).toBe(20)
  })

  it('pagina piena seguita da pagina vuota → fine senza truncated; nessuna riga → nessuna handle', async () => {
    const fetchPage = vi.fn(async (cursor: string, limit: number) => source(100)(cursor, limit))
    const out = await runPagedPass<Row>({ fetchPage, keyOf: (r) => r.id, handle: async () => {}, onError: vi.fn(), pageSize: 100 })
    expect(out).toEqual({ evaluated: 100, failed: 0, truncated: false })
    expect(fetchPage).toHaveBeenCalledTimes(2)
    const handle = vi.fn()
    await expect(runPagedPass<Row>({ fetchPage: async () => [], keyOf: (r) => r.id, handle, onError: vi.fn() })).resolves.toEqual({ evaluated: 0, failed: 0, truncated: false })
    expect(handle).not.toHaveBeenCalled()
  })

  it('oltre maxPages pagine piene → truncated: il resto è lasciato alla passata successiva', async () => {
    const fetchPage = vi.fn(async (cursor: string, limit: number) => source(1_000)(cursor, limit))
    const out = await runPagedPass<Row>({ fetchPage, keyOf: (r) => r.id, handle: async () => {}, onError: vi.fn(), pageSize: 10, maxPages: 3 })
    expect(out).toEqual({ evaluated: 30, failed: 0, truncated: true })
    expect(fetchPage).toHaveBeenCalledTimes(3)
  })

  it('handle che lancia → riga contata come fallita, onError chiamata, le altre proseguono', async () => {
    const onError = vi.fn()
    const out = await runPagedPass<Row>({
      fetchPage: async (c, l) => source(5)(c, l), keyOf: (r) => r.id,
      handle: async (r) => { if (r.id === 'r00002') throw new Error('boom') }, onError,
    })
    expect(out).toEqual({ evaluated: 5, failed: 1, truncated: false })
    expect(onError).toHaveBeenCalledWith({ id: 'r00002' }, expect.any(Error))
  })

  it('cursore che non avanza (chiave vuota o non crescente) → errore esplicito, niente loop', async () => {
    await expect(runPagedPass<Row>({ fetchPage: async () => rows(2), keyOf: () => '', handle: async () => {}, onError: vi.fn(), pageSize: 2 })).rejects.toThrow(/cursor did not advance/)
    let page = 0
    await expect(runPagedPass<Row>({ fetchPage: async () => (page++ === 0 ? rows(2, 10) : rows(2, 0)), keyOf: (r) => r.id, handle: async () => {}, onError: vi.fn(), pageSize: 2 })).rejects.toThrow(/cursor did not advance/)
  })
})
