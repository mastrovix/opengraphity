/**
 * I limiti di profondità e di numero di campi CONTANO i fragment
 * (revisione totale · M-1).
 *
 * Le due regole camminavano solo la `OperationDefinition`, e uno spread `...F`
 * non ha `selectionSet`: bastava spostare il carico in un fragment per passare
 * i limiti 10/2000 indisturbati, cioè per aggirare la protezione contro
 * l'amplificazione. Qui si fissa il caso che passava.
 */
import { describe, it, expect } from 'vitest'
import { buildSchema, parse, validate, specifiedRules } from 'graphql'
import { depthLimit, fieldCountLimit } from '../queryLimits.js'

const schema = buildSchema(`
  type D { e: String }
  type C { d: D }
  type B { c: C }
  type A { b: B }
  type Query { a: A }
`)

/** Solo la nostra regola: le regole standard qui non c'entrano. */
function errori(query: string, rule: ReturnType<typeof depthLimit>): string[] {
  return validate(schema, parse(query), [rule]).map((e) => e.message)
}

describe('depthLimit', () => {
  it('conta la profondità dentro un fragment: il carico spostato in un fragment non sfugge', () => {
    // profondità reale 5: a → b → c → d → e
    const conFragment = 'query { a { ...F } } fragment F on A { b { c { d { e } } } }'
    expect(errori(conFragment, depthLimit(3))).toEqual(['Query depth 5 exceeds maximum allowed depth of 3'])
    // la stessa scritta in linea: lo stesso numero, cioè le due forme si contano uguale
    const inLinea = 'query { a { b { c { d { e } } } } }'
    expect(errori(inLinea, depthLimit(3))).toEqual(['Query depth 5 exceeds maximum allowed depth of 3'])
  })

  it('sotto il limite non dice niente, e uno spread non aggiunge un livello suo', () => {
    expect(errori('query { a { ...F } } fragment F on A { b { c { d { e } } } }', depthLimit(5))).toEqual([])
  })

  it('un fragment ciclico non manda in ricorsione infinita (lo vieta una regola standard, non questa)', () => {
    const ciclico = 'query { a { ...F } } fragment F on A { b { c { d { e } } } ...F }'
    expect(() => errori(ciclico, depthLimit(3))).not.toThrow()
    // e la regola standard è quella che lo rifiuta
    expect(validate(schema, parse(ciclico), specifiedRules).length).toBeGreaterThan(0)
  })
})

describe('fieldCountLimit', () => {
  it('conta i campi dentro un fragment; lo spread in sé non è un campo', () => {
    // a, b, c, d, e = 5 campi
    const conFragment = 'query { a { ...F } } fragment F on A { b { c { d { e } } } }'
    expect(errori(conFragment, fieldCountLimit(4))).toEqual(['Query selects 5 fields, exceeding the maximum of 4'])
    expect(errori(conFragment, fieldCountLimit(5))).toEqual([])
  })

  it('un fragment mai usato non conta: si conta quello che l\'operazione chiede', () => {
    expect(errori('query { a { b { c { d { e } } } } } fragment Inutile on A { b { c { d { e } } } }', fieldCountLimit(5))).toEqual([])
  })
})

/**
 * Review of 23 Sep 2026: each fragment spread the next one twice, and the
 * walk measured every copy again. 20 fragments took 1.4 s of validation, 30
 * would have taken tens of minutes, on the event loop every tenant shares.
 */
describe('a fragment that spreads the next one twice', () => {
  const recursive = (n: number) => {
    const parts = ['type N { b: N c: N x: String }', 'type Query { a: N }']
    const s = buildSchema(parts.join('\n'))
    const frags = Array.from({ length: n }, (_, i) =>
      i === n - 1 ? `fragment F${i} on N { x }` : `fragment F${i} on N { b { ...F${i + 1} } c { ...F${i + 1} } }`)
    return { schema: s, query: `query { a { ...F0 } } ${frags.join(' ')}` }
  }

  it('is measured once per fragment: 40 of them validate in well under a second', () => {
    const { schema: s, query } = recursive(40)
    const t0 = performance.now()
    const errors = validate(s, parse(query), [depthLimit(1000), fieldCountLimit(2000)]).map((e) => e.message)
    expect(performance.now() - t0).toBeLessThan(500)
    expect(errors.some((e) => /exceeding the maximum of 2000/.test(e))).toBe(true)
  })

  it('still counts every copy: the field count is the real one', () => {
    const { schema: s, query } = recursive(3)
    // F2 = {x} → 1; F1 = b{F2} c{F2} → 2 + 2 = 4; F0 = b{F1} c{F1} → 2 + 8 = 10; a → 11
    expect(validate(s, parse(query), [fieldCountLimit(10)]).map((e) => e.message)).toEqual(['Query selects 11 fields, exceeding the maximum of 10'])
    // depth: a → b → b → x = 4
    expect(validate(s, parse(query), [depthLimit(3)]).map((e) => e.message)).toEqual(['Query depth 4 exceeds maximum allowed depth of 3'])
  })
})
