import { describe, it, expect } from 'vitest'
import { dictionaryList } from './dictionaryList'

const row = (id: string, name: string, isShipped: boolean) => ({ id, name, isShipped })

describe('dictionaryList (giro UI 15 set · U-17)', () => {
  it('con la copia del cliente l\'originale spedito non compare, e la copia dice da dove viene', () => {
    const list = dictionaryList([row('s-impact', 'impact', true), row('c-impact', 'impact', false), row('s-urg', 'urgency', true)])
    expect(list.map((r) => r.id)).toEqual(['c-impact', 's-urg'])
    expect(list.find((r) => r.id === 'c-impact')?.customizedFromShipped).toBe(true)
    expect(list.find((r) => r.id === 's-urg')?.customizedFromShipped).toBe(false)
  })

  it('un vocabolario solo del cliente non è una personalizzazione', () => {
    expect(dictionaryList([row('own', 'regions', false)])).toEqual([{ ...row('own', 'regions', false), customizedFromShipped: false }])
  })

  it('senza copia (per esempio dopo averla cancellata) l\'originale torna', () => {
    expect(dictionaryList([row('s-impact', 'impact', true)]).map((r) => r.id)).toEqual(['s-impact'])
  })
})
