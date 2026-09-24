/**
 * THE QUERY SCOPE (review of 23 Sep 2026, wave 7 · A2): how long a
 * transaction may run, and for whom.
 *
 * What is pinned here is what the rest of the product relies on without
 * seeing it:
 *  - a timeout reaches the database only if something sends it: the scope's
 *    when the caller gave none, the caller's otherwise — and `session.run`
 *    used to drop the caller's on the way;
 *  - EVERY session honours the scope, the raw ones of the backup and of the
 *    schema initialisation included: theirs are the long transactions;
 *  - the per-transaction memory limit is final: the driver retried it;
 *  - the tracker learns the mode, the tenant and the operation of a query.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  runInQueryScope, currentQueryScope, withScopeTimeout, isTransactionMemoryLimit,
  MAINTENANCE_SCOPE, MAINTENANCE_TX_CONFIG, MAINTENANCE_TX_TIMEOUT_MS, PAGE_READ_TIMEOUT_MS,
} from '../queryScope.js'

// The error texts Neo4j 5.26.29 gave in the probe of 24 Sep 2026.
const MEMORY_LIMIT = {
  code: 'Neo.TransientError.General.MemoryPoolOutOfMemoryError',
  message: 'The allocation of an extra 2.0 MiB would use more than the limit 20.0 MiB. Currently using 20.0 MiB. db.memory.transaction.max threshold reached',
}
const POOL_LIMIT = {
  code: 'Neo.TransientError.General.MemoryPoolOutOfMemoryError',
  message: 'The allocation of an extra 2.0 MiB would use more than the limit 2.0 GiB. Currently using 2.0 GiB. dbms.memory.transaction.total.max threshold reached',
}
const TIMED_OUT = { code: 'Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration', message: 'The transaction has been terminated.' }

describe('the scope', () => {
  it('is empty outside any work', () => {
    expect(currentQueryScope()).toEqual({})
  })

  it('a scope inside another keeps what it does not set, and an absent value does not erase one', () => {
    const seen = runInQueryScope({ readTimeoutMs: PAGE_READ_TIMEOUT_MS, tenantId: 't1', operation: 'GetIncidents' }, () =>
      runInQueryScope({ ...MAINTENANCE_SCOPE, tenantId: undefined }, () => currentQueryScope()))
    expect(seen).toEqual({
      readTimeoutMs: MAINTENANCE_TX_TIMEOUT_MS, writeTimeoutMs: MAINTENANCE_TX_TIMEOUT_MS, tenantId: 't1', operation: 'GetIncidents',
    })
  })

  it('follows the asynchronous work it started, and ends with it', async () => {
    const inside = await runInQueryScope({ tenantId: 't2' }, async () => {
      await new Promise((r) => setTimeout(r, 1))
      return currentQueryScope().tenantId
    })
    expect(inside).toBe('t2')
    expect(currentQueryScope()).toEqual({})
  })

  it('the limits are the decided ones: 30 s for a page, two hours for maintenance', () => {
    expect(PAGE_READ_TIMEOUT_MS).toBe(30_000)
    expect(MAINTENANCE_TX_TIMEOUT_MS).toBe(7_200_000)
    expect(MAINTENANCE_TX_CONFIG).toEqual({ timeout: 7_200_000 })
    expect(Object.isFrozen(MAINTENANCE_SCOPE) && Object.isFrozen(MAINTENANCE_TX_CONFIG)).toBe(true)
  })
})

describe('withScopeTimeout', () => {
  it('outside a scope the config passes as it is, the same object', () => {
    const cfg = { metadata: { a: 1 } }
    expect(withScopeTimeout(cfg, 'READ')).toBe(cfg)
    expect(withScopeTimeout(undefined, 'WRITE')).toBeUndefined()
  })

  it('in a scope, a config without a timeout gets the one of its mode; the caller\'s object is not changed', () => {
    const cfg = { metadata: { a: 1 } }
    runInQueryScope({ readTimeoutMs: 30_000 }, () => {
      expect(withScopeTimeout(cfg, 'READ')).toEqual({ metadata: { a: 1 }, timeout: 30_000 })
      expect(withScopeTimeout(undefined, 'READ')).toEqual({ timeout: 30_000 })
      // A page sets no write limit: its writes keep the server's.
      expect(withScopeTimeout(undefined, 'WRITE')).toBeUndefined()
    })
    expect(cfg).toEqual({ metadata: { a: 1 } })
  })

  it('the caller\'s timeout always wins, even a longer one in a page', () => {
    runInQueryScope({ readTimeoutMs: 30_000 }, () => {
      const cfg = { timeout: 90_000 }
      expect(withScopeTimeout(cfg, 'READ')).toBe(cfg)
    })
  })
})

describe('the memory limit of the database, told apart', () => {
  it('the per-transaction memory limit is one; the pool-wide limit is really transient and is not', () => {
    expect(isTransactionMemoryLimit(MEMORY_LIMIT)).toBe(true)
    expect(isTransactionMemoryLimit(POOL_LIMIT)).toBe(false)
    expect(isTransactionMemoryLimit({ code: 'Neo.TransientError.Transaction.DeadlockDetected', message: 'deadlock' })).toBe(false)
    expect(isTransactionMemoryLimit(null)).toBe(false)
  })
})

describe('every session honours the scope', () => {
  const raw = {
    run: vi.fn(async () => ({ records: [] })),
    beginTransaction: vi.fn(() => ({ run: vi.fn(async () => ({ records: [] })), commit: vi.fn(), rollback: vi.fn() })),
    executeRead: vi.fn(async (work: (tx: unknown) => unknown, _cfg?: unknown) => work({ run: vi.fn(async () => ({ records: [] })) })),
    executeWrite: vi.fn(async (work: (tx: unknown) => unknown, _cfg?: unknown) => work({ run: vi.fn(async () => ({ records: [] })) })),
    close: vi.fn(),
  }
  const sessionFactory = vi.fn((_cfg?: unknown) => raw)

  async function load() {
    vi.resetModules()
    vi.doMock('neo4j-driver', () => {
      const fake = {
        driver: vi.fn(() => ({ verifyConnectivity: vi.fn().mockResolvedValue(undefined), session: sessionFactory, close: vi.fn() })),
        auth: { basic: vi.fn(() => ({})) },
        session: { READ: 'READ', WRITE: 'WRITE' },
        isInt: () => false,
      }
      return { default: fake, ...fake }
    })
    // The scope module is loaded again with the driver: the store must be the same one the driver reads.
    const driver = await import('../driver.js')
    const scope = await import('../queryScope.js')
    return { ...driver, ...scope }
  }

  beforeEach(() => { vi.clearAllMocks() })

  it('a RAW session (the backup\'s, the schema\'s) gets the scope\'s timeout on run and beginTransaction', async () => {
    const { getDriver, runInQueryScope: inScope, MAINTENANCE_SCOPE: maintenance } = await load()
    await inScope(maintenance, async () => {
      const s = getDriver().session({ defaultAccessMode: 'READ' as never })
      await s.run('MATCH (n) RETURN n')
      s.beginTransaction()
    })
    expect(raw.run).toHaveBeenCalledWith('MATCH (n) RETURN n', undefined, { timeout: MAINTENANCE_TX_TIMEOUT_MS })
    expect(raw.beginTransaction).toHaveBeenCalledWith({ timeout: MAINTENANCE_TX_TIMEOUT_MS })
  })

  it('a raw session opened without a mode is a WRITE one, as in the driver: it gets the write limit', async () => {
    const { getDriver, runInQueryScope: inScope } = await load()
    await inScope({ readTimeoutMs: 1_000, writeTimeoutMs: 2_000 }, () => getDriver().session().run('CREATE (n)'))
    expect(raw.run).toHaveBeenCalledWith('CREATE (n)', undefined, { timeout: 2_000 })
  })

  it('outside a scope nothing is added: the server\'s limit applies', async () => {
    const { getDriver } = await load()
    await getDriver().session({ defaultAccessMode: 'READ' as never }).run('RETURN 1')
    expect(raw.run).toHaveBeenCalledWith('RETURN 1', undefined, undefined)
  })

  it('the wrapped session passes the caller\'s transaction config through `run` — it used to drop it', async () => {
    const { getSession } = await load()
    const s = getSession() as unknown as { run: (q: string, p: unknown, c: unknown) => Promise<unknown> }
    await s.run('MATCH (n) RETURN n', { a: 1 }, { timeout: 5_000 })
    expect(raw.run).toHaveBeenCalledWith('MATCH (n) RETURN n', { a: 1 }, { timeout: 5_000 })
  })

  it('a page\'s read through the wrapped session gets 30 s; executeRead and executeWrite get the limit of THEIR mode', async () => {
    const { getSession, runInQueryScope: inScope } = await load()
    await inScope({ readTimeoutMs: PAGE_READ_TIMEOUT_MS }, async () => {
      const s = getSession() as unknown as {
        run: (q: string) => Promise<unknown>
        executeRead: (w: (tx: unknown) => unknown) => Promise<unknown>
        executeWrite: (w: (tx: unknown) => unknown) => Promise<unknown>
      }
      await s.run('MATCH (n) RETURN n')
      await s.executeRead(() => 1)
      await s.executeWrite(() => 1)
    })
    expect(raw.run).toHaveBeenCalledWith('MATCH (n) RETURN n', undefined, { timeout: PAGE_READ_TIMEOUT_MS })
    expect(raw.executeRead.mock.calls[0]![1]).toEqual({ timeout: PAGE_READ_TIMEOUT_MS })
    expect(raw.executeWrite.mock.calls[0]![1]).toBeUndefined()
  })

  it('the memory limit inside executeRead is made final; any other error keeps what the driver said', async () => {
    const { getSession } = await load()
    const s = getSession() as unknown as { executeRead: (w: (tx: unknown) => unknown) => Promise<unknown> }
    const memory = { ...MEMORY_LIMIT, retryable: true, retriable: true }
    await expect(s.executeRead(() => { throw memory })).rejects.toBe(memory)
    expect(memory.retryable).toBe(false)
    expect(memory.retriable).toBe(false)
    const deadlock = { code: 'Neo.TransientError.Transaction.DeadlockDetected', message: 'deadlock', retryable: true }
    await expect(s.executeRead(() => { throw deadlock })).rejects.toBe(deadlock)
    expect(deadlock.retryable).toBe(true)
  })

  it('the tracker learns the mode, the scope\'s tenant and operation, and the code of an error', async () => {
    const { getSession, registerSessionTracker, runInQueryScope: inScope } = await load()
    const seen: unknown[] = []
    registerSessionTracker((_ms, query, info) => seen.push({ query, ...info }))
    raw.run.mockRejectedValueOnce(Object.assign(new Error('stopped'), TIMED_OUT))
    await inScope({ tenantId: 't1', operation: 'GetIncidents' }, async () => {
      await (getSession() as unknown as { run: (q: string) => Promise<unknown> }).run('MATCH (i:Incident) RETURN i').catch(() => undefined)
      await (getSession(undefined, 'WRITE' as never) as unknown as { run: (q: string) => Promise<unknown> }).run('CREATE (n)')
    })
    registerSessionTracker(null)
    expect(seen).toEqual([
      { query: 'MATCH (i:Incident) RETURN i', mode: 'READ', tenantId: 't1', operation: 'GetIncidents', errorCode: TIMED_OUT.code },
      { query: 'CREATE (n)', mode: 'WRITE', tenantId: 't1', operation: 'GetIncidents', errorCode: null },
    ])
  })
})
