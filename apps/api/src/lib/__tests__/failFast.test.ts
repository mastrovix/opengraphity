/**
 * Fail-fast contract tests — these pin the NO-FALLBACK behaviour introduced by
 * the fallback remediation. If any of these start failing because someone
 * reintroduced a silent default, that is a regression, not a test to relax.
 */
import { describe, it, expect } from 'vitest'
import { parseConditions, evaluateConditions, type Condition } from '../conditionEvaluator.js'
import { parseActions } from '../actionExecutor.js'
import { buildAdvancedWhere } from '../filterBuilder.js'

describe('parseConditions (fail-fast)', () => {
  it('parses valid conditions', () => {
    const c = parseConditions('[{"field":"status","operator":"equals","value":"open"}]')
    expect(c).toHaveLength(1)
    expect(c[0].field).toBe('status')
  })

  it('returns [] for null/empty input (legitimately no conditions)', () => {
    expect(parseConditions(null)).toEqual([])
    expect(parseConditions(undefined)).toEqual([])
    expect(parseConditions('')).toEqual([])
  })

  it('THROWS on corrupt JSON — must not become "always matches"', () => {
    expect(() => parseConditions('{not json')).toThrow(/Corrupt conditions JSON/)
  })

  it('THROWS on non-array payload', () => {
    expect(() => parseConditions('{"field":"x"}')).toThrow(/not an array/)
  })
})

describe('evaluateConditions (fail-fast)', () => {
  it('THROWS on unknown operator instead of silently returning false', () => {
    const bad = [{ field: 'status', operator: 'matches_regex', value: '.*' }] as unknown as Condition[]
    expect(() => evaluateConditions(bad, { status: 'open' })).toThrow(/Unknown condition operator/)
  })

  it('still evaluates known operators', () => {
    const c: Condition[] = [{ field: 'status', operator: 'equals', value: 'open' }]
    expect(evaluateConditions(c, { status: 'open' })).toBe(true)
    expect(evaluateConditions(c, { status: 'closed' })).toBe(false)
  })
})

describe('parseActions (fail-fast)', () => {
  it('THROWS on corrupt JSON — a matched rule must not silently run zero actions', () => {
    expect(() => parseActions('{oops')).toThrow(/Corrupt actions JSON/)
  })

  it('THROWS on non-array payload', () => {
    expect(() => parseActions('"set_field"')).toThrow(/not an array/)
  })

  it('returns [] for null input', () => {
    expect(parseActions(null)).toEqual([])
  })
})

describe('buildAdvancedWhere (fail-fast)', () => {
  const allowed = new Set(['status', 'severity'])

  it('builds WHERE for valid filters', () => {
    const params: Record<string, unknown> = {}
    const where = buildAdvancedWhere(
      '{"rules":[{"field":"status","operator":"equals","value":"open","logic":"AND"}]}',
      params, allowed,
    )
    expect(where).toContain('n.status = $af_0')
    expect(params['af_0']).toBe('open')
  })

  it('THROWS on corrupt filters JSON — must not silently return the full list', () => {
    const params: Record<string, unknown> = {}
    expect(() => buildAdvancedWhere('{broken', params, allowed)).toThrow(/Invalid filters JSON/)
  })

  it('THROWS on a field outside the whitelist instead of dropping the rule', () => {
    const params: Record<string, unknown> = {}
    expect(() => buildAdvancedWhere(
      '{"rules":[{"field":"secret_field","operator":"equals","value":"x","logic":"AND"}]}',
      params, allowed,
    )).toThrow(/not allowed/)
  })

  it('THROWS on an invalid field name (injection guard stays a guard)', () => {
    const params: Record<string, unknown> = {}
    expect(() => buildAdvancedWhere(
      '{"rules":[{"field":"a b; DROP","operator":"equals","value":"x","logic":"AND"}]}',
      params, allowed,
    )).toThrow(/Invalid filter field name/)
  })

  it('THROWS on an unknown operator instead of dropping the rule', () => {
    const params: Record<string, unknown> = {}
    expect(() => buildAdvancedWhere(
      '{"rules":[{"field":"status","operator":"sounds_like","value":"x","logic":"AND"}]}',
      params, allowed,
    )).toThrow(/Unknown filter operator/)
  })
})
