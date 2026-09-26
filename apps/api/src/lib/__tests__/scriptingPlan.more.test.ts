/**
 * The tenant scripting switch: writing it (setScriptingEnabled).
 *
 * Why this matters: the administrator flips scripts on or off in
 * Organization & access → Organization. If the write did not clear the per-process cache,
 * the switch would appear to do nothing for up to a minute on this replica —
 * scripts the admin just turned off would keep running (or stay blocked after
 * turning them on). A tenant without a :Tenant node must fail loudly: a
 * silent no-op would show "saved" while nothing changed. The write goes to
 * the WRITE session and is scoped to the tenant id it was given.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Row { plan: unknown; scriptingEnabled: unknown }
const db = vi.hoisted(() => ({
  // What a read of the tenant returns.
  readRow: null as Row | null,
  // What the write returns (null = no :Tenant node matched).
  writeRow: null as Row | null,
  reads: 0,
  writes: [] as Array<{ cypher: string; params: Record<string, unknown> }>,
  sessionModes: [] as Array<string | undefined>,
  closed: 0,
}))

vi.mock('@opengraphity/neo4j', () => {
  const recordsOf = (row: Row | null) => ({
    records: row ? [{ get: (k: string) => (row as unknown as Record<string, unknown>)[k] }] : [],
  })
  return {
    getSession: (_db?: string, mode?: string) => {
      db.sessionModes.push(mode)
      return {
        executeRead: async (fn: (tx: { run: () => Promise<unknown> }) => Promise<unknown>) =>
          fn({ run: async () => { db.reads++; return recordsOf(db.readRow) } }),
        executeWrite: async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
          fn({ run: async (cypher: string, params: Record<string, unknown>) => { db.writes.push({ cypher, params }); return recordsOf(db.writeRow) } }),
        close: async () => { db.closed++ },
      }
    },
  }
})

const { setScriptingEnabled, getScriptingPlan, invalidateScriptingPlanCache } = await import('../scriptingPlan.js')

beforeEach(() => {
  db.readRow = null; db.writeRow = null; db.reads = 0; db.writes.length = 0; db.sessionModes.length = 0; db.closed = 0
  invalidateScriptingPlanCache()
})

describe('setScriptingEnabled', () => {
  it('writes the switch on the tenant node through a WRITE session and returns the stored state', async () => {
    db.writeRow = { plan: 'starter', scriptingEnabled: true }
    await expect(setScriptingEnabled('t1', true)).resolves.toEqual({ plan: 'starter', enabled: true })
    expect(db.sessionModes).toEqual(['WRITE'])
    expect(db.writes[0]!.params).toEqual({ tenantId: 't1', enabled: true })
    expect(db.writes[0]!.cypher).toContain('SET t.scripting_enabled = $enabled')
    expect(db.closed).toBe(1)
  })

  it('reports enabled only when the stored value is literally true', async () => {
    // A non-boolean left in the graph must not read as "on".
    db.writeRow = { plan: 'pro', scriptingEnabled: 'yes' }
    await expect(setScriptingEnabled('t1', true)).resolves.toEqual({ plan: 'pro', enabled: false })
  })

  it('clears the cached plan so the next check sees the new value immediately', async () => {
    db.readRow = { plan: 'pro', scriptingEnabled: true }
    await getScriptingPlan('t1')
    await getScriptingPlan('t1')
    expect(db.reads).toBe(1)

    db.writeRow = { plan: 'pro', scriptingEnabled: false }
    await setScriptingEnabled('t1', false)
    db.readRow = { plan: 'pro', scriptingEnabled: false }
    await expect(getScriptingPlan('t1')).resolves.toEqual({ plan: 'pro', enabled: false })
    expect(db.reads).toBe(2)
  })

  it('only the switched tenant loses its cache entry', async () => {
    db.readRow = { plan: 'pro', scriptingEnabled: true }
    await getScriptingPlan('t1')
    await getScriptingPlan('t2')
    db.writeRow = { plan: 'pro', scriptingEnabled: false }
    await setScriptingEnabled('t1', false)
    await getScriptingPlan('t2')
    expect(db.reads).toBe(2)
  })

  it('a tenant without a :Tenant node fails loudly and still closes the session', async () => {
    db.writeRow = null
    await expect(setScriptingEnabled('ghost', true)).rejects.toThrow(/Tenant ghost has no :Tenant node/)
    expect(db.closed).toBe(1)
  })

  it('a failed write keeps the old cached value (nothing was changed)', async () => {
    db.readRow = { plan: 'pro', scriptingEnabled: true }
    await getScriptingPlan('t1')
    db.writeRow = null
    await expect(setScriptingEnabled('t1', false)).rejects.toThrow()
    await getScriptingPlan('t1')
    expect(db.reads).toBe(1)
  })
})

describe('getScriptingPlan — error messages carry what was found', () => {
  it('names a non-boolean scripting_enabled value', async () => {
    db.readRow = { plan: 'pro', scriptingEnabled: 'true' }
    await expect(getScriptingPlan('t1')).rejects.toThrow(/got "true"/)
  })

  it('an empty plan string is not a plan', async () => {
    db.readRow = { plan: '', scriptingEnabled: true }
    await expect(getScriptingPlan('t1')).rejects.toThrow(/has no plan \(got ""\)/)
  })
})
