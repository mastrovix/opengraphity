/**
 * LE ETICHETTE PER LINGUA (22 set 2026).
 *
 * Sul grafo stanno come JSON in una proprietà, perché Neo4j non ha mappe
 * annidate. Qui la lettura, che è **fail-loud**: un valore corrotto non
 * diventa «nessuna traduzione» — diventa un errore che dice DOVE, perché
 * un'etichetta che sparisce in silenzio si scopre guardando l'interfaccia in
 * un'altra lingua, cioè quasi mai.
 */
import { describe, it, expect } from 'vitest'
import { parseLocalizedLabels, serializeLocalizedLabels, localizedLabel } from '../localizedLabels.js'

describe('parseLocalizedLabels', () => {
  it('assente o vuoto: nessuna traduzione, senza errore', () => {
    for (const vuoto of [null, undefined, '']) {
      expect(parseLocalizedLabels(vuoto, 'Passo X')).toEqual([])
    }
  })

  it('legge sia il JSON sia l\'oggetto già aperto', () => {
    const atteso = [{ language: 'it', label: 'Nuovo' }, { language: 'en', label: 'New' }]
    expect(parseLocalizedLabels('{"it":"Nuovo","en":"New"}', 'Passo X')).toEqual(atteso)
    expect(parseLocalizedLabels({ it: 'Nuovo', en: 'New' }, 'Passo X')).toEqual(atteso)
  })

  it('un JSON rotto dice DOVE e perché, e porta la causa', () => {
    const err = (() => { try { parseLocalizedLabels('{non json', 'Passo Triage'); return null } catch (e) { return e as Error } })()
    expect(err?.message).toContain('Passo Triage')
    expect(err?.message).toContain('not valid JSON')
    expect(err?.cause).toBeDefined()
  })

  it('una lista o un valore che non è un oggetto si rifiutano', () => {
    for (const storto of ['[1,2]', '"testo"', '42', 'null']) {
      expect(() => parseLocalizedLabels(storto, 'Passo X')).toThrow(/must be an object/)
    }
  })

  it('un\'etichetta vuota o non testuale è un errore, e nomina la LINGUA', () => {
    expect(() => parseLocalizedLabels('{"it":""}', 'Passo X')).toThrow(/the it label/)
    expect(() => parseLocalizedLabels('{"en":123}', 'Passo X')).toThrow(/the en label/)
  })
})

describe('serializeLocalizedLabels', () => {
  it('`null` quando non c\'è niente da scrivere: sul grafo non resta un `{}`', () => {
    expect(serializeLocalizedLabels(undefined)).toBeNull()
    expect(serializeLocalizedLabels({})).toBeNull()
  })

  it('e il giro completo torna al punto di partenza', () => {
    const scritto = serializeLocalizedLabels({ it: 'Nuovo', en: 'New' })!
    expect(parseLocalizedLabels(scritto, 'X')).toEqual([
      { language: 'it', label: 'Nuovo' }, { language: 'en', label: 'New' },
    ])
  })
})

describe('localizedLabel', () => {
  const etichette = [{ language: 'it', label: 'Nuovo' }, { language: 'en', label: 'New' }]

  it('la lingua chiesta, se c\'è', () => {
    expect(localizedLabel('new', etichette, 'it')).toBe('Nuovo')
  })

  it('altrimenti quella di base: mostrare il nome interno è meglio di niente', () => {
    expect(localizedLabel('new', etichette, 'de')).toBe('new')
    expect(localizedLabel('new', etichette, null)).toBe('new')
    expect(localizedLabel('new', [], 'it')).toBe('new')
  })
})
