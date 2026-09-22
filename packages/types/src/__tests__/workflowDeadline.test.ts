/**
 * A STEP DEADLINE: "if the ticket sits here too long, move it".
 *
 * There is no human behind a deadline, which is what makes the two protected
 * lists matter: a deadline must not carry a change INTO an approval step or a
 * release window (that is precisely the bypass the gate exists to prevent),
 * and it must not carry one OUT of an approval step (the gate would refuse it
 * every time — that is not a configuration, it is noise).
 *
 * The parse is the shape only: whether the target step exists, whether there
 * is an edge to it, and whether the fields are in the customer's metamodel is
 * the API's job, against the graph.
 */
import { describe, it, expect } from 'vitest'
import {
  parseStepDeadline, stepDeadlineMinutes, StepDeadlineError,
  STEP_DEADLINE_UNITS, STEP_DEADLINE_MAX_DAYS, STEP_DEADLINE_ACTOR,
  DEADLINE_PROTECTED_TARGET_PURPOSES, DEADLINE_PROTECTED_SOURCE_PURPOSES,
} from '../workflowDeadline.js'
import { isWorkflowStepPurpose } from '../workflowPurpose.js'

const VALID = { after: 3, unit: 'days', calendar_id: null, to_step: 'escalated', set_fields: [] }
/** The `problem` code of what `parseStepDeadline` threw. */
const problemOf = (raw: unknown): string => {
  try { parseStepDeadline(raw); return 'no-throw' }
  catch (e) { return e instanceof StepDeadlineError ? e.problem : 'wrong-error' }
}

describe('parseStepDeadline — no deadline', () => {
  it('null, undefined and the empty string mean "no deadline", not a broken one', () => {
    for (const nothing of [null, undefined, '']) expect(parseStepDeadline(nothing)).toBeNull()
  })
})

describe('parseStepDeadline — the shape', () => {
  it('reads an object and a JSON string the same way', () => {
    const expected = { after: 3, unit: 'days', calendar_id: null, to_step: 'escalated', set_fields: [] }
    expect(parseStepDeadline(VALID)).toEqual(expected)
    expect(parseStepDeadline(JSON.stringify(VALID))).toEqual(expected)
  })

  it('a string that is not JSON, and anything that is not an object, are refused by their own code', () => {
    expect(problemOf('{not json')).toBe('invalid_json')
    for (const bad of [42, true, [], [VALID]]) expect(problemOf(bad), String(bad)).toBe('not_object')
  })

  it('the unit must be one of the two, and the message lists them', () => {
    for (const unit of ['weeks', 'ore', '', 42, undefined]) {
      expect(problemOf({ ...VALID, unit })).toBe('unit')
    }
    for (const unit of STEP_DEADLINE_UNITS) expect(parseStepDeadline({ ...VALID, unit }).unit).toBe(unit)
    try { parseStepDeadline({ ...VALID, unit: 'weeks' }) }
    catch (e) { expect((e as Error).message).toContain('hours, days') }
  })

  it('"after" is a whole number of at least one', () => {
    for (const after of [0, -1, 1.5, '3', NaN, undefined]) {
      expect(problemOf({ ...VALID, after }), String(after)).toBe('after')
    }
    expect(parseStepDeadline({ ...VALID, after: 1 }).after).toBe(1)
  })

  it('the cap is ten years, counted in the unit given — and the message says which', () => {
    // Beyond that it is almost certainly a typo, and a deadline ten years out
    // is indistinguishable from none.
    expect(parseStepDeadline({ ...VALID, unit: 'days', after: STEP_DEADLINE_MAX_DAYS }).after).toBe(STEP_DEADLINE_MAX_DAYS)
    expect(problemOf({ ...VALID, unit: 'days', after: STEP_DEADLINE_MAX_DAYS + 1 })).toBe('after')
    expect(parseStepDeadline({ ...VALID, unit: 'hours', after: STEP_DEADLINE_MAX_DAYS * 24 }).after).toBe(STEP_DEADLINE_MAX_DAYS * 24)
    expect(problemOf({ ...VALID, unit: 'hours', after: STEP_DEADLINE_MAX_DAYS * 24 + 1 })).toBe('after')
  })

  it('the calendar is an id or null; an empty string is neither', () => {
    expect(parseStepDeadline({ ...VALID, calendar_id: 'cal-1' }).calendar_id).toBe('cal-1')
    expect(parseStepDeadline({ ...VALID, calendar_id: undefined }).calendar_id).toBeNull()
    for (const bad of ['', '   ', 42, {}]) expect(problemOf({ ...VALID, calendar_id: bad }), String(bad)).toBe('calendar')
  })

  it('the target step is required and is trimmed', () => {
    // Without it the deadline has nowhere to move the ticket, so it would
    // fire forever and do nothing.
    for (const bad of [undefined, null, '', '   ', 42]) expect(problemOf({ ...VALID, to_step: bad })).toBe('to_step')
    expect(parseStepDeadline({ ...VALID, to_step: '  escalated  ' }).to_step).toBe('escalated')
  })
})

