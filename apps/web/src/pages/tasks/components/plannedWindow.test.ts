import { describe, it, expect } from 'vitest'
import { plannedWindowStart, beforePlannedWindow } from './plannedWindow'

const steps = [
  { title: 'b', validationWindow: { start: '2026-09-16T19:00:00Z', end: 'x' }, releaseWindow: { start: '2026-09-17T19:00:00Z', end: 'x' } },
  { title: 'a', validationWindow: { start: '2026-09-15T19:00:00Z', end: 'x' }, releaseWindow: { start: '2026-09-16T19:00:00Z', end: 'x' } },
] as never

describe('finestra pianificata', () => {
  it('prende l\'inizio più vicino del tipo giusto', () => {
    expect(plannedWindowStart(steps, 'validation')).toBe('2026-09-15T19:00:00Z')
    expect(plannedWindowStart(steps, 'deployment')).toBe('2026-09-16T19:00:00Z')
    expect(plannedWindowStart([], 'deployment')).toBeNull()
  })
  it('prima dell\'inizio chiede conferma, dopo no, senza piano mai', () => {
    expect(beforePlannedWindow('2026-09-15T19:00:00Z', Date.parse('2026-09-14T00:00:00Z'))).toBe(true)
    expect(beforePlannedWindow('2026-09-15T19:00:00Z', Date.parse('2026-09-15T20:00:00Z'))).toBe(false)
    expect(beforePlannedWindow(null)).toBe(false)
  })
})
