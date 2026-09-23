/**
 * THE REASON OF A FAILED JOB: lists that are not quite the expected shape.
 *
 * `motivoLeggibile` folds «a: X; b: X; c: X» into «a, b, c: X». When an
 * entry of the list is not `label: cause` — free text first, or a label with
 * nothing after it — the text is returned WHOLE: half a folded list would
 * tell the operator less than the original.
 */
import { describe, it, expect } from 'vitest'
import { motivoLeggibile } from './failureReason'

describe('motivoLeggibile', () => {
  it('a list whose first entry is free text is returned whole', () => {
    const raw = 'Connection lost; storms: redis down; gauges: redis down'
    expect(motivoLeggibile(raw)).toBe(raw)
  })

  it('an entry with a label and no cause is returned whole', () => {
    const raw = 'storms: redis down; gauges: '
    expect(motivoLeggibile(raw)).toBe(raw)
  })

  it('the same list, well formed, is folded', () => {
    expect(motivoLeggibile('storms: redis down; gauges: redis down')).toBe('storms, gauges: redis down')
  })
})
