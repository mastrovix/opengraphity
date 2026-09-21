/**
 * Le copie personalizzate dei vocabolari e i valori spediti DOPO la copia
 * (revisione del 14 set 2026 · F20).
 *
 * Per scelta la copia del cliente vince e il prodotto non la sovrascrive. Il
 * rovescio era che un valore spedito in seguito non arrivava mai, e nessuno lo
 * diceva. La regola:
 *   nuovi = spediti − valori della copia − spediti già VISTI dalla copia
 * dove «visti» è la lista spedita al momento della copia (o dell'ultima
 * decisione dell'amministratore). Un valore spedito che l'amministratore ha
 * tolto di proposito era già visto, quindi non torna a segnalare.
 */
import { describe, expect, it, vi } from 'vitest'

let rows: Array<Record<string, unknown>> = []
vi.mock('@opengraphity/neo4j', () => ({ runQuery: vi.fn(async () => rows) }))

const { newShippedValues, vocabulariesBehindShipped, stessaMappa } = await import('../vocabularyShippedDrift.js')

describe('newShippedValues', () => {
  it('i valori spediti che la copia non ha e non aveva visto, nell\'ordine spedito', () => {
    expect(newShippedValues(['low', 'medium', 'high', 'critical'], ['low', 'high'], ['low', 'medium', 'high'])).toEqual(['critical'])
  })
  it('un valore visto e tolto di proposito non torna', () => {
    expect(newShippedValues(['a', 'b', 'c'], ['a', 'c'], ['a', 'b', 'c'])).toEqual([])
  })
  it('una copia senza «visti» (nata prima di questo campo) segnala tutto ciò che le manca', () => {
    expect(newShippedValues(['a', 'b', 'c'], ['a'], null)).toEqual(['b', 'c'])
  })
  it('un valore rinominato nella copia non è «nuovo» se era visto', () => {
    expect(newShippedValues(['production', 'dr'], ['production', 'disaster_recovery'], ['production', 'dr'])).toEqual([])
  })
})

describe('vocabulariesBehindShipped', () => {
  it('solo le copie a cui manca qualcosa, con l\'id della copia', async () => {
    rows = [
      { id: 'c-1', name: 'priority', values: ['low', 'high'], seen: ['low', 'high'], shipped: ['low', 'high', 'critical'] },
      { id: 'c-2', name: 'impact', values: ['low', 'medium', 'high'], seen: null, shipped: ['low', 'medium', 'high'] },
    ]
    await expect(vocabulariesBehindShipped({} as never, 'c-one')).resolves.toEqual([{ id: 'c-1', name: 'priority', newValues: ['critical'] }])
    const { runQuery } = await import('@opengraphity/neo4j')
    const [, cypher, params] = vi.mocked(runQuery).mock.calls.at(-1)!
    expect(cypher).toMatch(/MATCH \(c:EnumTypeDefinition \{tenant_id: \$tenantId\}\)/)
    expect(cypher).toMatch(/MATCH \(s:EnumTypeDefinition \{tenant_id: 'system', name: c\.name\}\)/)
    expect(params).toEqual({ tenantId: 'c-one' })
  })

  it('una lista di valori rotta sul nodo è un errore che nomina il vocabolario', async () => {
    rows = [{ id: 'c-1', name: 'priority', values: '["low"]', seen: null, shipped: ['low'] }]
    await expect(vocabulariesBehindShipped({} as never, 'c-one')).rejects.toThrow(/priority/)
  })
})

/*
 * LE COPIE CHE NON AGGIUNGONO NIENTE.
 *
 * Il confronto delle etichette e dei colori per valore si fa SULLE MAPPE: come
 * stringhe, l'ordine delle chiavi dice «diverse» anche quando le coppie sono
 * le stesse — ed è l'errore che su c-one ha lasciato in piedi tre copie
 * identiche, con scritto in un commento che avevano «colori diversi».
 */
describe('stessaMappa', () => {
  it('l\u2019ordine delle chiavi non conta', () => {
    expect(stessaMappa('{"a":"x","b":"y"}', '{"b":"y","a":"x"}')).toBe(true)
  })

  it('una coppia diversa conta', () => {
    expect(stessaMappa('{"a":"x"}', '{"a":"z"}')).toBe(false)
  })

  it('una chiave in piu conta', () => {
    expect(stessaMappa('{"a":"x"}', '{"a":"x","b":"y"}')).toBe(false)
  })

  it('vuoto, nullo e «{}» sono la stessa cosa: nessuna etichetta', () => {
    expect(stessaMappa(null, '{}')).toBe(true)
    expect(stessaMappa('', null)).toBe(true)
  })

  it('un JSON illeggibile non passa per uguale a niente', () => {
    expect(stessaMappa('{rotto', '{}')).toBe(false)
  })
})

