/**
 * The customer's own ticket fields travel through these helpers on every
 * create and edit form. If the definitions stopped hiding system fields or lost
 * their order, the form would show product fields as editable; if the creation
 * list dropped `editable: false` rows, a user could fill a field the API then
 * rejects; if empty values were sent as "" instead of null, a cleared field
 * would be stored as a blank string and still count as "filled".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { TFunction } from 'i18next'

const useQueryMock = vi.fn()
vi.mock('@apollo/client/react', () => ({ useQuery: (...args: unknown[]) => useQueryMock(...args) }))

import {
  useTicketCustomFieldDefs, useCreationCustomFieldDefs,
  customFieldsInput, customFieldValuesMap, missingCustomFields, customFieldDisplay,
  type CustomFieldDefView,
} from './customFields'

const def = (over: Partial<CustomFieldDefView> = {}): CustomFieldDefView => ({
  name: 'f', label: 'F', fieldType: 'string', required: false, enumValues: [], enumTypeName: null, visibleToEndUser: false, ...over,
})

beforeEach(() => { useQueryMock.mockReset() })

describe('useTicketCustomFieldDefs', () => {
  it('keeps only the customer fields of the requested type, ordered by order then name, with defaults filled in', () => {
    useQueryMock.mockReturnValue({
      loading: false, error: undefined,
      data: { itilTypes: [
        { name: 'problem', fields: [{ name: 'other', label: 'O', fieldType: 'string', required: false, isSystem: false, order: 0 }] },
        { name: 'incident', fields: [
          { name: 'title', label: 'Title', fieldType: 'string', required: true, isSystem: true, order: 0 },
          { name: 'zeta', label: '', fieldType: 'string', required: false, isSystem: false, order: 2 },
          { name: 'beta', label: 'Beta', fieldType: 'enum', required: true, isSystem: false, order: 1, enumValues: ['a'], enumTypeName: 'voc', visibleToEndUser: true },
          { name: 'alpha', label: 'Alpha', fieldType: 'string', required: false, isSystem: false, order: 2 },
        ] },
      ] },
    })
    const { result } = renderHook(() => useTicketCustomFieldDefs('incident'))
    expect(result.current.defs.map((d) => d.name)).toEqual(['beta', 'alpha', 'zeta'])
    // An empty label falls back to the field name so the form never shows a blank caption.
    expect(result.current.defs[2]).toMatchObject({ label: 'zeta', enumValues: [], enumTypeName: null, visibleToEndUser: false })
    expect(result.current.defs[0]).toMatchObject({ enumValues: ['a'], enumTypeName: 'voc', visibleToEndUser: true })
  })

  it('an unknown type or no data yet gives no fields, and passes loading/error through', () => {
    const error = new Error('boom')
    useQueryMock.mockReturnValue({ loading: true, error, data: undefined })
    const { result } = renderHook(() => useTicketCustomFieldDefs('change'))
    expect(result.current).toEqual({ defs: [], loading: true, error })
  })
})

describe('useCreationCustomFieldDefs', () => {
  it('drops the fields not editable in the initial step and asks the API with a null category when none is chosen', () => {
    useQueryMock.mockReturnValue({
      loading: false, error: undefined,
      data: { ticketCreationCustomFields: [
        { name: 'a', label: '', fieldType: 'string', required: true, value: null, editable: true },
        { name: 'b', label: 'B', fieldType: 'string', required: false, value: null, editable: false },
        { name: 'c', label: 'C', fieldType: 'enum', required: false, value: null, enumValues: ['x'], enumTypeName: 'v', visibleToEndUser: true },
      ] },
    })
    const { result } = renderHook(() => useCreationCustomFieldDefs('incident', ''))
    expect(result.current.defs.map((d) => d.name)).toEqual(['a', 'c'])
    expect(result.current.defs[0]).toMatchObject({ label: 'a', enumValues: [], enumTypeName: null, visibleToEndUser: false })
    expect(result.current.defs[1]).toMatchObject({ enumValues: ['x'], enumTypeName: 'v', visibleToEndUser: true })
    // "" is not a category: the API must pick the generic workflow.
    expect(useQueryMock.mock.calls[0][1].variables).toEqual({ entityType: 'incident', category: null })
  })

  it('while a new category loads, keeps the previous fields instead of emptying the form', () => {
    useQueryMock.mockReturnValue({
      loading: true, error: undefined, data: undefined,
      previousData: { ticketCreationCustomFields: [{ name: 'kept', label: 'Kept', fieldType: 'string', required: false, value: null }] },
    })
    const { result } = renderHook(() => useCreationCustomFieldDefs('problem', 'network'))
    expect(result.current.defs.map((d) => d.name)).toEqual(['kept'])
    expect(useQueryMock.mock.calls[0][1].variables).toEqual({ entityType: 'problem', category: 'network' })
  })

  it('with neither data nor previous data there are no fields', () => {
    useQueryMock.mockReturnValue({ loading: true, error: undefined, data: undefined, previousData: undefined })
    const { result } = renderHook(() => useCreationCustomFieldDefs('service_request'))
    expect(result.current.defs).toEqual([])
  })
})

describe('customFieldsInput / customFieldValuesMap', () => {
  it('sends every form field, trimmed, with blanks as null', () => {
    const defs = [def({ name: 'a' }), def({ name: 'b' }), def({ name: 'c' })]
    expect(customFieldsInput(defs, { a: '  x ', b: '   ' })).toEqual([
      { name: 'a', value: 'x' }, { name: 'b', value: null }, { name: 'c', value: null },
    ])
  })

  it('turns null values into empty strings for the edit form', () => {
    expect(customFieldValuesMap([
      { ...def({ name: 'a' }), value: 'v' }, { ...def({ name: 'b' }), value: null },
    ])).toEqual({ a: 'v', b: '' })
  })
})

describe('missingCustomFields', () => {
  it('reports required fields left blank, including those made required by a rule, but not hidden ones', () => {
    const defs = [def({ name: 'req', required: true }), def({ name: 'byRule' }), def({ name: 'hidden', required: true }), def({ name: 'filled', required: true }), def({ name: 'optional' })]
    const missing = missingCustomFields(defs, { filled: 'x', req: '  ' }, {
      byRule: { visible: true, required: true } as never,
      hidden: { visible: false } as never,
    })
    expect(missing).toEqual(['req', 'byRule'])
  })

  it('without rules, only the metamodel obligation counts', () => {
    expect(missingCustomFields([def({ name: 'a', required: true })], {})).toEqual(['a'])
  })
})

describe('customFieldDisplay', () => {
  const t = ((k: string) => `t:${k}`) as unknown as TFunction
  const labelOf = (voc: string, v: string) => (voc === 'voc' && v === 'known' ? 'Known label' : null)

  it('shows a dash for an empty value', () => {
    expect(customFieldDisplay({ fieldType: 'string', enumTypeName: null, value: null }, labelOf, t)).toBe('—')
    expect(customFieldDisplay({ fieldType: 'string', enumTypeName: null, value: '' }, labelOf, t)).toBe('—')
  })

  it('an enum shows the vocabulary label, or the raw value when the label is unknown', () => {
    expect(customFieldDisplay({ fieldType: 'enum', enumTypeName: 'voc', value: 'known' }, labelOf, t)).toBe('Known label')
    expect(customFieldDisplay({ fieldType: 'enum', enumTypeName: 'voc', value: 'gone' }, labelOf, t)).toBe('gone')
  })

  it('a boolean is translated yes/no', () => {
    expect(customFieldDisplay({ fieldType: 'boolean', enumTypeName: null, value: 'true' }, labelOf, t)).toBe('t:common.yes')
    expect(customFieldDisplay({ fieldType: 'boolean', enumTypeName: null, value: 'false' }, labelOf, t)).toBe('t:common.no')
  })

  it('a date is formatted, anything else is shown as is', () => {
    const shown = customFieldDisplay({ fieldType: 'date', enumTypeName: null, value: '2026-03-04' }, labelOf, t)
    expect(shown).not.toBe('2026-03-04')
    expect(shown).toMatch(/2026/)
    expect(customFieldDisplay({ fieldType: 'string', enumTypeName: null, value: 'plain' }, labelOf, t)).toBe('plain')
  })
})
