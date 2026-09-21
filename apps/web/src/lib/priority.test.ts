/**
 * La priorità dalla matrice **del cliente** (revisione delle otto ondate ·
 * C·N-3). Il test di prima pinnava una matrice 3×3 scritta a mano in questo
 * file: era lo specchio della matrice del server del 2025, e l'ondata 7 ha reso
 * quella matrice dato del cliente. Pinnare la copia significava pinnare il
 * difetto — un cliente che rinominava impatto e urgenza vedeva nel form i tre
 * bottoni vecchi e ogni invio veniva rifiutato dal server.
 *
 * Qui si pinna il comportamento delle funzioni **date le celle**: la matrice di
 * fabbrica (per verificare che il primo giorno nulla cambi) e una matrice
 * rinominata e più grande (per verificare che segua il cliente).
 */
import { describe, it, expect } from 'vitest'
import { derivePriority, priorityCode, impactUrgencyFromPriority, matrixKey, type PriorityMatrix } from './priority'

/** La matrice di fabbrica, nella forma in cui la manda `domainMatrices`. */
const FACTORY: PriorityMatrix = {
  impacts:    ['low', 'medium', 'high'],
  urgencies:  ['low', 'medium', 'high'],
  priorities: ['low', 'medium', 'high', 'critical'],
  cells: [
    ['low', 'low', 'low'], ['low', 'medium', 'low'], ['low', 'high', 'medium'],
    ['medium', 'low', 'low'], ['medium', 'medium', 'medium'], ['medium', 'high', 'high'],
    ['high', 'low', 'medium'], ['high', 'medium', 'high'], ['high', 'high', 'critical'],
  ].map(([i, u, p]) => ({ key: matrixKey(i!, u!), inputs: [i!, u!], value: p! })),
}

/** Il cliente ha rinominato tutto e ha aggiunto una quarta urgenza. */
const CUSTOM: PriorityMatrix = {
  impacts:    ['basso', 'medio', 'alto'],
  urgencies:  ['rilassata', 'normale', 'urgente', 'subito'],
  priorities: ['p4', 'p3', 'p2', 'p1'],
  cells: [
    ['alto', 'subito', 'p1'], ['alto', 'urgente', 'p2'], ['basso', 'rilassata', 'p4'],
    ['medio', 'normale', 'p3'],
  ].map(([i, u, p]) => ({ key: matrixKey(i!, u!), inputs: [i!, u!], value: p! })),
}

describe('derivePriority — dalle celle, non da una tabella nel codice', () => {
  it.each([
    ['high', 'high', 'critical'], ['high', 'medium', 'high'], ['high', 'low', 'medium'],
    ['medium', 'high', 'high'], ['medium', 'medium', 'medium'], ['medium', 'low', 'low'],
    ['low', 'high', 'medium'], ['low', 'medium', 'low'], ['low', 'low', 'low'],
  ])('matrice di fabbrica: %s × %s → %s', (i, u, p) => {
    expect(derivePriority(FACTORY, i, u)).toBe(p)
  })

  it('segue il cliente che ha rinominato i valori', () => {
    expect(derivePriority(CUSTOM, 'alto', 'subito')).toBe('p1')
    expect(derivePriority(CUSTOM, 'medio', 'normale')).toBe('p3')
  })

  it('una combinazione che la matrice non copre è `null`, non un valore inventato', () => {
    expect(derivePriority(CUSTOM, 'basso', 'subito')).toBeNull()
  })

  it('senza matrice (ancora in caricamento) non indovina niente', () => {
    expect(derivePriority(null, 'high', 'high')).toBeNull()
  })
})

describe('priorityCode — dalla posizione nella scala, non da una mappa fissa', () => {
  it.each([['critical', 'P1'], ['high', 'P2'], ['medium', 'P3'], ['low', 'P4']])(
    'di fabbrica %s → %s (come la mappa scritta a mano di prima)', (p, code) => {
      expect(priorityCode(FACTORY.priorities, p)).toBe(code)
    })

  it('col vocabolario del cliente funziona ancora', () => {
    expect(priorityCode(CUSTOM.priorities, 'p1')).toBe('P1')
    expect(priorityCode(CUSTOM.priorities, 'p4')).toBe('P4')
  })

  it('una priorità che il vocabolario non ha resta visibile come P?', () => {
    // È un dato incoerente — un ticket con una priorità che il Dizionario non
    // ha più — e nasconderlo dietro un numero plausibile sarebbe peggio.
    expect(priorityCode(FACTORY.priorities, 'urgent')).toBe('P?')
  })
})

describe('impactUrgencyFromPriority', () => {
  it('è l\'inversa della matrice, e la scelta è quella del server', () => {
    for (const p of FACTORY.priorities) {
      const iu = impactUrgencyFromPriority(FACTORY, p)
      expect(iu, p).not.toBeNull()
      expect(derivePriority(FACTORY, iu!.impact, iu!.urgency)).toBe(p)
    }
    // Gli ingressi uguali fra loro vincono, come nell'API.
    expect(impactUrgencyFromPriority(FACTORY, 'medium')).toEqual({ impact: 'medium', urgency: 'medium' })
    // Altrimenti la prima cella nell'ordine della matrice.
    expect(impactUrgencyFromPriority(FACTORY, 'high')).toEqual({ impact: 'medium', urgency: 'high' })
  })

  it('una priorità che nessuna cella produce è `null`, non medium/medium', () => {
    expect(impactUrgencyFromPriority(CUSTOM, 'p3')).toEqual({ impact: 'medio', urgency: 'normale' })
    expect(impactUrgencyFromPriority(FACTORY, 'p9')).toBeNull()
  })
})
