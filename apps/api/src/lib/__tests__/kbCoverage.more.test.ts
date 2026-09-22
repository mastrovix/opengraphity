/**
 * KB coverage: the two functions that touch the graph.
 *
 * Why these behaviours matter:
 *  - `collegaArticoloAIncident` runs right after a KB draft is created from an
 *    incident. If it threw, the user would lose the article they asked for
 *    because of a bookkeeping link; so it must swallow the failure and answer
 *    `false`, and it must always release the session.
 *  - `coperturaPerCategoria` feeds the "recurring category without an article"
 *    proposal. Categories with ZERO articles must come back (that is the only
 *    row that matters), the counts of articles with/without origin must add up,
 *    and every read must be anchored to the tenant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const run = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
const getSession = vi.fn((..._a: unknown[]) => ({ run, close }))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: (...a: unknown[]) => getSession(...a),
  toNumber: (v: unknown) => Number(v ?? 0),
}))

const { collegaArticoloAIncident, coperturaPerCategoria, coperturaLeggibile } = await import('../kbCoverage.js')

const rec = (m: Record<string, unknown>) => ({ get: (k: string) => m[k] })

beforeEach(() => { vi.clearAllMocks() })

describe('collegaArticoloAIncident', () => {
  it('returns true when the relationship was created, on a WRITE session scoped to the tenant', async () => {
    run.mockResolvedValueOnce({ summary: { counters: { updates: () => ({ relationshipsCreated: 1 }) } } })
    await expect(collegaArticoloAIncident('t1', 'kb-1', 'inc-1')).resolves.toBe(true)
    expect(getSession).toHaveBeenCalledWith(undefined, 'WRITE')
    expect(run.mock.calls[0]![1]).toEqual({ tenantId: 't1', articleId: 'kb-1', incidentId: 'inc-1' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('returns false when the link already existed (MERGE created nothing)', async () => {
    // A second draft from the same incident is not a new fact.
    run.mockResolvedValueOnce({ summary: { counters: { updates: () => ({ relationshipsCreated: 0 }) } } })
    await expect(collegaArticoloAIncident('t1', 'kb-1', 'inc-1')).resolves.toBe(false)
  })

  it('never throws: a database failure answers false and the session is still closed', async () => {
    run.mockRejectedValueOnce(new Error('neo4j down'))
    await expect(collegaArticoloAIncident('t1', 'kb-1', 'inc-1')).resolves.toBe(false)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('coperturaPerCategoria', () => {
  it('maps every category (uncovered ones included) and splits articles by origin', async () => {
    run
      .mockResolvedValueOnce({ records: [
        rec({ category: 'network', incidenti: 40, articoli: 0 }),
        rec({ category: 'email',   incidenti: 12, articoli: 2 }),
      ] })
      .mockResolvedValueOnce({ records: [rec({ totali: 10, conOrigine: 3 })] })

    const now = Date.parse('2026-09-22T00:00:00.000Z')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const c = await coperturaPerCategoria('t1', 30)
    vi.mocked(Date.now).mockRestore()

    expect(c).toEqual({
      categorie: [
        { category: 'network', incidenti: 40, articoli: 0 },
        { category: 'email',   incidenti: 12, articoli: 2 },
      ],
      articoliConOrigine: 3,
      articoliSenzaOrigine: 7,
      finestraGiorni: 30,
    })
    expect(coperturaLeggibile(c)).toBe(true)
    // The window is measured back from now, in days.
    expect(run.mock.calls[0]![1]).toEqual({ tenantId: 't1', da: new Date(now - 30 * 86_400_000).toISOString() })
    // The zero-article categories survive only with an OPTIONAL MATCH.
    expect(String(run.mock.calls[0]![0])).toContain('OPTIONAL MATCH (a:KBArticle {tenant_id: $tenantId})')
    expect(run.mock.calls[1]![1]).toEqual({ tenantId: 't1' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('defaults to a 90-day window and treats an empty origin read as zero, not unknown-crash', async () => {
    run.mockResolvedValueOnce({ records: [] }).mockResolvedValueOnce({ records: [] })
    const c = await coperturaPerCategoria('t1')
    expect(c).toEqual({ categorie: [], articoliConOrigine: 0, articoliSenzaOrigine: 0, finestraGiorni: 90 })
    // With no article declaring an origin, coverage is "not known", not "zero".
    expect(coperturaLeggibile(c)).toBe(false)
  })

  it('closes the session even when a read fails', async () => {
    run.mockRejectedValueOnce(new Error('boom'))
    await expect(coperturaPerCategoria('t1')).rejects.toThrow('boom')
    expect(close).toHaveBeenCalledTimes(1)
  })
})
