import { describe, it, expect } from 'vitest'
import neo4j, { Neo4jError } from 'neo4j-driver'
import { toNumber, toNative, QueryError, runQuery, runQueryOne, type Queryable } from '../query.js'

describe('toNumber — the one Integer/BigInt/number converter (D-22)', () => {
  it('converts Neo4j Integer, BigInt, number and numeric strings', () => {
    expect(toNumber(neo4j.int(42))).toBe(42)
    expect(toNumber(7n)).toBe(7)
    expect(toNumber(3.5)).toBe(3.5)
    expect(toNumber('12')).toBe(12)
  })

  it('null/undefined → 0 (a missing count is zero, as every former local copy did)', () => {
    expect(toNumber(null)).toBe(0)
    expect(toNumber(undefined)).toBe(0)
  })

  it('THROWS on values that are not numbers instead of returning NaN silently', () => {
    expect(() => toNumber('abc')).toThrow(TypeError)
    expect(() => toNumber({})).toThrow(/cannot convert/)
    expect(() => toNumber(true)).toThrow(/cannot convert/)
    expect(() => toNumber(Number.NaN)).toThrow(/NaN/)
  })
})

function failingSession(err: unknown): Queryable {
  return { run: async () => { throw err } } as unknown as Queryable
}

describe('QueryError — Neo4j code/retryable preserved, Cypher out of the message (D-16)', () => {
  const cypher = 'MATCH (n:Secret {tenant_id: $tenantId}) RETURN n'

  it('wraps a Neo4jError keeping code, message and cause; the Cypher is a property', async () => {
    const cause = new Neo4jError('Node already exists', 'Neo.ClientError.Schema.ConstraintValidationFailed', '22N00', 'constraint')
    const err = await runQuery(failingSession(cause), cypher, {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(QueryError)
    const q = err as QueryError
    expect(q.name).toBe('QueryError')
    expect(q.message).toBe('Node already exists')
    expect(q.message).not.toContain('MATCH')
    expect(q.code).toBe('Neo.ClientError.Schema.ConstraintValidationFailed')
    expect(q.isConstraintViolation).toBe(true)
    expect(q.retryable).toBe(false)
    expect(q.cypher).toBe(cypher)
    expect(q.cause).toBe(cause)
  })

  it('flags transient errors as retryable', async () => {
    const cause = new Neo4jError('deadlock', 'Neo.TransientError.Transaction.DeadlockDetected', '40N00', 'deadlock')
    const err = await runQueryOne(failingSession(cause), cypher).catch((e: unknown) => e) as QueryError
    expect(err.retryable).toBe(true)
    expect(err.isConstraintViolation).toBe(false)
  })

  it('wraps non-Neo4j errors too (code undefined, message kept)', async () => {
    const err = await runQuery(failingSession(new Error('socket hang up')), cypher).catch((e: unknown) => e) as QueryError
    expect(err).toBeInstanceOf(QueryError)
    expect(err.code).toBeUndefined()
    expect(err.message).toBe('socket hang up')
  })
})

/**
 * `toNative` — dal driver a un valore che si può mettere in un JSON
 * (22 set 2026).
 *
 * È il convertitore che il BACKUP usa sui record grezzi, cioè fuori
 * dall'involucro della sessione. Se smettesse di convertire un tipo temporale,
 * il backup uscirebbe con dentro `{year: {low: 2026}, month: …}` invece di una
 * data — un file che si può scrivere e non si può rileggere, e che nessuno
 * apre finché non serve davvero.
 */
describe('toNative', () => {
  it('gli Integer diventano numeri, ricorsivamente dentro liste e mappe', () => {
    expect(toNative(neo4j.int(42))).toBe(42)
    expect(toNative([neo4j.int(1), neo4j.int(2)])).toEqual([1, 2])
    expect(toNative({ n: neo4j.int(3), dentro: { m: neo4j.int(4) } }))
      .toEqual({ n: 3, dentro: { m: 4 } })
  })

  it('i tipi temporali diventano la loro stringa ISO, non un oggetto di campi', () => {
    const d = neo4j.types.Date.fromStandardDate(new Date('2026-09-22T00:00:00Z'))
    expect(typeof toNative(d)).toBe('string')
    const dt = neo4j.types.DateTime.fromStandardDate(new Date('2026-09-22T10:30:00Z'))
    expect(typeof toNative(dt)).toBe('string')
    const dur = new neo4j.types.Duration(0, 1, 3600, 0)
    expect(typeof toNative(dur)).toBe('string')
  })

  it('null e undefined restano com\'erano: un valore assente non diventa zero', () => {
    expect(toNative(null)).toBeNull()
    expect(toNative(undefined)).toBeUndefined()
  })

  it('stringhe, numeri e booleani passano intatti', () => {
    expect(toNative('x')).toBe('x')
    expect(toNative(3.5)).toBe(3.5)
    expect(toNative(false)).toBe(false)
  })

  it('una lista vuota e una mappa vuota restano vuote', () => {
    expect(toNative([])).toEqual([])
    expect(toNative({})).toEqual({})
  })
})

/**
 * `QueryError` — l'errore che porta con sé il Cypher (22 set 2026).
 *
 * Senza, un fallimento di query dava un messaggio del driver senza contesto, e
 * capire QUALE query fosse voleva dire cercare nel codice. Le due proprietà che
 * i chiamanti guardano davvero sono `retryable` (una transazione andata in
 * deadlock si rifà) e `isConstraintViolation` (che diventa un messaggio per
 * l'utente invece di un 500).
 */
describe('QueryError', () => {
  it('porta il Cypher e la causa, e il messaggio è quello della causa', () => {
    const causa = new Error('deadlock detected')
    const e = new QueryError(causa, 'MATCH (n) RETURN n')
    expect(e.message).toBe('deadlock detected')
    expect(e.cypher).toBe('MATCH (n) RETURN n')
    expect(e.cause).toBe(causa)
    expect(e.code).toBeUndefined()
  })

  it('una causa che non è un Error diventa comunque un messaggio leggibile', () => {
    expect(new QueryError('qualcosa', 'RETURN 1').message).toBe('qualcosa')
  })

  it('da un errore del driver prende il CODICE, ed è quello che decide il resto', () => {
    const violazione = new Neo4jError('already exists', 'Neo.ClientError.Schema.ConstraintValidationFailed')
    const e = new QueryError(violazione, 'CREATE (n:User)')
    expect(e.code).toBe('Neo.ClientError.Schema.ConstraintValidationFailed')
    expect(e.isConstraintViolation).toBe(true)
  })

  it('un altro errore del driver non è una violazione di vincolo', () => {
    const altro = new Neo4jError('boom', 'Neo.TransientError.Transaction.DeadlockDetected')
    expect(new QueryError(altro, 'RETURN 1').isConstraintViolation).toBe(false)
  })
})
