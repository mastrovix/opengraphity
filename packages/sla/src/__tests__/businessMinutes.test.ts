/** Secondo giro UI del 15 set 2026: i minuti del team, il rovescio di calculateDeadline. */
import { describe, it, expect } from 'vitest'
import { businessMinutesBetween, calculateDeadline } from '../policy.js'

const cal = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00', holidays: ['2026-12-25'] }

describe('businessMinutesBetween', () => {
  it('24×7: la differenza in minuti', () => {
    expect(businessMinutesBetween(new Date('2026-09-15T08:00:00Z'), new Date('2026-09-15T10:30:00Z'), false, 'UTC', null)).toBe(150)
  })

  it('stesso giorno, dentro e a cavallo della fascia', () => {
    expect(businessMinutesBetween(new Date('2026-09-15T10:00:00Z'), new Date('2026-09-15T12:00:00Z'), true, 'UTC', cal)).toBe(120)
    expect(businessMinutesBetween(new Date('2026-09-15T07:00:00Z'), new Date('2026-09-15T20:00:00Z'), true, 'UTC', cal)).toBe(540)
  })

  it('fine settimana e festività non contano', () => {
    // venerdì 17:00 → lunedì 10:00 = 60 + 60
    expect(businessMinutesBetween(new Date('2026-09-18T17:00:00Z'), new Date('2026-09-21T10:00:00Z'), true, 'UTC', cal)).toBe(120)
    // 24 dic 17:00 → 28 dic 10:00, il 25 è festa, 26-27 weekend
    expect(businessMinutesBetween(new Date('2026-12-24T17:00:00Z'), new Date('2026-12-28T10:00:00Z'), true, 'UTC', cal)).toBe(120)
  })

  it('è il rovescio di calculateDeadline', () => {
    const from = new Date('2026-09-15T16:20:00Z')
    for (const minutes of [30, 240, 600, 1500]) {
      const deadline = calculateDeadline(from, minutes, true, 'Europe/Rome', cal)
      expect(businessMinutesBetween(from, deadline, true, 'Europe/Rome', cal)).toBe(minutes)
    }
  })

  it('un intervallo rovesciato vale zero', () => {
    expect(businessMinutesBetween(new Date('2026-09-15T12:00:00Z'), new Date('2026-09-15T10:00:00Z'), true, 'UTC', cal)).toBe(0)
  })
})
