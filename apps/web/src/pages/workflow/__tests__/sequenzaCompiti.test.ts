/**
 * NIENTE CICLI nel «parte quando è chiuso» (rimedio, 20 set 2026).
 *
 * La tendina escludeva solo sé stessi, quindi «A dopo B» **e** «B dopo A»
 * erano entrambi scrivibili. Il risultato non è un errore: nascono tutti e
 * due in attesa, si aprono solo alla chiusura di un altro compito, e la
 * guardia conta anche le attese — quindi il passo resta bloccato per
 * sempre. Il rilievo in Diagnostica non lo vede: cerca il titolo MANCANTE,
 * non il cerchio.
 *
 * Il test chiama la funzione VERA del pannello (`titoliCompitiOffribili`),
 * non una sua copia: quello che tiene fermo è quali titoli si possono
 * offrire senza chiudere un cerchio.
 */
import { describe, it, expect } from 'vitest'
// La funzione VERA, quella che usa il pannello: una copia qui dentro
// divergerebbe e questo test smetterebbe di dire la verità.
import { titoliCompitiOffribili as titoliOffribili } from '../workflow-panel-helpers'

describe('quali compiti si possono aspettare', () => {
  it('senza dipendenze si possono aspettare tutti gli altri', () => {
    const compiti = [{ titolo: 'A', dopo: '' }, { titolo: 'B', dopo: '' }, { titolo: 'C', dopo: '' }]
    expect(titoliOffribili(compiti, 'A')).toEqual(['B', 'C'])
  })

  it('sé stessi mai: un compito che aspetta sé stesso non parte', () => {
    expect(titoliOffribili([{ titolo: 'A', dopo: '' }], 'A')).toEqual([])
  })

  it('CHI MI ASPETTA non si può aspettare: sarebbe un cerchio', () => {
    // B aspetta A. Ad A non si può offrire B.
    const compiti = [{ titolo: 'A', dopo: '' }, { titolo: 'B', dopo: 'A' }]
    expect(titoliOffribili(compiti, 'A')).toEqual([])
  })

  it('il cerchio si riconosce anche LUNGO: A ← B ← C', () => {
    const compiti = [{ titolo: 'A', dopo: '' }, { titolo: 'B', dopo: 'A' }, { titolo: 'C', dopo: 'B' }]
    // Né B né C: aspettano A, direttamente o per catena.
    expect(titoliOffribili(compiti, 'A')).toEqual([])
    // A invece B lo può aspettare? No — è B che aspetta A. Ma C sì, per B:
    expect(titoliOffribili(compiti, 'B')).toEqual(['A'])
  })

  it('una catena lecita resta offribile', () => {
    const compiti = [{ titolo: 'Ordina', dopo: '' }, { titolo: 'Configura', dopo: 'Ordina' }, { titolo: 'Fattura', dopo: '' }]
    expect(titoliOffribili(compiti, 'Configura').sort()).toEqual(['Fattura', 'Ordina'])
  })
})
