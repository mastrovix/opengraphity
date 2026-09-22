/**
 * The per-form cap and the library count, read through a fake Neo4j session.
 *
 * Why it matters: the cap on fields per form is checked when a form is SAVED.
 * If the comparison drifted (>= instead of >), an admin could no longer save a
 * form with exactly the allowed number of fields; if it disappeared, a form of
 * hundreds of fields would reach the portal and nobody would fill it in. The
 * numbers coming from Neo4j can be Integer-like or strings: the limits must be
 * plain numbers for the comparison to be right.
 */
import { describe, it, expect } from 'vitest'
import { assertFormSize, assertLibraryRoom, catalogFormLimits } from '../catalogFormLimits.js'

type Row = Record<string, unknown>
const record = (row: Row) => ({ get: (k: string) => row[k], keys: Object.keys(row), toObject: () => row })
/** A session that answers each query in turn with the given rows (null = no record). */
const sessionAnswering = (...rows: (Row | null)[]) => {
  let i = 0
  return { run: async () => { const row = rows[i++]; return { records: row == null ? [] : [record(row)] } } }
}
const LIMITS = { maxLibraryFields: 120, maxFieldsPerForm: 5, maxTableRows: 50 }

describe('catalogFormLimits', () => {
  it('returns plain numbers even when the driver hands back strings', async () => {
    const s = sessionAnswering({ maxLibraryFields: '120', maxFieldsPerForm: '60', maxTableRows: '50' })
    await expect(catalogFormLimits(s as never, 't1')).resolves.toEqual({ maxLibraryFields: 120, maxFieldsPerForm: 60, maxTableRows: 50 })
  })
})

describe('assertFormSize', () => {
  it('accepts a form exactly at the cap (the cap is inclusive)', async () => {
    await expect(assertFormSize(sessionAnswering(LIMITS) as never, 't1', 5)).resolves.toBeUndefined()
  })

  it('rejects one field over the cap with the count, the cap and the i18n key', async () => {
    const err = await assertFormSize(sessionAnswering(LIMITS) as never, 't1', 6).catch((e: unknown) => e)
    expect((err as Error).message).toMatch(/This form has 6 fields: 5 is the limit/)
    expect((err as { extensions: Record<string, unknown> }).extensions).toMatchObject({
      code: 'BAD_USER_INPUT',
    })
    expect(JSON.stringify((err as { extensions: unknown }).extensions)).toContain('errors.catalogForm.tooManyFields')
  })

  it('an unmigrated tenant fails loudly instead of accepting any size', async () => {
    await expect(assertFormSize(sessionAnswering({ maxLibraryFields: null, maxFieldsPerForm: null, maxTableRows: null }) as never, 't1', 1))
      .rejects.toThrow(/20261003_1020_catalog_form_limits/)
  })
})

describe('assertLibraryRoom', () => {
  it('lets a field in while there is room, and treats a missing count row as zero', async () => {
    await expect(assertLibraryRoom(sessionAnswering(LIMITS, { n: 119 }) as never, 't1')).resolves.toBeUndefined()
    await expect(assertLibraryRoom(sessionAnswering(LIMITS, null) as never, 't1')).resolves.toBeUndefined()
  })
})
