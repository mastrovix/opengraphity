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
    expect(correlationSentence(i18n.t, ev, null)).toMatch(/INC00000010 opened automatically/)
  })
  it('aperto da un operatore: lo dice, niente «automatically»', () => {
    const frase = correlationSentence(i18n.t, ev, null, true)
    expect(frase).toMatch(/INC00000010 opened by an operator/)
    expect(frase).not.toMatch(/automatically/)
  })
})
