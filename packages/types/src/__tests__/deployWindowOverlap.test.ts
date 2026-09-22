/**
 * QUANDO DUE FINESTRE DI RILASCIO SI PESTANO I PIEDI (22 set 2026).
 *
 * La regola sta in un file solo perché i chiamanti sono due — il calendario
 * che dipinge le barre e l'API che risponde «quali altre change toccano i miei
 * CI mentre rilascio?» — e due implementazioni sarebbero divergute al primo
 * dubbio. Il dubbio è questo: **un rilascio che finisce nell'istante in cui
 * l'altro comincia è un conflitto?** La risposta è NO, ed è quello che questo
 * file fissa: due finestre si sovrappongono se si toccano per PIÙ di un
 * istante.
 *
 * L'altra regola: una data non parsabile non «non si sovrappone per
 * sicurezza» — non è confrontabile, e chi chiama deve saperlo.
 */
import { describe, it, expect } from 'vitest'
import {
  finestraValida, intervalliSiSovrappongono, finestreSiSovrappongono, sovrapposizione,
} from '../deployWindowOverlap.js'

const f = (start: string, end: string) => ({ start, end })

describe('finestraValida', () => {
  it('due date leggibili e non a rovescio', () => {
    expect(finestraValida(f('2026-10-01T20:00:00Z', '2026-10-01T22:00:00Z'))).toBe(true)
  })

  it('assente, a rovescio, di durata zero o illeggibile: no', () => {
    expect(finestraValida(null)).toBe(false)
    expect(finestraValida(undefined)).toBe(false)
    expect(finestraValida(f('2026-10-01T22:00:00Z', '2026-10-01T20:00:00Z'))).toBe(false)
    expect(finestraValida(f('2026-10-01T20:00:00Z', '2026-10-01T20:00:00Z'))).toBe(false)
    expect(finestraValida(f('domani', '2026-10-01T22:00:00Z'))).toBe(false)
    expect(finestraValida(f('2026-10-01T20:00:00Z', 'dopodomani'))).toBe(false)
  })
})

describe('la regola, sui millisecondi', () => {
  it('consecutivi NON si sovrappongono: è la domanda a cui questo file risponde', () => {
    expect(intervalliSiSovrappongono(0, 100, 100, 200)).toBe(false)
    expect(intervalliSiSovrappongono(100, 200, 0, 100)).toBe(false)
  })

  it('un solo millisecondo in comune basta', () => {
    expect(intervalliSiSovrappongono(0, 101, 100, 200)).toBe(true)
  })

  it('uno dentro l\'altro, e lontani', () => {
    expect(intervalliSiSovrappongono(0, 500, 100, 200)).toBe(true)
    expect(intervalliSiSovrappongono(100, 200, 0, 500)).toBe(true)
    expect(intervalliSiSovrappongono(0, 100, 500, 600)).toBe(false)
  })
})

describe('finestreSiSovrappongono — la stessa regola, sulle date', () => {
  it('«fino alle 22:00» e «dalle 22:00» sono consecutive, come le legge chi le ha scritte', () => {
    expect(finestreSiSovrappongono(
      f('2026-10-01T20:00:00Z', '2026-10-01T22:00:00Z'),
      f('2026-10-01T22:00:00Z', '2026-10-02T00:00:00Z'),
    )).toBe(false)
  })

  it('un\'ora in comune sì', () => {
    expect(finestreSiSovrappongono(
      f('2026-10-01T20:00:00Z', '2026-10-01T23:00:00Z'),
      f('2026-10-01T22:00:00Z', '2026-10-02T00:00:00Z'),
    )).toBe(true)
  })

  it('e il fuso non conta: gli stessi istanti scritti con offset diversi si comportano uguale', () => {
    expect(finestreSiSovrappongono(
      f('2026-10-01T22:00:00+02:00', '2026-10-01T23:00:00+02:00'),
      f('2026-10-01T20:30:00Z', '2026-10-01T21:30:00Z'),
    )).toBe(true)
  })

  it('una finestra non valida non si sovrappone a niente', () => {
    const buona = f('2026-10-01T20:00:00Z', '2026-10-01T23:00:00Z')
    expect(finestreSiSovrappongono(buona, f('domani', 'dopodomani'))).toBe(false)
    expect(finestreSiSovrappongono(f('x', 'y'), buona)).toBe(false)
  })
})

describe('sovrapposizione — la parte in comune', () => {
  it('è l\'inizio più tardo e la fine più presto, in ISO Z', () => {
    expect(sovrapposizione(
      f('2026-10-01T20:00:00Z', '2026-10-01T23:00:00Z'),
      f('2026-10-01T22:00:00Z', '2026-10-02T02:00:00Z'),
    )).toEqual({ start: '2026-10-01T22:00:00.000Z', end: '2026-10-01T23:00:00.000Z' })
  })

  it('una dentro l\'altra: la parte in comune è quella piccola', () => {
    expect(sovrapposizione(
      f('2026-10-01T20:00:00Z', '2026-10-02T06:00:00Z'),
      f('2026-10-01T22:00:00Z', '2026-10-01T23:00:00Z'),
    )).toEqual({ start: '2026-10-01T22:00:00.000Z', end: '2026-10-01T23:00:00.000Z' })
  })

  it('`null` quando non si toccano, e quando una non è valida', () => {
    expect(sovrapposizione(
      f('2026-10-01T20:00:00Z', '2026-10-01T22:00:00Z'),
      f('2026-10-01T22:00:00Z', '2026-10-02T00:00:00Z'),
    )).toBeNull()
    expect(sovrapposizione(f('x', 'y'), f('2026-10-01T20:00:00Z', '2026-10-01T22:00:00Z'))).toBeNull()
  })
})
