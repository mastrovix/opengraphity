/**
 * The Cypher guard of the AI report assistant: the corners the main suite skips.
 *
 * The model writes the query, so the guard is the only thing that keeps one
 * tenant's report from reading another tenant's data or the platform's
 * secrets. Each case below is a shape a model can plausibly produce:
 *  - a pattern at the very start of the text must still be inspected (a
 *    blind spot at index 0 would let `(u:User …)` through);
 *  - an unterminated block comment must be refused, not treated as the end;
 *  - only the whitelisted apoc text/coll/map/date procedures may be CALLed,
 *    and a bare trailing CALL is refused with a readable message;
 *  - an unanchored or unlabeled node is refused with a message that tells the
 *    model how to fix it (it reads the message and retries);
 *  - negated label expressions are refused: `!Secret` would match everything
 *    else, including sensitive labels;
 *  - Neo4j integers survive redaction untouched (they carry their own methods).
 */
import { describe, it, expect } from 'vitest'
import { assertSafeReadOnlyCypher, stripCypherLiterals, redactSensitiveValue, UnsafeCypherError } from '../cypherGuard.js'

function rejection(query: string): string {
  try { assertSafeReadOnlyCypher(query) } catch (e) {
    expect(e).toBeInstanceOf(UnsafeCypherError)
    // The error prefixes the reason with "Query rejected by the security guard: ".
    return (e as Error).message.replace(/^Query rejected by the security guard: /, '')
  }
  throw new Error(`expected rejection for: ${query}`)
}

describe('stripCypherLiterals', () => {
  it('an unterminated block comment is refused', () => {
    expect(() => stripCypherLiterals('MATCH (i:Incident) /* hide the rest RETURN i')).toThrow('unterminated comment')
  })
})

describe('assertSafeReadOnlyCypher — corners', () => {
  it('a node pattern at the very start of the text is still inspected', () => {
    expect(rejection('(k:ApiKey {tenant_id: $tenantId}) RETURN k.name')).toBe('label ApiKey is not readable by reports')
    expect(() => assertSafeReadOnlyCypher('(i:Incident {tenant_id: $tenantId}) RETURN i.title')).not.toThrow()
  })

  it('CALL of a whitelisted apoc text/coll procedure is allowed', () => {
    expect(() => assertSafeReadOnlyCypher(
      "MATCH (i:Incident {tenant_id: $tenantId}) CALL apoc.coll.flatten([i.title]) YIELD value RETURN value",
    )).not.toThrow()
  })

  it('a bare trailing CALL is refused with a readable name', () => {
    expect(rejection('MATCH (i:Incident {tenant_id: $tenantId}) RETURN i CALL')).toBe('CALL <procedure> is not allowed')
  })

  it('an unanchored labeled node without alias: the message says "<no alias>" and suggests x.tenant_id', () => {
    expect(rejection('MATCH (:Incident) RETURN 1')).toBe(
      'pattern not bound to the tenant starting from (<no alias>): add {tenant_id: $tenantId} to the node or x.tenant_id = $tenantId',
    )
  })

  it('an unanchored empty node: the message shows "()"', () => {
    expect(rejection('MATCH () RETURN 1')).toContain('starting from (())')
  })

  it('an anonymous unlabeled node in an anchored path still needs a label', () => {
    expect(rejection('MATCH (i:Incident {tenant_id: $tenantId})-[:AFFECTS]->() RETURN i.title'))
      .toBe('every node needs a label: () has none — write (x:Label)')
  })

  it('a negated label expression is refused: it would match the sensitive labels too', () => {
    expect(rejection('MATCH (n:Incident!Secret {tenant_id: $tenantId}) RETURN n.title'))
      .toBe('label expressions with ! or % are not allowed: name the labels')
  })
})

describe('redactSensitiveValue', () => {
  it('a Neo4j integer is returned as is (its low/high are not map keys to filter)', () => {
    const int = { low: 3, high: 0, toNumber: () => 3 }
    expect(redactSensitiveValue(int)).toBe(int)
  })
})
