/**
 * «contiene» su una LISTA (moduli del catalogo, ondata 5).
 *
 * Il difetto: la selezione multipla di un modulo finisce sul nodo come lista, e
 * l'evaluatore usciva subito se il valore non era una stringa. Una business
 * rule «se Ambienti coinvolti contiene produzione» non scattava MAI, e non
 * c'era un errore a dirlo — il modo peggiore di sbagliare.
 */
import { describe, it, expect } from 'vitest'
import { evaluateConditions } from '../conditionEvaluator.js'

const ticket = { ambienti_coinvolti: ['production', 'testing'], note: 'guasto in produzione', vuoto: [] as string[] }

describe('contains su una lista', () => {
  it('trova la scelta presente e non quella assente', () => {
    expect(evaluateConditions([{ field: 'ambienti_coinvolti', operator: 'contains', value: 'production' }], ticket)).toBe(true)
    expect(evaluateConditions([{ field: 'ambienti_coinvolti', operator: 'contains', value: 'staging' }], ticket)).toBe(false)
  })

  it('il confronto è per valore intero, non per pezzo di testo: «prod» non è «production»', () => {
    expect(evaluateConditions([{ field: 'ambienti_coinvolti', operator: 'contains', value: 'prod' }], ticket)).toBe(false)
  })

  it('su un testo «contiene» resta il pezzo di testo, come prima', () => {
    expect(evaluateConditions([{ field: 'note', operator: 'contains', value: 'produzione' }], ticket)).toBe(true)
  })

  it('una lista vuota non contiene niente', () => {
    expect(evaluateConditions([{ field: 'vuoto', operator: 'contains', value: 'production' }], ticket)).toBe(false)
  })

  it('«è vuoto» su una lista con dentro qualcosa è falso', () => {
    expect(evaluateConditions([{ field: 'ambienti_coinvolti', operator: 'is_null' }], ticket)).toBe(false)
    expect(evaluateConditions([{ field: 'mai_compilato', operator: 'is_null' }], ticket)).toBe(true)
  })
})
