/**
 * Every way a `?f=` rule can be malformed must decode to 'invalid'. A shared
 * link whose rule lost its field, carries an unknown operator or a non-string
 * second bound would otherwise be applied half-way (or not at all) and show
 * more rows than the sender saw — silently.
 */
import { describe, it, expect } from 'vitest'
import { decodeFilterGroup, encodeFilterGroup } from './filterGroupUrl'
import type { FilterGroup } from '@/components/FilterBuilder'

const good = { id: 'r1', field: 'title', operator: 'contains', value: 'Disk', logic: 'AND' }

/** Encodes an arbitrary (possibly malformed) payload the way the page would. */
const encodeRaw = (rules: unknown[]) => encodeFilterGroup({ rules } as unknown as FilterGroup)

describe('decodeFilterGroup — rule validation', () => {
  it.each([
    ['a null rule', null],
    ['a primitive rule', 'contains'],
    ['an empty id', { ...good, id: '' }],
    ['a missing field', { ...good, field: undefined }],
    ['an empty field', { ...good, field: '' }],
    ['an unknown operator', { ...good, operator: 'like' }],
    ['an inherited property as operator', { ...good, operator: 'toString' }],
    ['an unknown logic', { ...good, logic: 'XOR' }],
    ['a numeric second bound', { ...good, operator: 'between', value2: 5 }],
    ['a numeric value', { ...good, value: 5 }],
    ['a list with a non-string entry', { ...good, operator: 'in', value: ['a', 1] }],
  ])('%s makes the whole group invalid', (_label, badRule) => {
    expect(decodeFilterGroup(encodeRaw([good, badRule]))).toBe('invalid')
  })

  it('accepts a null value and a string second bound', () => {
    const rules = [
      { ...good, operator: 'is_empty', value: null },
      { ...good, id: 'r2', operator: 'between', value: '2026-01-01', value2: '2026-02-01', logic: 'OR' },
    ]
    expect(decodeFilterGroup(encodeRaw(rules))).toEqual({ rules })
  })

  it('a JSON payload that is not an object, or has no rules, is invalid', () => {
    const b64 = (s: string) => btoa(s).replace(/=+$/, '')
    expect(decodeFilterGroup(b64('42'))).toBe('invalid')
    expect(decodeFilterGroup(b64('null'))).toBe('invalid')
    expect(decodeFilterGroup(b64('{"rules":[]}'))).toBe('invalid')
    expect(decodeFilterGroup(b64('{"rules":"x"}'))).toBe('invalid')
  })
})
