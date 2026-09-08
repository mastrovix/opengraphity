import { describe, it, expect, vi } from 'vitest'
import neo4j from 'neo4j-driver'
import { runQuery, runQueryOne, toNative, type Queryable } from '../query.js'

// query.test.ts covers toNumber and the QueryError wrapping. Here: record →
// plain-object mapping, toNative conversions, runQueryOne cardinality and the
// session-ownership contract.

type Row = Record<string, unknown>

function fakeSession(rows: Row[]) {
  const run = vi.fn(async (_cypher: string, _params?: Record<string, unknown>) => ({
    records: rows.map(r => ({ keys: Object.keys(r), get: (k: string) => r[k] })),
  }))
  const close = vi.fn(async () => {})
  return { run, close, session: { run, close } as unknown as Queryable }
}

describe('runQuery — records become plain JSON-friendly objects', () => {
  it('maps every record key; Integer/BigInt → number, temporal → ISO string, recursively', async () => {
    const { session, run } = fakeSession([
      {
        id: 'inc-1',
        count: neo4j.int(3),
        nested: { n: neo4j.int(7), list: [neo4j.int(1), 'x', null], deep: { d: neo4j.Date.fromStandardDate(new Date(Date.UTC(2026, 8, 8))) } },
        when: new neo4j.types.DateTime(2026, 9, 8, 10, 30, 0, 0, 0),
        dur: new neo4j.types.Duration(0, 1, 30, 0),
        flag: true,
        nothing: null,
      },
    ])
    const rows = await runQuery<Record<string, unknown>>(session, 'MATCH (n) RETURN n', { tenantId: 't1' })
    expect(run).toHaveBeenCalledWith('MATCH (n) RETURN n', { tenantId: 't1' })
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r['id']).toBe('inc-1')
    expect(r['count']).toBe(3)
    expect(r['nested']).toEqual({ n: 7, list: [1, 'x', null], deep: { d: '2026-09-08' } })
    expect(r['when']).toBe('2026-09-08T10:30:00Z')
    expect(typeof r['dur']).toBe('string')
    expect(r['dur']).toMatch(/^P/)
    expect(r['flag']).toBe(true)
    expect(r['nothing']).toBeNull()
  })

  it('params default to {} (the driver rejects undefined params)', async () => {
    const { session, run } = fakeSession([])
    await runQuery(session, 'RETURN 1')
    expect(run.mock.calls[0]![1]).toEqual({})
  })

  it('empty result → []', async () => {
    const { session } = fakeSession([])
    expect(await runQuery(session, 'RETURN 1')).toEqual([])
  })

  it('does NOT close the session/transaction — the caller owns it (Queryable may be a ManagedTransaction)', async () => {
    const { session, close } = fakeSession([{ a: 1 }])
    await runQuery(session, 'RETURN 1')
    await runQueryOne(session, 'RETURN 1')
    await runQuery({ run: async () => { throw new Error('x') } } as unknown as Queryable, 'RETURN 1').catch(() => undefined)
    expect(close).not.toHaveBeenCalled()
  })
})

describe('runQueryOne — cardinality', () => {
  it('no rows → null', async () => {
    const { session } = fakeSession([])
    expect(await runQueryOne(session, 'RETURN 1')).toBeNull()
  })

  it('one row → that row', async () => {
    const { session } = fakeSession([{ id: 'a', n: neo4j.int(1) }])
    expect(await runQueryOne(session, 'RETURN 1')).toEqual({ id: 'a', n: 1 })
  })

  it('pinned: more than one row → the FIRST row, silently (no error on ambiguous results)', async () => {
    const { session } = fakeSession([{ id: 'first' }, { id: 'second' }])
    expect(await runQueryOne(session, 'RETURN 1')).toEqual({ id: 'first' })
  })
})

describe('toNative — exported converter', () => {
  it('passes through primitives and null/undefined', () => {
    expect(toNative(null)).toBeNull()
    expect(toNative(undefined)).toBeUndefined()
    expect(toNative('s')).toBe('s')
    expect(toNative(2.5)).toBe(2.5)
    expect(toNative(false)).toBe(false)
  })

  it('converts Integer at any depth, keeps plain-object shape, and arrays stay arrays', () => {
    expect(toNative([neo4j.int(1), [neo4j.int(2)], { x: neo4j.int(3) }])).toEqual([1, [2], { x: 3 }])
    expect(toNative({ properties: { count: neo4j.int(9) }, labels: ['A'] })).toEqual({ properties: { count: 9 }, labels: ['A'] })
  })

  it('converts a large Integer to a JS number', () => {
    expect(toNative(neo4j.int('9007199254740991'))).toBe(9007199254740991)
  })
})
