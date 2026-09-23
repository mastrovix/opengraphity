/**
 * CLIENT-SIDE FILTERS: the edges `filterGroup.test.ts` does not walk.
 *
 * A row without the value a rule looks at is EMPTY text, not «null» or
 * «undefined» (which would match «contains "null"»); a row without a date is
 * never «today»; and a group with no rule at all keeps every row.
 */
import { describe, it, expect } from 'vitest'
import type { FilterRule } from '@/components/FilterBuilder'
import { matchesFilterGroup } from './filterGroup'

const rule = (over: Partial<FilterRule>): FilterRule => ({ id: 'r', field: 'assignee', operator: 'contains', value: '', logic: 'AND', ...over })

describe('matchesFilterGroup', () => {
  it('a missing value reads as empty text', () => {
    const row = { assignee: null, title: undefined }
    expect(matchesFilterGroup(row, { rules: [rule({ operator: 'contains', value: 'null' })] })).toBe(false)
    expect(matchesFilterGroup(row, { rules: [rule({ field: 'title', operator: 'contains', value: 'undefined' })] })).toBe(false)
    expect(matchesFilterGroup(row, { rules: [rule({ operator: 'equals', value: '' })] })).toBe(true)
    expect(matchesFilterGroup(row, { rules: [rule({ operator: 'not_equals', value: 'Anna' })] })).toBe(true)
  })

  it('a row without a date, or with a date that is not one, is never «today»', () => {
    expect(matchesFilterGroup({ dueAt: null }, { rules: [rule({ field: 'dueAt', operator: 'today' })] })).toBe(false)
    expect(matchesFilterGroup({ dueAt: 'soon' }, { rules: [rule({ field: 'dueAt', operator: 'today' })] })).toBe(false)
    expect(matchesFilterGroup({ dueAt: new Date().toISOString() }, { rules: [rule({ field: 'dueAt', operator: 'today' })] })).toBe(true)
  })

  it('no group, or a group with no rule, keeps every row', () => {
    expect(matchesFilterGroup({ a: 1 }, null)).toBe(true)
    expect(matchesFilterGroup({ a: 1 }, undefined)).toBe(true)
    expect(matchesFilterGroup({ a: 1 }, { rules: [] })).toBe(true)
  })
})
