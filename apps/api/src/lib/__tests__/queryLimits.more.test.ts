/**
 * The query-limit rules against fragments that DO NOT resolve: a spread naming
 * a fragment that is not defined, or fragments that spread each other in a
 * cycle.
 *
 * Standard validation rejects both, but our rules run in the same pass and
 * must not crash or loop on them first: a stack overflow in `depthLimit` or
 * `fieldCountLimit` would take the request (and the event loop) down instead
 * of returning a clean validation error. So the rules stop at a missing or
 * already-visited fragment and count what they can see.
 */
import { describe, it, expect } from 'vitest'
import { buildSchema, parse, validate } from 'graphql'
import { depthLimit, fieldCountLimit, fragmentsOf } from '../queryLimits.js'

const schema = buildSchema(`
  type B { c: String, a: A }
  type A { b: B, x: String }
  type Query { a: A }
`)

/** Only our rule: the standard ones would reject these documents first. */
const errorsOf = (query: string, rule: ReturnType<typeof depthLimit>) =>
  validate(schema, parse(query), [rule]).map((e) => e.message)

describe('depthLimit with fragments that do not resolve', () => {
  it('a spread of an undefined fragment adds no depth (and does not throw)', () => {
    expect(errorsOf('query { a { ...Missing } }', depthLimit(1))).toEqual([])
    expect(errorsOf('query { a { b { c } ...Missing } }', depthLimit(1)))
      .toEqual(['Query depth 3 exceeds maximum allowed depth of 1'])
  })

  it('a fragment cycle terminates and still counts the depth along the cycle once', () => {
    const cyclic = 'query { a { ...F } } fragment F on A { b { ...G } } fragment G on B { a { ...F } }'
    // a -> b -> a, then F is already on the path: depth 3, no infinite recursion.
    expect(errorsOf(cyclic, depthLimit(2))).toEqual(['Query depth 3 exceeds maximum allowed depth of 2'])
  })
})

describe('fieldCountLimit with fragments that do not resolve', () => {
  it('an undefined fragment contributes zero fields', () => {
    expect(errorsOf('query { a { x ...Missing } }', fieldCountLimit(2))).toEqual([])
    expect(errorsOf('query { a { x ...Missing } }', fieldCountLimit(1)))
      .toEqual(['Query selects 2 fields, exceeding the maximum of 1'])
  })

  it('a fragment cycle is counted once per path, not forever', () => {
    const cyclic = 'query { a { ...F } } fragment F on A { b { ...G } } fragment G on B { a { ...F } }'
    // a, b, a: three fields before F repeats.
    expect(errorsOf(cyclic, fieldCountLimit(2))).toEqual(['Query selects 3 fields, exceeding the maximum of 2'])
    expect(errorsOf(cyclic, fieldCountLimit(3))).toEqual([])
  })
})

describe('fragmentsOf', () => {
  it('indexes fragment definitions by name and ignores operations', () => {
    const doc = parse('query Q { a { ...F } } fragment F on A { x }')
    const map = fragmentsOf(doc)
    expect([...map.keys()]).toEqual(['F'])
  })
})