describe('parseStepDeadline — the fields it sets on the way', () => {
  it('absent set_fields is an empty list, not a failure', () => {
    const { set_fields: _s, ...withoutFields } = VALID
    expect(parseStepDeadline(withoutFields).set_fields).toEqual([])
  })

  it('values of any scalar type are stored as strings: the property is written as text', () => {
    expect(parseStepDeadline({ ...VALID, set_fields: [
      { field: 'severity', value: 'high' }, { field: 'escalated', value: true }, { field: 'level', value: 2 },
    ] }).set_fields).toEqual([
      { field: 'severity', value: 'high' }, { field: 'escalated', value: 'true' }, { field: 'level', value: '2' },
    ])
  })

  it('an entry without a name or without a scalar value is refused', () => {
    for (const bad of [
      [{ value: 'x' }], [{ field: '', value: 'x' }], [{ field: 'severity' }],
      [{ field: 'severity', value: null }], [{ field: 'severity', value: {} }], [null], ['severity'],
    ]) {
      expect(problemOf({ ...VALID, set_fields: bad }), JSON.stringify(bad)).toBe('set_fields')
    }
    expect(problemOf({ ...VALID, set_fields: 'severity=high' })).toBe('set_fields')
  })

  it('the same field set twice is refused, naming it: which of the two would win is undefined', () => {
    expect(problemOf({ ...VALID, set_fields: [{ field: 'severity', value: 'high' }, { field: 'severity', value: 'low' }] }))
      .toBe('duplicate_field')
    try { parseStepDeadline({ ...VALID, set_fields: [{ field: 'severity', value: 'a' }, { field: 'severity', value: 'b' }] }) }
    catch (e) { expect((e as StepDeadlineError).params).toEqual({ field: 'severity' }) }
  })

  it('the field name is trimmed', () => {
    expect(parseStepDeadline({ ...VALID, set_fields: [{ field: ' severity ', value: 'high' }] }).set_fields[0].field).toBe('severity')
  })
})

describe('stepDeadlineMinutes — clock minutes or service minutes', () => {
  it('hours are always hours, calendar or not', () => {
    expect(stepDeadlineMinutes({ after: 4, unit: 'hours' }, null)).toBe(240)
    expect(stepDeadlineMinutes({ after: 4, unit: 'hours' }, 480)).toBe(240)
  })

  it('a day with no calendar is 24 hours; with one it is a whole service day', () => {
    // "Two days" on a 9-to-18 calendar means two working days, not 48 hours:
    // counting clock hours would fire the deadline in the middle of the night.
    expect(stepDeadlineMinutes({ after: 2, unit: 'days' }, null)).toBe(2 * 24 * 60)
    expect(stepDeadlineMinutes({ after: 2, unit: 'days' }, 9 * 60)).toBe(2 * 9 * 60)
  })
})

describe('the protected purposes', () => {
  it('a deadline may not carry a change INTO an approval step or a release window', () => {
    // No human behind it: moving a change there "because time passed" is the
    // bypass the gate exists to prevent.
    expect([...DEADLINE_PROTECTED_TARGET_PURPOSES]).toEqual(['approval', 'scheduled', 'implementation'])
    for (const p of DEADLINE_PROTECTED_TARGET_PURPOSES) expect(isWorkflowStepPurpose(p)).toBe(true)
  })

  it('and may not carry one OUT of an approval step', () => {
    expect([...DEADLINE_PROTECTED_SOURCE_PURPOSES]).toEqual(['approval'])
    expect(isWorkflowStepPurpose(DEADLINE_PROTECTED_SOURCE_PURPOSES[0])).toBe(true)
  })

  it('the history shows a deadline as its own actor, not as a person', () => {
    expect(STEP_DEADLINE_ACTOR).toBe('step_deadline')
  })
})
