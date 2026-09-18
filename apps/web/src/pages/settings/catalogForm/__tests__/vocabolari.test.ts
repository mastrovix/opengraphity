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
