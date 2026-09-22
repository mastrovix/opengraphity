/**
 * The fields a workflow step may write, read from the tenant's metamodel.
 *
 * Why these behaviours matter:
 *  - `stepFieldMetas` is the list the step designer validates against: a field
 *    the customer added to a ticket type must be writable, and a ticket type
 *    that does not exist must yield NO field (so every write is refused with
 *    "not in the metamodel" instead of passing unchecked).
 *  - Missing metadata (no field type, no vocabulary) must become safe empty
 *    values, not `undefined` that would crash the switch in the validator.
 *  - A plain text field keeps the value as written (untrimmed): the admin's
 *    text is the ticket's text.
 */
import { describe, it, expect, vi } from 'vitest'

const loadITILTypes = vi.fn()
vi.mock('../itilTypes.js', () => ({ loadITILTypes: (...a: unknown[]) => loadITILTypes(...a) }))

const { stepFieldMetas, assertStepFieldValue } = await import('../stepFieldWrites.js')

const session = {} as never

describe('stepFieldMetas', () => {
  it('returns the fields of the requested ticket type only, read for the caller tenant', async () => {
    loadITILTypes.mockResolvedValue([
      { name: 'incident', fields: [
        { name: 'severity', fieldType: 'enum', enumValues: ['low', 'high'], enumTypeName: 'severity' },
        { name: 'notes' },
      ] },
      { name: 'change', fields: [{ name: 'outcome', fieldType: 'enum', enumValues: ['ok'], enumTypeName: 'o' }] },
    ])
    const metas = await stepFieldMetas(session, 't1', 'incident')
    expect(loadITILTypes).toHaveBeenCalledWith(session, 't1')
    expect([...metas.keys()]).toEqual(['severity', 'notes'])
    expect(metas.get('severity')).toEqual({ name: 'severity', fieldType: 'enum', enumValues: ['low', 'high'], enumTypeName: 'severity' })
    // Missing metadata becomes safe empties, not undefined.
    expect(metas.get('notes')).toEqual({ name: 'notes', fieldType: '', enumValues: [], enumTypeName: null })
  })

  it('an unknown ticket type has no writable field', async () => {
    loadITILTypes.mockResolvedValue([{ name: 'incident', fields: [{ name: 'severity' }] }])
    expect((await stepFieldMetas(session, 't1', 'problem')).size).toBe(0)
  })
})

describe('assertStepFieldValue — free-text fields', () => {
  it('keeps the value exactly as written', () => {
    const metas = new Map([['notes', { name: 'notes', fieldType: 'string', enumValues: [], enumTypeName: null }]])
    expect(assertStepFieldValue(metas, 'incident', 'notes', '  see runbook ', 'step "Triage"', { allowTemplate: false }))
      .toBe('  see runbook ')
  })
})
