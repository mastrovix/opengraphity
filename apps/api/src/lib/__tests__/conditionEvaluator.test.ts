/**
 * The shared condition evaluator behind AutoTriggers and BusinessRules.
 *
 * Why these behaviours matter: every failure mode here is SILENT for the
 * admin. A rule whose condition is wrongly false never fires; one wrongly true
 * fires on every ticket. So the contracts pinned below are:
 *  - values saved by the UI as strings match typed ticket values (boolean,
 *    number), while two different shapes (a list vs one value) never "equal";
 *  - empty strings count as null for is_null / is_not_null (a cleared field);
 *  - "changed" only looks at the fields the update actually changed;
 *  - an unknown operator or a corrupt JSON payload throws, because returning
 *    "no conditions" would make the rule match everything.
 */
import { describe, it, expect } from 'vitest'
import {
  CHANGED_FIELDS_KEY, evaluateConditions, parseConditions, sameValue, usesChangedOperator, type Condition,
} from '../conditionEvaluator.js'

describe('sameValue', () => {
  it('matches booleans against "true"/"false" as saved by the UI, case and space insensitive', () => {
    expect(sameValue(true, ' TRUE ')).toBe(true)
    expect(sameValue(false, 'false')).toBe(true)
    expect(sameValue(true, 'false')).toBe(false)
  })

  it('matches numbers against the written number, never against a non-number', () => {
    expect(sameValue(1200, ' 1200 ')).toBe(true)
    expect(sameValue(1200, '1200.5')).toBe(false)
    expect(sameValue(0, 'abc')).toBe(false)
  })

  it('null on either side is never equal to a value; identical values always are', () => {
    expect(sameValue(null, 'x')).toBe(false)
    expect(sameValue('x', undefined)).toBe(false)
    expect(sameValue(null, null)).toBe(true)
    expect(sameValue('high', 'high')).toBe(true)
  })

  it('a list is not "equal" to a single value: membership is the job of contains', () => {
    expect(sameValue(['a'], 'a')).toBe(false)
    expect(sameValue('a', 'b')).toBe(false)
  })
})

describe('evaluateConditions', () => {
  const ticket = { priority: 'high', impact: 3, title: 'Disk full on db-1', tags: [1200, 5], empty: '', urgent: true }
  const c = (field: string, operator: Condition['operator'], value?: unknown): Condition => ({ field, operator, value })

  it('no conditions always match', () => {
    expect(evaluateConditions([], ticket)).toBe(true)
  })

  it('equals / not_equals use the typed comparison', () => {
    expect(evaluateConditions([c('urgent', 'equals', 'true')], ticket)).toBe(true)
    expect(evaluateConditions([c('priority', 'not_equals', 'low')], ticket)).toBe(true)
    expect(evaluateConditions([c('priority', 'not_equals', 'high')], ticket)).toBe(false)
  })

  it('is_null / is_not_null treat an empty string as empty', () => {
    expect(evaluateConditions([c('empty', 'is_null'), c('missing', 'is_null')], ticket)).toBe(true)
    expect(evaluateConditions([c('empty', 'is_not_null')], ticket)).toBe(false)
    expect(evaluateConditions([c('priority', 'is_not_null')], ticket)).toBe(true)
  })

  it('greater_than / less_than compare numerically, also against string thresholds', () => {
    expect(evaluateConditions([c('impact', 'greater_than', '2'), c('impact', 'less_than', 4)], ticket)).toBe(true)
    expect(evaluateConditions([c('impact', 'greater_than', 3)], ticket)).toBe(false)
  })

  it('contains works on text and on multi-value lists (typed membership)', () => {
    expect(evaluateConditions([c('title', 'contains', 'db-1')], ticket)).toBe(true)
    expect(evaluateConditions([c('tags', 'contains', '1200')], ticket)).toBe(true)
    expect(evaluateConditions([c('tags', 'contains', '7')], ticket)).toBe(false)
    // A number field is neither text nor list: never "contains".
    expect(evaluateConditions([c('impact', 'contains', '3')], ticket)).toBe(false)
  })

  it('changed looks only at the fields the update changed', () => {
    const updated = { ...ticket, [CHANGED_FIELDS_KEY]: ['priority'] }
    expect(evaluateConditions([c('priority', 'changed')], updated)).toBe(true)
    expect(evaluateConditions([c('impact', 'changed')], updated)).toBe(false)
    // No change list (e.g. a create event): nothing has "changed".
    expect(evaluateConditions([c('priority', 'changed')], ticket)).toBe(false)
  })

  it('and requires all, or requires one', () => {
    const conds = [c('priority', 'equals', 'high'), c('impact', 'equals', '9')]
    expect(evaluateConditions(conds, ticket, 'and')).toBe(false)
    expect(evaluateConditions(conds, ticket, 'or')).toBe(true)
  })

  it('an unknown operator throws instead of silently inverting the rule', () => {
    expect(() => evaluateConditions([c('priority', 'bogus' as Condition['operator'])], ticket))
      .toThrow('Unknown condition operator: bogus (field: priority)')
  })
})

describe('usesChangedOperator', () => {
  it('detects rules that only make sense on update events', () => {
    expect(usesChangedOperator([{ field: 'a', operator: 'equals' }, { field: 'b', operator: 'changed' }])).toBe(true)
    expect(usesChangedOperator([{ field: 'a', operator: 'equals' }])).toBe(false)
  })
})

describe('parseConditions', () => {
  it('empty or missing payload means no conditions', () => {
    expect(parseConditions(null)).toEqual([])
    expect(parseConditions(undefined)).toEqual([])
    expect(parseConditions('')).toEqual([])
  })

  it('parses an array payload', () => {
    expect(parseConditions('[{"field":"a","operator":"equals","value":"x"}]')).toEqual([{ field: 'a', operator: 'equals', value: 'x' }])
  })

  it('corrupt JSON throws with the cause attached, never returns "no conditions"', () => {
    let err: unknown
    try { parseConditions('[{') } catch (e) { err = e }
    expect((err as Error).message).toMatch(/^Corrupt conditions JSON: /)
    expect((err as Error).cause).toBeInstanceOf(SyntaxError)
  })

  it('a non-array payload throws and names what it got', () => {
    expect(() => parseConditions('{"field":"a"}')).toThrow('Conditions payload is not an array (got object)')
    expect(() => parseConditions('42')).toThrow('(got number)')
  })
})
