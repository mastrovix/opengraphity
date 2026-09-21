/**
 * I NUMERI DELLE PROPOSTE SI FORMATTANO NELLA LINGUA DI CHI LEGGE
 * (20 set 2026, ondata 5).
 *
 * Difetto trovato guardando una proposta vera su `c-one`: il titolo diceva
 * «29.1 h» col punto, dentro una frase italiana che poco sotto diceva
 * «29,12 ore». Il numero era stato formattato nell'API, che non sa in che
 * lingua leggerà chi guarda — la lingua è di ogni persona, non del cliente.
 */
import { describe, it, expect } from 'vitest'
import { valoreDelParametro } from '../ProposalsPage'

describe('che cosa torna a essere un numero', () => {
  it.each([['29.1', 29.1], ['0', 0], ['88', 88], ['-3', -3], ['1234', 1234]] as const)(
    '«%s» diventa un numero', (grezzo, atteso) => { expect(valoreDelParametro(grezzo)).toBe(atteso) })
})

describe('che cosa resta una stringa, e perché', () => {
  it.each([
    ['09',            'uno zero iniziale non è un numero: è un codice'],
    ['2026-09-20',    'una data'],
    ['1e5',           'la notazione esponenziale non torna identica'],
    ['9fd860f5a1b2',  'un\'impronta'],
    ['123456789012345678901234567890', 'un\'impronta di sole cifre non diventa un numero con i punti'],
    ['1.2345',        'più decimali di quelli che un aggregato produce'],
    ['',              'il vuoto'],
    ['resolved',      'un nome di passo'],
  ])('«%s» resta com\'è (%s)', (grezzo) => { expect(valoreDelParametro(grezzo)).toBe(grezzo) })
})
