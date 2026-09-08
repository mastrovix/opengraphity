import { describe, it, expect, vi, beforeEach } from 'vitest'
import { derivePriority, priorityCode, impactUrgencyFromPriority, IMPACT_URGENCY_OPTIONS, IMPACT_URGENCY_LABEL, type ImpactUrgency, type Priority } from './priority'

let consoleError: ReturnType<typeof vi.spyOn>
beforeEach(() => { consoleError = vi.spyOn(console, 'error').mockImplementation(() => {}) })

describe('derivePriority — matrice Impatto × Urgenza (specchio dell\'API)', () => {
  const matrix: [ImpactUrgency, ImpactUrgency, Priority][] = [
    ['high',   'high',   'critical'],
    ['high',   'medium', 'high'],
    ['high',   'low',    'medium'],
    ['medium', 'high',   'high'],
    ['medium', 'medium', 'medium'],
    ['medium', 'low',    'low'],
    ['low',    'high',   'medium'],
    ['low',    'medium', 'low'],
    ['low',    'low',    'low'],
  ]
  it.each(matrix)('impact=%s urgency=%s → %s', (i, u, p) => {
    expect(derivePriority(i, u)).toBe(p)
  })
})

describe('priorityCode', () => {
  it.each([['critical', 'P1'], ['high', 'P2'], ['medium', 'P3'], ['low', 'P4']])('%s → %s', (p, code) => {
    expect(priorityCode(p)).toBe(code)
    expect(consoleError).not.toHaveBeenCalled()
  })
  it('valore ignoto → "P?" visibile + console.error', () => {
    expect(priorityCode('urgent')).toBe('P?')
    expect(consoleError).toHaveBeenCalledWith('[PRIORITY_CODE] valore sconosciuto: "urgent"')
  })
})

describe('impactUrgencyFromPriority', () => {
  it('è l\'inversa canonica della matrice', () => {
    for (const p of ['critical', 'high', 'medium', 'low'] as Priority[]) {
      const { impact, urgency } = impactUrgencyFromPriority(p)
      expect(derivePriority(impact, urgency)).toBe(p)
    }
  })
  it('priorità ignota → medium/medium loggata, non silenziosa', () => {
    expect(impactUrgencyFromPriority('p9')).toEqual({ impact: 'medium', urgency: 'medium' })
    expect(consoleError).toHaveBeenCalledWith('[IMPACT_URGENCY_FROM_PRIORITY] valore sconosciuto: "p9"')
  })
})

describe('opzioni', () => {
  it('ordine alto → basso e etichette italiane', () => {
    expect(IMPACT_URGENCY_OPTIONS).toEqual(['high', 'medium', 'low'])
    expect(IMPACT_URGENCY_OPTIONS.map((o) => IMPACT_URGENCY_LABEL[o])).toEqual(['Alto', 'Medio', 'Basso'])
  })
})
