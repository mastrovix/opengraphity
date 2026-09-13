/**
 * Le etichette per valore: cosa regge e cosa no.
 *
 * Il test che conta davvero e il RIORDINO: e la ragione per cui le etichette
 * sono una mappa e non un array parallelo, e senza di esso quella scelta
 * sembrerebbe arbitraria a chiunque la rilegga.
 */
import { describe, it, expect } from 'vitest'
import {
  titleCase, parseValueLabels, valueLabelEntries, pruneValueLabels,
  renameValueLabel, serializeValueLabels,
} from '../enumValueLabels.js'

describe('titleCase — il ripiego quando l\'etichetta manca', () => {
  it('sottolineature via, iniziali maiuscole', () => {
    expect(titleCase('mission_critical')).toBe('Mission Critical')
    expect(titleCase('high')).toBe('High')
    expect(titleCase('dr')).toBe('Dr')
  })
})

describe('parseValueLabels', () => {
  it('assente o vuoto → nessuna etichetta, nessun errore (e il caso normale)', () => {
    for (const raw of [null, undefined, '']) {
      expect(parseValueLabels(raw)).toEqual({ labels: {}, error: null })
    }
  })

  it('legge la mappa', () => {
    expect(parseValueLabels('{"high":"Alta","low":"Bassa"}').labels).toEqual({ high: 'Alta', low: 'Bassa' })
  })

  it('JSON corrotto: si perdono le etichette e lo si DICE, ma il vocabolario resta leggibile', () => {
    const r = parseValueLabels('{nope')
    expect(r.labels).toEqual({})
    expect(r.error).toMatch(/non e JSON valido/)
  })

  it('una lista o un numero non sono una mappa valore → etichetta', () => {
    expect(parseValueLabels('["Alta"]').error).toMatch(/non e un oggetto/)
    expect(parseValueLabels('42').error).toMatch(/non e un oggetto/)
  })

  it('etichette vuote o non stringa si scartano: un\'etichetta vuota non e un\'etichetta', () => {
    expect(parseValueLabels('{"high":"Alta","low":"","medium":null,"x":3}').labels).toEqual({ high: 'Alta' })
  })
})

describe('valueLabelEntries — chi legge non deve sapere che l\'etichetta puo mancare', () => {
  it('ordine dei VALORI, etichetta sempre presente', () => {
    expect(valueLabelEntries(['low', 'medium', 'high'], { high: 'Alta' })).toEqual([
      { value: 'low',    label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high',   label: 'Alta' },
    ])
  })

  /**
   * IL TEST CHE GIUSTIFICA LA MAPPA.
   *
   * Con un array di etichette allineato per indice, riordinare i valori dal
   * Dizionario avrebbe spostato «Alta» su un altro valore in silenzio. Qui il
   * riordino non tocca niente: ogni etichetta resta sul suo valore.
   */
  it('RIORDINARE i valori non sposta le etichette', () => {
    const labels = { low: 'Bassa', medium: 'Media', high: 'Alta' }
    const prima  = valueLabelEntries(['low', 'medium', 'high'], labels)
    const dopo   = valueLabelEntries(['high', 'low', 'medium'], labels)
    expect(dopo.map((e) => e.label)).toEqual(['Alta', 'Bassa', 'Media'])
    // le stesse coppie, in ordine diverso: nessuna etichetta ha cambiato valore
    expect([...dopo].sort((a, b) => a.value.localeCompare(b.value)))
      .toEqual([...prima].sort((a, b) => a.value.localeCompare(b.value)))
  })
})

describe('pruneValueLabels', () => {
  it('togliere un valore ne toglie l\'etichetta: non resta appesa', () => {
    expect(pruneValueLabels({ low: 'Bassa', high: 'Alta' }, ['high'])).toEqual({ high: 'Alta' })
  })
})

describe('renameValueLabel — l\'etichetta segue il valore', () => {
  it('la chiave si sposta', () => {
    expect(renameValueLabel({ high: 'Elevato', low: 'Bassa' }, 'high', 'alta'))
      .toEqual({ alta: 'Elevato', low: 'Bassa' })
  })

  it('un valore senza etichetta non ne inventa una', () => {
    expect(renameValueLabel({ low: 'Bassa' }, 'high', 'alta')).toEqual({ low: 'Bassa' })
  })
})

describe('serializeValueLabels', () => {
  it('mappa vuota → null, non "{}"', () => {
    expect(serializeValueLabels({})).toBeNull()
    expect(serializeValueLabels({ high: 'Alta' })).toBe('{"high":"Alta"}')
  })
})
