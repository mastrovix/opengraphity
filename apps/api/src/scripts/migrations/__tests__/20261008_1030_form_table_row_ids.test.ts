/**
 * Migration 20261008_1030: every FormTableRow without an id gets one.
 *
 * What matters: only rows without an id, in batches outside the marker's
 * transaction, and it says how many.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { formTableRowIds } = await import('../20261008_1030_form_table_row_ids.js')
const { MIGRATIONS } = await import('../index.js')

let lines: string[] = []
beforeEach(() => {
  lines = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')) })
})

describe('20261008_1030_form_table_row_ids', () => {
  it('is registered right after 20261008_1020, and runs outside the marker transaction', () => {
    const ids = MIGRATIONS.map((m) => m.id)
    expect(ids.indexOf('20261008_1030_form_table_row_ids')).toBe(ids.indexOf('20261008_1020_watches_collapse_duplicates') + 1)
    expect(formTableRowIds.autocommit).toBe(true)
  })

  it('gives an id only to the rows without one, and counts them', async () => {
    const run = vi.fn(async (_cypher: string) => ({ records: [{ get: () => 12736 }] }))
    await formTableRowIds.up({ run } as never)
    const q = String(run.mock.calls[0]![0])
    expect(q).toContain('MATCH (r:FormTableRow) WHERE r.id IS NULL')
    expect(q).toContain('SET r.id = randomUUID()')
    expect(q).toContain('IN TRANSACTIONS OF 5000 ROWS')
    expect(lines.at(-1)).toBe('[20261008_1030_form_table_row_ids] 12736 form table rows got an id')
  })
})
