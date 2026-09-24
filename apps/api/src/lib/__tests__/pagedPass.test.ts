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

/*
 * Review of 23 Sep 2026: every run started from the first key, so 4,000 rows
 * that kept failing hid every row after them, for ever.
 */
describe('runPagedPass — resuming where the previous run stopped', () => {
  const memoryStore = () => {
    const m = new Map<string, string>()
    return {
      m,
      get: vi.fn(async (k: string) => m.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => { m.set(k, v) }),
      clear: vi.fn(async (k: string) => { m.delete(k) }),
    }
  }

  it('a truncated run saves its cursor; the next one goes on from there, wraps to the first key and stops where it began', async () => {
    const store = memoryStore()
    const seen: string[][] = [[], []]
    let run = 0
    const pass = (maxPages: number) => runPagedPass<Row>({
      fetchPage: async (cursor, limit) => source(250)(cursor, limit),
      keyOf: (r) => r.id, handle: async (r) => { seen[run]!.push(r.id) }, onError: vi.fn(),
      pageSize: 100, maxPages, resume: { key: 'events:x:t1', store },
    })
    expect(await pass(2)).toEqual({ evaluated: 200, failed: 0, truncated: true })
    expect(store.m.get('events:x:t1')).toBe('r00199')
    run = 1
    expect(await pass(5)).toEqual({ evaluated: 250, failed: 0, truncated: false })
    // The rest first, then from the start up to where this run began: every row once in the lap.
    expect(seen[1]!.slice(0, 50)).toEqual(rows(50, 200).map((r) => r.id))
    expect(seen[1]!.slice(50)).toEqual(rows(200).map((r) => r.id))
    // The lap is complete: the next run starts from the first key.
    expect(store.m.has('events:x:t1')).toBe(false)
  })

  it('rows that keep failing in front no longer hide the rows after them', async () => {
    const store = memoryStore()
    const handled = new Set<string>()
    const pass = () => runPagedPass<Row>({
      fetchPage: async (cursor, limit) => source(500)(cursor, limit),
      keyOf: (r) => r.id,
      handle: async (r) => { if (r.id < 'r00400') throw new Error('always failing'); handled.add(r.id) },
      onError: vi.fn(), pageSize: 100, maxPages: 3, resume: { key: 'k', store },
    })
    await pass()
    expect(handled.size).toBe(0)
    await pass()
    expect(handled.size).toBe(100)
  })

  it('without resume nothing is read or saved: every run starts from the first key', async () => {
    const store = memoryStore()
    await runPagedPass<Row>({ fetchPage: async (c, l) => source(50)(c, l), keyOf: (r) => r.id, handle: async () => {}, onError: vi.fn(), pageSize: 100 })
    expect(store.get).not.toHaveBeenCalled()
  })
})
