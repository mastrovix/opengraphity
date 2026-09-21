/**
 * UN VOCABOLARIO PER NOME NELLA TENDINA.
 *
 * Il Dizionario può portare due definizioni con lo stesso nome — quella
 * spedita col prodotto e la copia del tenant — e il campo salva il NOME:
 * offrirle tutte e due promette una scelta che non esiste. La regola deve
 * essere la stessa del server (`loadVocabularyEntries`): vince la copia del
 * tenant, si ripiega sulla spedita.
 */
import { describe, it, expect } from 'vitest'
import { vocabolariUnici } from '../FieldEditor'
import { cellaLibera } from '../FormCanvas'

const v = (name: string, label: string, isShipped: boolean) => ({ name, label, isShipped })

describe('vocabolariUnici', () => {
  it('con due definizioni dello stesso nome tiene quella del tenant', () => {
    const out = vocabolariUnici([v('ci_status', 'CI Status', true), v('ci_status', 'CI Status', false)])
    expect(out).toHaveLength(1)
    expect(out[0]?.isShipped).toBe(false)
  })

  it('non importa in che ordine arrivano', () => {
    const out = vocabolariUnici([v('os', 'Os', false), v('os', 'OS', true)])
    expect(out).toHaveLength(1)
    expect(out[0]?.label).toBe('Os')
  })

  it('senza una copia del tenant resta quella di fabbrica', () => {
    const out = vocabolariUnici([v('priority', 'Priority', true)])
    expect(out[0]?.isShipped).toBe(true)
  })

  it('le ordina per etichetta: è l’unico ordine cercabile a occhio', () => {
    const out = vocabolariUnici([v('z', 'Zeta', true), v('a', 'Alfa', true), v('m', 'Mike', true)])
    expect(out.map((x) => x.label)).toEqual(['Alfa', 'Mike', 'Zeta'])
  })
})

/*
 * IL BUCO NELLA GRIGLIA A DUE COLONNE.
 *
 * Il riquadro «lascia qui» ci si infila quando c'è, e prende la riga intera
 * quando non c'è: sbagliare il conto lascia la griglia monca o spinge il
 * riquadro su una riga sua con una cella vuota accanto.
 */
describe('cellaLibera', () => {
  const mezzo = { field: 'x', width: 'half' as const }
  const pieno = { field: 'y', width: 'full' as const }

  it('una colonna: non esiste nessun buco da riempire', () => {
    expect(cellaLibera({ items: [mezzo] })).toBe(false)
    expect(cellaLibera({ columns: 1, items: [mezzo, mezzo, mezzo] })).toBe(false)
  })

  it('due colonne, campi dispari → la riga finale ha una cella libera', () => {
    expect(cellaLibera({ columns: 2, items: [mezzo] })).toBe(true)
    expect(cellaLibera({ columns: 2, items: [mezzo, mezzo, mezzo] })).toBe(true)
  })

  it('due colonne, campi pari → nessun buco', () => {
    expect(cellaLibera({ columns: 2, items: [] })).toBe(false)
    expect(cellaLibera({ columns: 2, items: [mezzo, mezzo] })).toBe(false)
  })

  it('un campo a larghezza piena chiude la riga', () => {
    // mezzo + pieno: il pieno va su una riga sua, e la successiva riparte da zero.
    expect(cellaLibera({ columns: 2, items: [mezzo, pieno] })).toBe(false)
    expect(cellaLibera({ columns: 2, items: [pieno, mezzo] })).toBe(true)
  })
})
