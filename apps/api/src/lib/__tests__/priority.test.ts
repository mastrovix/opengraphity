import { describe, it, expect } from 'vitest'
import { derivePriority, impactUrgencyFromPriority, priorityCode } from '../priority.js'

describe('derivePriority (ITIL Impact × Urgency matrix)', () => {
  it('high × high → critical (P1)', () => expect(derivePriority('high', 'high')).toBe('critical'))
  it('high × medium / medium × high → high', () => {
    expect(derivePriority('high', 'medium')).toBe('high')
    expect(derivePriority('medium', 'high')).toBe('high')
  })
  it('the medium band', () => {
    expect(derivePriority('high', 'low')).toBe('medium')
    expect(derivePriority('medium', 'medium')).toBe('medium')
    expect(derivePriority('low', 'high')).toBe('medium')
  })
  it('the low band', () => {
    expect(derivePriority('medium', 'low')).toBe('low')
    expect(derivePriority('low', 'medium')).toBe('low')
    expect(derivePriority('low', 'low')).toBe('low')
  })
})

describe('impactUrgencyFromPriority is a lossless inverse through the matrix', () => {
  for (const p of ['critical', 'high', 'medium', 'low'] as const) {
    it(`${p} round-trips`, () => {
      const { impact, urgency } = impactUrgencyFromPriority(p)
      expect(derivePriority(impact, urgency)).toBe(p)
    })
  }
})

describe('priorityCode', () => {
  it('maps to P1–P4', () => {
    expect(priorityCode('critical')).toBe('P1')
    expect(priorityCode('high')).toBe('P2')
    expect(priorityCode('medium')).toBe('P3')
    expect(priorityCode('low')).toBe('P4')
  })
})
