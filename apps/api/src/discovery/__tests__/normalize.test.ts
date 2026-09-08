import { describe, it, expect } from 'vitest'
import { NormalizeError, normalizeKeys, splitList, toBool, toNum, toSnake } from '../connectors/normalize.js'
import { FIELD_NAME_RE } from '../../lib/cypherIdentifiers.js'

describe('toSnake', () => {
  it.each([
    ['cost_center',             'cost_center'],
    ['Cost Center',             'cost_center'],
    ['costCenter',              'cost_center'],
    ['CostCenter',              'cost_center'],
    ['HTTPServer',              'http_server'],
    ['app.kubernetes.io/name',  'app_kubernetes_io_name'],
    ['  Owner-Team  ',          'owner_team'],
    ['aws:cloudformation:stack','aws_cloudformation_stack'],
    ['IP Address v4',           'ip_address_v4'],
    ['__weird__',               'weird'],
    ['a  b',                    'a_b'],
    ['2ndOwner',                'f_2nd_owner'],
    ['42',                      'f_42'],
    ['Ünïcode Key',             'n_code_key'],
  ])('normalizes %j → %j', (input, expected) => {
    const out = toSnake(input)
    expect(out).toBe(expected)
    expect(out).toMatch(FIELD_NAME_RE)
  })

  it('fails loudly when nothing usable is left', () => {
    expect(() => toSnake('###')).toThrow(NormalizeError)
    expect(() => toSnake('')).toThrow(NormalizeError)
    expect(() => toSnake('   ')).toThrow(/impossibile derivare/)
  })

  it('rejects non-string keys', () => {
    expect(() => toSnake(42 as unknown as string)).toThrow(NormalizeError)
  })
})

describe('normalizeKeys', () => {
  it('normalizes every key and keeps values untouched', () => {
    expect(normalizeKeys({ 'Cost Center': 'A1', ipAddress: '10.0.0.1', n: 3 }, 'test'))
      .toEqual({ cost_center: 'A1', ip_address: '10.0.0.1', n: 3 })
  })

  it('throws on collisions instead of overwriting silently', () => {
    expect(() => normalizeKeys({ 'Cost Center': 'A', costCenter: 'B' }, 'csv header row'))
      .toThrow(/csv header row: le chiavi "Cost Center" e "costCenter" collidono su "cost_center"/)
  })

  it('prefixes the source in the error for unusable keys', () => {
    expect(() => normalizeKeys({ '!!!': 1 }, '[json] item 0')).toThrow(/^\[json\] item 0: toSnake/)
  })

  it('returns an empty object for an empty input', () => {
    expect(normalizeKeys({}, 'x')).toEqual({})
  })
})

describe('toNum', () => {
  it('returns undefined only for absent values', () => {
    expect(toNum(null)).toBeUndefined()
    expect(toNum(undefined)).toBeUndefined()
    expect(toNum('')).toBeUndefined()
    expect(toNum('   ')).toBeUndefined()
  })

  it('converts numbers, bigint, numeric strings and neo4j Integer', () => {
    expect(toNum(7)).toBe(7)
    expect(toNum(12n)).toBe(12)
    expect(toNum(' 3.5 ')).toBe(3.5)
    expect(toNum('-2')).toBe(-2)
    expect(toNum('1e3')).toBe(1000)
    expect(toNum({ toNumber: () => 9 })).toBe(9)
  })

  it('throws for non-numeric input (no silent 0)', () => {
    expect(() => toNum('abc')).toThrow(NormalizeError)
    expect(() => toNum('10.0.0.1')).toThrow(NormalizeError)
    expect(() => toNum(NaN)).toThrow(NormalizeError)
    expect(() => toNum(Infinity)).toThrow(NormalizeError)
    expect(() => toNum({})).toThrow(NormalizeError)
    expect(() => toNum(true)).toThrow(NormalizeError)
  })
})

describe('toBool', () => {
  it('returns undefined only for absent values', () => {
    expect(toBool(null)).toBeUndefined()
    expect(toBool(undefined)).toBeUndefined()
    expect(toBool('')).toBeUndefined()
  })

  it('accepts booleans and "true"/"false" strings', () => {
    expect(toBool(true)).toBe(true)
    expect(toBool(false)).toBe(false)
    expect(toBool(' TRUE ')).toBe(true)
    expect(toBool('false')).toBe(false)
  })

  it('throws for anything else', () => {
    expect(() => toBool('yes')).toThrow(NormalizeError)
    expect(() => toBool('1')).toThrow(NormalizeError)
    expect(() => toBool(1)).toThrow(NormalizeError)
  })
})

describe('splitList', () => {
  it('splits comma-separated strings, trimming and dropping empties', () => {
    expect(splitList(' a, b ,,c ')).toEqual(['a', 'b', 'c'])
  })
  it('accepts arrays of strings', () => {
    expect(splitList([' a ', '', 'b'])).toEqual(['a', 'b'])
  })
  it('returns [] for absent values', () => {
    expect(splitList(undefined)).toEqual([])
    expect(splitList(null)).toEqual([])
    expect(splitList('')).toEqual([])
  })
  it('throws for other types', () => {
    expect(() => splitList(3)).toThrow(NormalizeError)
    expect(() => splitList([1])).toThrow(NormalizeError)
  })
})
