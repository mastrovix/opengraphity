/**
 * Priorità della Change = tipo × rischio (ITIL) — regola di testa del dominio,
 * memorizzata sul nodo. Matrice completa (3 tipi × {null, low, medium, high}):
 *
 *              risk: null    low     medium   high
 *   standard        low     low     low      medium
 *   normal          medium  low     medium   high
 *   emergency       high    high    high     critical
 */
import { describe, it, expect } from 'vitest'
import { deriveChangePriority } from '../scoring.js'

const cases: Array<[string | null, number | null, string]> = [
  ['standard',  null, 'low'],    ['standard',  10, 'low'],    ['standard',  45, 'low'],    ['standard',  80, 'medium'],
  ['normal',    null, 'medium'], ['normal',    30, 'low'],    ['normal',    60, 'medium'], ['normal',    61, 'high'],
  ['emergency', null, 'high'],   ['emergency', 0,  'high'],   ['emergency', 50, 'high'],   ['emergency', 99, 'critical'],
]

describe('deriveChangePriority', () => {
  it.each(cases)('%s × rischio %s → %s', (type, risk, expected) => {
    expect(deriveChangePriority(type, risk)).toBe(expected)
  })
  it('tipo assente → trattato come normal', () => {
    expect(deriveChangePriority(null, null)).toBe('medium')
    expect(deriveChangePriority(undefined, 70)).toBe('high')
  })
  it('le soglie coincidono con determineApprovalRoute (30 / 60 inclusivi)', () => {
    expect(deriveChangePriority('normal', 30)).toBe('low')
    expect(deriveChangePriority('normal', 31)).toBe('medium')
    expect(deriveChangePriority('normal', 60)).toBe('medium')
  })
})
