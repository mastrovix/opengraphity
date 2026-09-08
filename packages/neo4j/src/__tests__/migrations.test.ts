import { describe, it, expect, vi } from 'vitest'
import type { Session } from 'neo4j-driver'
import {
  runMigrations, listMigrationStatus, validateMigrations, migrationChecksum,
  MigrationError, MigrationLockError, type Migration,
} from '../migrations.js'

// ── Mock session ─────────────────────────────────────────────────────────────

interface AppliedRow { id: string; applied_at: string; checksum: string; description?: string }
interface MockState {
  applied: AppliedRow[]
  lock: { owner: string | null; locked_at: string | null }
  /** Every Cypher executed, in order, with a tag for the executor (session or tx). */
  calls: { via: 'session' | 'tx'; cypher: string; params: Record<string, unknown> | undefined }[]
}

function record(obj: Record<string, unknown>) {
  return { get: (k: string) => obj[k] }
}

function makeSession(init: Partial<MockState> = {}): { session: Session; state: MockState } {
  const state: MockState = {
    applied: init.applied ?? [],
    lock:    init.lock ?? { owner: null, locked_at: null },
    calls:   [],
  }

  const exec = async (via: 'session' | 'tx', cypher: string, params?: Record<string, unknown>) => {
    state.calls.push({ via, cypher, params })
    if (cypher.includes('MATCH (m:Migration)')) {
      return { records: state.applied.map((r) => record({ ...r, description: r.description ?? null })) }
    }
    if (cypher.includes('MERGE (l:MigrationLock')) {
      const p = params as { now: string; owner: string; expiresBefore: string }
      const free = state.lock.locked_at === null || state.lock.locked_at < p.expiresBefore
      if (free) state.lock = { owner: p.owner, locked_at: p.now }
      return { records: [record({ acquired: free, owner: state.lock.owner, locked_at: state.lock.locked_at })] }
    }
    if (cypher.includes('MATCH (l:MigrationLock')) {
      if (state.lock.owner === (params as { owner: string }).owner) state.lock = { owner: null, locked_at: null }
      return { records: [] }
    }
    if (cypher.includes('MERGE (m:Migration {id: $id})')) {
      const p = params as { id: string; now: string; checksum: string; description: string }
      state.applied = state.applied.filter((r) => r.id !== p.id)
      state.applied.push({ id: p.id, applied_at: p.now, checksum: p.checksum, description: p.description })
      return { records: [] }
    }
    return { records: [] }
  }

  const session = {
    run: (cypher: string, params?: Record<string, unknown>) => exec('session', cypher, params),
    executeWrite: async (work: (tx: unknown) => Promise<unknown>) => {
      // Emulates atomicity: the marker written inside a failing tx is rolled back.
      const snapshot = structuredClone(state.applied)
      const tx = { run: (cypher: string, params?: Record<string, unknown>) => exec('tx', cypher, params) }
      try { return await work(tx) }
      catch (err) { state.applied = snapshot; throw err }
    },
    close: async () => undefined,
  } as unknown as Session
  return { session, state }
}

const noLog = () => undefined
const fixedNow = () => new Date('2026-09-08T10:00:00.000Z')

