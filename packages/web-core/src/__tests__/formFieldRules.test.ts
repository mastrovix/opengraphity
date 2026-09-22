/**
 * WHICH FIELDS THE PERSON SEES, AND WHICH ONES THEY MUST FILL IN.
 *
 * Two sets of rules an administrator writes, evaluated in the browser while
 * the form is being filled. The order matters and is not symmetric:
 *
 *   action "show" — the target is HIDDEN by default and appears only when the
 *   trigger matches. Getting the default wrong here leaks a field that was
 *   meant to be conditional.
 *   action "hide" — the target is VISIBLE by default and disappears when the
 *   trigger matches. Getting THAT default wrong hides a field nobody asked to
 *   hide, and the person cannot fill in something they cannot see.
 *
 * And a hidden field is never required, or the form would refuse to submit
 * over a field the person has no way of reaching.
 */
import { describe, it, expect } from 'vitest'
import {
  evalVisibility, evalRequirements, mergeFieldRules, validateFormFields,
} from '../useFormFieldRules.js'

const show = (trigger: string, value: string, target: string) =>
  ({ id: `${trigger}-${target}`, entityType: 'incident', triggerField: trigger, triggerValue: value, targetField: target, action: 'show' as const })
const hide = (trigger: string, value: string, target: string) =>
  ({ ...show(trigger, value, target), action: 'hide' as const })

describe('evalVisibility', () => {
  it('"show": hidden by default, visible when the trigger matches', () => {
    const rules = [show('category', 'hardware', 'serial_number')]
    expect(evalVisibility(rules, {})).toEqual({ serial_number: false })
    expect(evalVisibility(rules, { category: 'software' })).toEqual({ serial_number: false })
    expect(evalVisibility(rules, { category: 'hardware' })).toEqual({ serial_number: true })
  })

  it('"hide": visible by default, hidden when the trigger matches', () => {
    const rules = [hide('category', 'software', 'serial_number')]
    expect(evalVisibility(rules, {})).toEqual({ serial_number: true })
    expect(evalVisibility(rules, { category: 'software' })).toEqual({ serial_number: false })
  })

  it('the trigger value is compared as text: a number and its digits match', () => {
    // The form values come from inputs, which are strings, but a default or
    // a computed value can be a number.
    expect(evalVisibility([show('level', '2', 'escalation')], { level: 2 })).toEqual({ escalation: true })
    expect(evalVisibility([show('flag', 'true', 'x')], { flag: true })).toEqual({ x: true })
  })

  it('an absent trigger value is the empty string, not "undefined"', () => {
    expect(evalVisibility([show('category', '', 'x')], {})).toEqual({ x: true })
    expect(evalVisibility([show('category', 'undefined', 'x')], {})).toEqual({ x: false })
  })

  it('several "show" rules on one field are an OR: any one of them reveals it', () => {
    const rules = [show('category', 'hardware', 'serial'), show('category', 'network', 'serial')]
    expect(evalVisibility(rules, { category: 'network' })).toEqual({ serial: true })
    expect(evalVisibility(rules, { category: 'software' })).toEqual({ serial: false })
  })

  it('a "hide" that matches wins over a "show" that also matches', () => {
    // Hiding is the safer outcome: a field shown by mistake can leak, a
    // field hidden by mistake is visible in the rule list.
    const rules = [show('a', '1', 'f'), hide('b', '1', 'f')]
    expect(evalVisibility(rules, { a: '1', b: '1' })).toEqual({ f: false })
  })

  it('no rules mean no opinion: the field list decides', () => {
    expect(evalVisibility([], { category: 'hardware' })).toEqual({})
  })
})

describe('evalRequirements', () => {
  it('only the rules that require something count', () => {
    expect(evalRequirements([
      { id: '1', entityType: 'incident', fieldName: 'root_cause', workflowStep: 'resolved', required: true },
      { id: '2', entityType: 'incident', fieldName: 'notes', workflowStep: null, required: false },
    ])).toEqual({ root_cause: true })
  })

  it('no rules, nothing required', () => {
    expect(evalRequirements([])).toEqual({})
  })
})

describe('mergeFieldRules', () => {
  it('a field nobody mentions is visible and not required', () => {
    expect(mergeFieldRules({ a: false }, { b: true })).toEqual({
      a: { visible: false, required: false },
      b: { visible: true,  required: true },
    })
  })

  it('a HIDDEN field is never required, whatever the requirement rule says', () => {
    // Otherwise the form refuses to submit over a field the person has no
    // way of reaching, with no way of telling which.
    expect(mergeFieldRules({ serial: false }, { serial: true })).toEqual({ serial: { visible: false, required: false } })
  })

  it('a visible and required field stays both', () => {
    expect(mergeFieldRules({ serial: true }, { serial: true })).toEqual({ serial: { visible: true, required: true } })
  })
})

describe('validateFormFields', () => {
  const rules = {
    title:  { visible: true,  required: true },
    serial: { visible: false, required: true },
    notes:  { visible: true,  required: false },
  }

  it('reports the visible required fields that have no value', () => {
    expect(validateFormFields(rules, {})).toEqual(['title'])
    expect(validateFormFields(rules, { title: 'DB down' })).toEqual([])
  })

  it('whitespace is not a value', () => {
    for (const blank of ['', '   ', '\n\t', null, undefined]) {
      expect(validateFormFields(rules, { title: blank }), JSON.stringify(blank)).toEqual(['title'])
    }
  })

  it('zero and false ARE values: a numeric or boolean field can legitimately be either', () => {
    expect(validateFormFields({ n: { visible: true, required: true } }, { n: 0 })).toEqual([])
    expect(validateFormFields({ n: { visible: true, required: true } }, { n: false })).toEqual([])
  })

  it('a hidden required field is never reported: it cannot be filled in', () => {
    expect(validateFormFields(rules, { title: 'x' })).toEqual([])
  })

  it('reports every missing field, not just the first', () => {
    const many = { a: { visible: true, required: true }, b: { visible: true, required: true } }
    expect(validateFormFields(many, {}).sort()).toEqual(['a', 'b'])
  })
})
