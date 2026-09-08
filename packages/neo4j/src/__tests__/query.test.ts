import { describe, it, expect } from 'vitest'
import neo4j, { Neo4jError } from 'neo4j-driver'
import { toNumber, QueryError, runQuery, runQueryOne, type Queryable } from '../query.js'

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
