/**
 * Giro del 14 set 2026: l'allarme diceva «Incident INC00000010 opened
 * automatically» per un incident aperto a mano con «Open incident».
 */
import { describe, it, expect } from 'vitest'
import i18n from '@/i18n/i18n'
import { correlationSentence } from './eventCorrelation'

const ev = { correlation: 'opened', correlationAt: '2026-09-14T00:48:00Z', incident: { id: 'i1', number: 'INC00000010' } } as never

describe('correlationSentence — chi ha aperto l\'incident', () => {
  it('aperto dalla correlazione: «automatically»', () => {
    expect(correlationSentence(i18n.t, ev, null, { statusLabel: (s) => s })).toMatch(/INC00000010 opened automatically/)
  })
  it('aperto da un operatore: lo dice, niente «automatically»', () => {
    const frase = correlationSentence(i18n.t, ev, null, { openedManually: true, statusLabel: (s) => s })
    expect(frase).toMatch(/INC00000010 opened by an operator/)
    expect(frase).not.toMatch(/automatically/)
  })
})

/** Secondo giro UI del 15 set 2026 · V-21: lo stato del CI si legge dal Dizionario. */
describe('correlationSentence — skipped_lifecycle', () => {
  it('usa l\'etichetta dello stato che le passa chi chiama, non il valore umanizzato', () => {
    const skipped = { correlation: 'skipped_lifecycle', ci: { id: 'c1', name: 'db-01', status: 'in_maintenance' } } as never
    const frase = correlationSentence(i18n.t, skipped, null, { statusLabel: (s) => (s === 'in_maintenance' ? 'Fermo programmato' : s) })
    expect(frase).toContain('Fermo programmato')
    expect(frase).not.toContain('In Maintenance')
  })
})
