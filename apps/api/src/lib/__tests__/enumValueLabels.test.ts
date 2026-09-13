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
  renameValueLabel, serializeValueLabels, labelFor,
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

  it('legge la mappa per lingua', () => {
    expect(parseValueLabels('{"high":{"it":"Alta","en":"High"}}').labels)
      .toEqual({ high: { it: 'Alta', en: 'High' } })
  })

  /**
   * La PRIMA versione di questa mappa teneva una etichetta sola
   * (`{"high":"Alta"}`). La migrazione 1730 la converte, ma un tenant che non
   * l'ha ancora ricevuta non deve perdere le etichette nel frattempo — e una
   * stringa li significa «italiano», che e cio che quella versione scriveva.
   */
  it('accetta ANCORA la forma vecchia e la legge come italiano', () => {
    expect(parseValueLabels('{"high":"Alta"}').labels).toEqual({ high: { it: 'Alta' } })
  })

  it('una lingua che il prodotto non ha si scarta, non si salva come italiana', () => {
    expect(parseValueLabels('{"high":{"it":"Alta","de":"Hoch"}}').labels)
      .toEqual({ high: { it: 'Alta' } })
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
    expect(parseValueLabels('{"high":{"it":"Alta"},"low":{"it":""},"medium":null,"x":3}').labels)
      .toEqual({ high: { it: 'Alta' } })
  })
})

describe('valueLabelEntries — chi legge non deve sapere che l\'etichetta puo mancare', () => {
  it('ordine dei VALORI, etichetta sempre presente nella lingua chiesta', () => {
    const labels = { high: { it: 'Alta', en: 'High' } }
    expect(valueLabelEntries(['low', 'high'], labels, 'en', 'it')).toEqual([
      { value: 'low',  label: 'Low',  labels: [] },
      // Le lingue nell'ordine di `LINGUE`, che e l'ordine dei campi nel
      // Dizionario: l'inglese e la prima da quando l'elenco parte da 'en'.
      { value: 'high', label: 'High', labels: [{ language: 'en', label: 'High' }, { language: 'it', label: 'Alta' }] },
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
    const labels = { low: { it: 'Bassa' }, medium: { it: 'Media' }, high: { it: 'Alta' } }
    const prima  = valueLabelEntries(['low', 'medium', 'high'], labels, 'it', 'it')
    const dopo   = valueLabelEntries(['high', 'low', 'medium'], labels, 'it', 'it')
    expect(dopo.map((e) => e.label)).toEqual(['Alta', 'Bassa', 'Media'])
    // le stesse coppie, in ordine diverso: nessuna etichetta ha cambiato valore
    expect([...dopo].sort((a, b) => a.value.localeCompare(b.value)))
      .toEqual([...prima].sort((a, b) => a.value.localeCompare(b.value)))
  })
})

describe('pruneValueLabels', () => {
  it('togliere un valore ne toglie l\'etichetta: non resta appesa', () => {
    expect(pruneValueLabels({ low: { it: 'Bassa' }, high: { it: 'Alta' } }, ['high']))
      .toEqual({ high: { it: 'Alta' } })
  })
})

describe('renameValueLabel — l\'etichetta segue il valore', () => {
  it('la chiave si sposta, con TUTTE le sue lingue', () => {
    expect(renameValueLabel({ high: { it: 'Elevato', en: 'High' }, low: { it: 'Bassa' } }, 'high', 'alta'))
      .toEqual({ alta: { it: 'Elevato', en: 'High' }, low: { it: 'Bassa' } })
  })

  it('un valore senza etichetta non ne inventa una', () => {
    expect(renameValueLabel({ low: { it: 'Bassa' } }, 'high', 'alta')).toEqual({ low: { it: 'Bassa' } })
  })
})

describe('serializeValueLabels', () => {
  it('mappa vuota → null, non "{}"', () => {
    expect(serializeValueLabels({})).toBeNull()
    expect(serializeValueLabels({ high: { it: 'Alta' } })).toBe('{"high":{"it":"Alta"}}')
  })
})

/**
 * IL RIPIEGO, DICHIARATO: lingua chiesta → italiano → valore con le iniziali
 * maiuscole. Il passaggio per l'italiano e una scelta: un'etichetta scritta in
 * una lingua sola serve meglio del nome interno del valore.
 */
describe('labelFor', () => {
  const labels = { high: { it: 'Alto', en: 'High' }, medium: { it: 'Medio' } }

  it('la lingua chiesta, quando c\'e', () => {
    expect(labelFor('high', labels, 'en', 'it')).toBe('High')
    expect(labelFor('high', labels, 'it', 'en')).toBe('Alto')
  })

  /**
   * IL RIPIEGO E' UN PARAMETRO, non una costante.
   *
   * Era `LINGUA_PREDEFINITA = 'it'` dentro questo file: un'installazione per un
   * cliente irlandese leggeva le etichette a meta in italiano, e l'unico modo
   * di cambiarlo era ricompilare. Ora il ripiego e la lingua predefinita DEL
   * CLIENTE, che si configura dall'interfaccia — e questi due casi mostrano che
   * la stessa mappa, con due ripieghi diversi, si legge diversamente.
   */
  it('manca la lingua chiesta → il ripiego che il chiamante dichiara', () => {
    expect(labelFor('medium', labels, 'en', 'it')).toBe('Medio')
  })

  it('manca anche il ripiego → il valore con le iniziali maiuscole, non una lingua indovinata', () => {
    // `medium` ha solo l'italiano: con ripiego inglese non c'e niente da
    // leggere, e si legge il valore. Nessuna lingua «di sistema» a cui
    // appoggiarsi di nascosto.
    expect(labelFor('medium', labels, 'en', 'en')).toBe('Medium')
  })

  it('manca del tutto → il valore con le iniziali maiuscole', () => {
    expect(labelFor('mission_critical', labels, 'en', 'it')).toBe('Mission Critical')
  })
})