function mig(id: string, up: Migration['up'] = async () => undefined, extra: Partial<Migration> = {}): Migration {
  return { id, description: `desc ${id}`, up, ...extra }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('validateMigrations', () => {
  it('rejects malformed and duplicate ids, sorts by id', () => {
    expect(() => validateMigrations([mig('bad-id')])).toThrow(/Invalid migration id/)
    expect(() => validateMigrations([mig('20260908_1000_a'), mig('20260908_1000_a')])).toThrow(/Duplicate/)
    const sorted = validateMigrations([mig('20260908_1010_b'), mig('20260101_0000_a')])
    expect(sorted.map((m) => m.id)).toEqual(['20260101_0000_a', '20260908_1010_b'])
  })

  it('checksum ignores whitespace, changes with the logic', () => {
    const a = mig('20260908_1000_a', async (s) => { await s.run('MATCH (n) RETURN n') })
    const b = mig('20260908_1000_a', async (s) => {
      await s.run('MATCH (n) RETURN n')
    })
    const c = mig('20260908_1000_a', async (s) => { await s.run('MATCH (x) RETURN x') })
    expect(migrationChecksum(a)).toBe(migrationChecksum(b))
    expect(migrationChecksum(a)).not.toBe(migrationChecksum(c))
  })
})

describe('runMigrations', () => {
  it('applies pending migrations in id order, each with its marker in the same transaction', async () => {
    const { session, state } = makeSession()
    const order: string[] = []
    const res = await runMigrations([
      mig('20260908_1010_second', async () => { order.push('second') }),
      mig('20260908_1000_first',  async () => { order.push('first') }),
    ], { session, log: noLog, now: fixedNow, owner: 'test:1' })

    expect(order).toEqual(['first', 'second'])
    expect(res.applied).toEqual(['20260908_1000_first', '20260908_1010_second'])
    expect(res.skipped).toEqual([])
    expect(state.applied.map((r) => r.id)).toEqual(['20260908_1000_first', '20260908_1010_second'])
    expect(state.applied[0]!.applied_at).toBe('2026-09-08T10:00:00.000Z')
    // marker written via the managed transaction, not the auto-commit session
    const marks = state.calls.filter((c) => c.cypher.includes('MERGE (m:Migration {id: $id})'))
    expect(marks.every((c) => c.via === 'tx')).toBe(true)
    // lock released
    expect(state.lock.owner).toBeNull()
  })

  it('skips already applied migrations (idempotent re-run) and does not lock when nothing is pending', async () => {
    const applied = mig('20260908_1000_first')
    const { session, state } = makeSession({
      applied: [{ id: applied.id, applied_at: 'x', checksum: migrationChecksum(applied) }],
    })
    const up = vi.fn(async () => undefined)
    const res = await runMigrations([{ ...applied, up }], { session, log: noLog })
    expect(up).not.toHaveBeenCalled()
    expect(res).toEqual({ applied: [], skipped: ['20260908_1000_first'], pending: [] })
    expect(state.calls.some((c) => c.cypher.includes('MigrationLock'))).toBe(false)
  })

  it('fails with the id of the failing migration, leaves no marker, stops there, releases the lock', async () => {
    const { session, state } = makeSession()
    const third = vi.fn(async () => undefined)
    const err = await runMigrations([
      mig('20260908_1000_ok'),
      mig('20260908_1010_boom', async () => { throw new Error('constraint violated') }),
      mig('20260908_1020_never', third),
    ], { session, log: noLog }).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(MigrationError)
    expect((err as MigrationError).migrationId).toBe('20260908_1010_boom')
    expect((err as MigrationError).message).toContain('constraint violated')
    expect(state.applied.map((r) => r.id)).toEqual(['20260908_1000_ok'])
    expect(third).not.toHaveBeenCalled()
    expect(state.lock.owner).toBeNull()
  })

  it('refuses to run while another process holds a fresh lock', async () => {
    const { session, state } = makeSession({ lock: { owner: 'other:42', locked_at: '2026-09-08T09:58:00.000Z' } })
    const up = vi.fn(async () => undefined)
    const err = await runMigrations([mig('20260908_1000_a', up)], { session, log: noLog, now: fixedNow })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(MigrationLockError)
    expect((err as MigrationLockError).owner).toBe('other:42')
    expect(up).not.toHaveBeenCalled()
    expect(state.lock.owner).toBe('other:42')   // untouched
  })

  it('takes over an expired lock (crashed process)', async () => {
    const { session, state } = makeSession({ lock: { owner: 'dead:1', locked_at: '2026-09-08T09:00:00.000Z' } })
    const res = await runMigrations([mig('20260908_1000_a')], { session, log: noLog, now: fixedNow, lockTtlMs: 10 * 60_000 })
    expect(res.applied).toEqual(['20260908_1000_a'])
    expect(state.lock.owner).toBeNull()
  })

  it('autocommit migrations run on the session and are marked afterwards', async () => {
    const { session, state } = makeSession()
    let ranOn: unknown
    await runMigrations([
      mig('20260908_1000_batched', async (s) => { ranOn = s; await s.run('CALL { … } IN TRANSACTIONS') }, { autocommit: true }),
    ], { session, log: noLog })
    expect(ranOn).toBe(session)
    const mark = state.calls.find((c) => c.cypher.includes('MERGE (m:Migration {id: $id})'))
    expect(mark?.via).toBe('session')
    expect(state.applied.map((r) => r.id)).toEqual(['20260908_1000_batched'])
  })

  it('--to applies up to the id inclusive and reports the rest as pending; unknown id is an error', async () => {
    const { session } = makeSession()
    const res = await runMigrations([
      mig('20260908_1000_a'), mig('20260908_1010_b'), mig('20260908_1020_c'),
    ], { session, log: noLog, to: '20260908_1010_b' })
    expect(res.applied).toEqual(['20260908_1000_a', '20260908_1010_b'])
    expect(res.pending).toEqual(['20260908_1020_c'])

    await expect(runMigrations([mig('20260908_1000_a')], { session, log: noLog, to: '20990101_0000_nope' }))
      .rejects.toThrow(/not a known migration id/)
  })

  it('dry-run executes nothing, takes no lock, lists what would run', async () => {
    const { session, state } = makeSession({ applied: [{ id: '20260908_1000_a', applied_at: 'x', checksum: 'c' }] })
    const up = vi.fn(async () => undefined)
    const lines: string[] = []
    const res = await runMigrations([mig('20260908_1000_a', up), mig('20260908_1010_b', up)], {
      session, dryRun: true, log: (m) => lines.push(m),
    })
    expect(up).not.toHaveBeenCalled()
    expect(res).toEqual({ applied: [], skipped: ['20260908_1000_a'], pending: ['20260908_1010_b'] })
    expect(lines.some((l) => l.includes('would apply 20260908_1010_b'))).toBe(true)
    expect(state.calls.some((c) => c.cypher.includes('MigrationLock'))).toBe(false)
  })

  it('force re-applies an already applied migration', async () => {
    const { session, state } = makeSession({ applied: [{ id: '20260908_1000_a', applied_at: 'old', checksum: 'c' }] })
    const up = vi.fn(async () => undefined)
    const res = await runMigrations([mig('20260908_1000_a', up)], { session, log: noLog, force: true, now: fixedNow })
    expect(up).toHaveBeenCalledOnce()
    expect(res.applied).toEqual(['20260908_1000_a'])
    expect(state.applied[0]!.applied_at).toBe('2026-09-08T10:00:00.000Z')
  })
})

describe('listMigrationStatus', () => {
  it('reports applied/pending, checksum drift and unknown markers', async () => {
    const a = mig('20260908_1000_a', async (s) => { await s.run('A') })
    const { session } = makeSession({
      applied: [
        { id: a.id, applied_at: '2026-09-01T00:00:00.000Z', checksum: 'stale' },
        { id: '20250101_0000_removed', applied_at: '2025-01-01T00:00:00.000Z', checksum: 'x', description: 'gone' },
      ],
    })
    const status = await listMigrationStatus(session, [a, mig('20260908_1010_b')])
    expect(status).toEqual([
      { id: '20250101_0000_removed', description: 'gone', appliedAt: '2025-01-01T00:00:00.000Z', unknown: true, checksumDrift: false },
      { id: '20260908_1000_a', description: 'desc 20260908_1000_a', appliedAt: '2026-09-01T00:00:00.000Z', unknown: false, checksumDrift: true },
      { id: '20260908_1010_b', description: 'desc 20260908_1010_b', appliedAt: null, unknown: false, checksumDrift: false },
    ])
  })
})
