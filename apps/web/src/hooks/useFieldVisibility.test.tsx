/**
 * FIELD VISIBILITY RULES: which fields of a form show, given what is filled in.
 *
 * The rules are the customer's (metamodel). Two kinds, and their defaults are
 * the point: a «show» rule HIDES its field until its trigger matches (a field
 * that only makes sense for, say, a hardware fault), a «hide» rule SHOWS its
 * field until its trigger matches. Get a default wrong and a form asks for a
 * field that does not apply, or hides one that does. The trigger compares as
 * text, because a form value can be a number or empty.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { apolloFinto } from '@/test/apolloFinto'
import { useFieldVisibility } from './useFieldVisibility'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const rule = (over: Record<string, unknown>) => ({ id: 'r', triggerField: 'category', triggerValue: 'hardware', targetField: 'serial', action: 'show', ...over })

beforeEach(() => { apolloFinto.reset() })

const visibility = (values: Record<string, unknown>) => renderHook(() => useFieldVisibility('incident', values)).result.current

describe('useFieldVisibility', () => {
  it('asks for the rules of the entity type', () => {
    apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [] }
    visibility({})
    expect(apolloFinto.chiamata('GetFieldVisibilityRules')).toEqual({ entityType: 'incident' })
  })

  it('without rules no field is decided, and there is no error', () => {
    apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [] }
    expect(visibility({ category: 'hardware' })).toEqual({ visibility: {}, error: null })
  })

  it('a «show» rule hides its field until the trigger matches', () => {
    apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [rule({})] }
    expect(visibility({}).visibility).toEqual({ serial: false })
    expect(visibility({ category: 'software' }).visibility).toEqual({ serial: false })
    expect(visibility({ category: 'hardware' }).visibility).toEqual({ serial: true })
  })

  it('a «hide» rule shows its field until the trigger matches', () => {
    apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [rule({ targetField: 'workaround', action: 'hide', triggerValue: 'resolved', triggerField: 'status' })] }
    expect(visibility({ status: 'new' }).visibility).toEqual({ workaround: true })
    expect(visibility({ status: 'resolved' }).visibility).toEqual({ workaround: false })
  })

  it('the trigger compares as text: a number matches its digits, an empty value matches an empty trigger', () => {
    apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [
      rule({ id: 'a', triggerField: 'priority', triggerValue: '1', targetField: 'escalation' }),
      rule({ id: 'b', triggerField: 'assignee', triggerValue: '', targetField: 'team', action: 'show' }),
    ] }
    expect(visibility({ priority: 1 }).visibility).toEqual({ escalation: true, team: true })
    expect(visibility({ priority: 2, assignee: 'u1' }).visibility).toEqual({ escalation: false, team: false })
  })

  it('on the same field, a matching «show» opens it, and a matching «hide» closes it again', () => {
    apolloFinto.risposte['GetFieldVisibilityRules'] = { fieldVisibilityRules: [
      rule({ id: 'show', triggerField: 'category', triggerValue: 'hardware', targetField: 'serial', action: 'show' }),
      rule({ id: 'hide', triggerField: 'type', triggerValue: 'virtual', targetField: 'serial', action: 'hide' }),
    ] }
    expect(visibility({ category: 'hardware', type: 'physical' }).visibility).toEqual({ serial: true })
    expect(visibility({ category: 'hardware', type: 'virtual' }).visibility).toEqual({ serial: false })
    // A «hide» that does not match does not open a field its «show» keeps closed.
    expect(visibility({ category: 'software', type: 'physical' }).visibility).toEqual({ serial: false })
  })

  it('a failure to load the rules is reported to the form', () => {
    apolloFinto.erroriQuery['GetFieldVisibilityRules'] = new Error('rules unavailable')
    const r = visibility({})
    expect(r.visibility).toEqual({})
    expect(r.error?.message).toBe('rules unavailable')
  })
})
