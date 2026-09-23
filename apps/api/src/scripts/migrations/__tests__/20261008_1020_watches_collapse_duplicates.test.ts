/**
 * Migration 20261008_1020: duplicate WATCHES edges between the same person
 * and ticket are folded into one.
 *
 * What matters: only pairs with more than one edge, the earliest watched_at
 * is the one kept, and it says per tenant what it removed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { watchesCollapseDuplicates } = await import('../20261008_1020_watches_collapse_duplicates.js')
const { MIGRATIONS } = await import('../index.js')

let lines: string[] = []
beforeEach(() => {
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
})

describe('20261008_1020_watches_collapse_duplicates', () => {
  it('is registered right after 20261008_1010', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20261008_1020_watches_collapse_duplicates'))
      .toBe(ids.indexOf('20261008_1010_incident_confirm_resolution') + 1)
  })

  it('touches only doubled pairs, keeps the earliest edge, and counts per tenant', async () => {
    const rows = [{ tenant: 'c-one', pairs: 3, removed: 7 }, { tenant: 'c-two', pairs: 1, removed: 1 }]
    const run = vi.fn(async (_cypher: string) => ({ records: rows.map((r) => ({ get: (k: string) => r[k as keyof typeof r] })) }))
    await watchesCollapseDuplicates.up({ run } as never)
    const q = String(run.mock.calls[0]![0])
    expect(q).toContain('WHERE size(edges) > 1')
    expect(q).toContain('x.watched_at < first.watched_at')
    expect(q).toContain('WHERE d <> keep] | DELETE x')
    expect(lines).toContain('[20261008_1020_watches_collapse_duplicates] c-one: 3 person-ticket pairs, 7 duplicate edges removed')
    expect(lines.at(-1)).toBe('[20261008_1020_watches_collapse_duplicates] 8 duplicate WATCHES edges removed')
  })
})
