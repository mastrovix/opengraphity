/**
 * UNA CONDIZIONE CONFRONTA VALORI, NON FORME (revisione del 17 set 2026).
 *
 * L'interfaccia salva sempre una STRINGA — la tendina di una business rule
 * scrive `"true"`, `"1200"` — mentre un modulo del catalogo scrive sul ticket
 * il valore col suo tipo: un booleano vero, un numero vero. `true === "true"`
 * è falso, quindi la regola restava «attiva» e non partiva MAI, senza un
 * errore e senza una riga di log.
 *
 * Il difetto era il peggiore della sua famiglia perché `maggiore di` funziona
 * (passa da `Number()`): l'amministratore vedeva che «qualcosa funziona» e non
 * aveva motivo di sospettare il resto. È anche la terza volta che questo
 * prodotto lo paga — prima con l'`equals` su una lista, poi col `contains` sui
 * multi-valore.
 */
import { describe, it, expect } from 'vitest'
import { evaluateConditions, sameValue } from '../conditionEvaluator.js'

/** Come lo scrive un modulo del catalogo: tipi veri, non testo. */
const ticket = {
  serve_vpn: true,
  serve_badge: false,
  costo: 1200,
  costo_decimale: 1200.5,
  modello: 'ThinkPad X1',
  ambienti: ['production', 'testing'],
  quantita_per_sede: [2, 5],
}

describe('equals per tipo', () => {
  it('un sì/no si confronta con «true»/«false» della tendina', () => {
    expect(evaluateConditions([{ field: 'serve_vpn', operator: 'equals', value: 'true' }], ticket)).toBe(true)
    expect(evaluateConditions([{ field: 'serve_vpn', operator: 'equals', value: 'false' }], ticket)).toBe(false)
    expect(evaluateConditions([{ field: 'serve_badge', operator: 'equals', value: 'false' }], ticket)).toBe(true)
  })

  it('e regge le maiuscole e gli spazi che un salvataggio a mano può lasciare', () => {
    expect(sameValue(true, 'TRUE')).toBe(true)
    expect(sameValue(true, ' true ')).toBe(true)
    expect(sameValue(false, 'False')).toBe(true)
  })

  it('un numero si confronta col numero scritto nella tendina', () => {
    expect(evaluateConditions([{ field: 'costo', operator: 'equals', value: '1200' }], ticket)).toBe(true)
    expect(evaluateConditions([{ field: 'costo', operator: 'equals', value: '1201' }], ticket)).toBe(false)
    expect(evaluateConditions([{ field: 'costo_decimale', operator: 'equals', value: '1200.5' }], ticket)).toBe(true)
  })

  it('«non è» è l\'esatto contrario, altrimenti sarebbe vero due volte', () => {
    expect(evaluateConditions([{ field: 'serve_vpn', operator: 'not_equals', value: 'true' }], ticket)).toBe(false)
    expect(evaluateConditions([{ field: 'costo', operator: 'not_equals', value: '1200' }], ticket)).toBe(false)
    expect(evaluateConditions([{ field: 'costo', operator: 'not_equals', value: '9' }], ticket)).toBe(true)
  })

  it('il testo resta il confronto stretto di prima', () => {
    expect(evaluateConditions([{ field: 'modello', operator: 'equals', value: 'ThinkPad X1' }], ticket)).toBe(true)
    expect(evaluateConditions([{ field: 'modello', operator: 'equals', value: 'thinkpad x1' }], ticket)).toBe(false)
  })

  it('una LISTA non è «uguale» a un valore singolo: per quello c\'è «contiene»', () => {
    expect(evaluateConditions([{ field: 'ambienti', operator: 'equals', value: 'production' }], ticket)).toBe(false)
    expect(evaluateConditions([{ field: 'ambienti', operator: 'contains', value: 'production' }], ticket)).toBe(true)
  })

  it('«contiene» in una lista di numeri usa lo stesso confronto per tipo', () => {
    expect(evaluateConditions([{ field: 'quantita_per_sede', operator: 'contains', value: '5' }], ticket)).toBe(true)
    expect(evaluateConditions([{ field: 'quantita_per_sede', operator: 'contains', value: '7' }], ticket)).toBe(false)
  })

  it('un valore che non c\'è non diventa uguale a niente', () => {
    expect(sameValue(undefined, 'true')).toBe(false)
    expect(sameValue(null, '')).toBe(false)
    expect(sameValue(true, null)).toBe(false)
    // Un numero contro un testo che non è un numero: falso, non NaN.
    expect(sameValue(1200, 'mille')).toBe(false)
  })
})
