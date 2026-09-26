/**
 * WHEN A WAIT IS OVER (26 Sep 2026).
 *
 * What a user loses if this regresses: a change or a ticket leaving a wait
 * the customer drew — a cooling-off, a customer's reply time — before it is
 * over; or one left in a wait for ever because its timer job was lost.
 */
import { describe, it, expect } from 'vitest'
import { TIMER_GRACE_MINUTES, waitTimerLost } from '../waitSteps.js'

const NOW = new Date('2026-09-26T08:00:00Z')
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString()

describe('waitTimerLost', () => {
  it('a wait still running, or just over but within the grace, is not lost', () => {
    expect(waitTimerLost(ago(30), 60, NOW)).toBe(false)
    expect(waitTimerLost(ago(60 + TIMER_GRACE_MINUTES - 1), 60, NOW)).toBe(false)
  })

  it('a wait over by more than the grace is: its timer job was lost', () => {
    expect(waitTimerLost(ago(60 + TIMER_GRACE_MINUTES), 60, NOW)).toBe(true)
    expect(waitTimerLost(ago(10_000), '60', NOW)).toBe(true)
  })

  it('no valid delay or no date: never over — a misconfigured step is the engine\'s to report, not a guess', () => {
    expect(waitTimerLost(ago(10_000), 0, NOW)).toBe(false)
    expect(waitTimerLost(ago(10_000), null, NOW)).toBe(false)
    expect(waitTimerLost(ago(10_000), 'abc', NOW)).toBe(false)
    expect(waitTimerLost(null, 60, NOW)).toBe(false)
    expect(waitTimerLost('not a date', 60, NOW)).toBe(false)
  })
})
