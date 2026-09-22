/**
 * The in-memory cache of Event Management sources (`InboundWebhook`).
 *
 * Why it matters: storm detection reads the source on every ingest, and the
 * cache is what keeps that off the graph. But a cache that leaks across
 * tenants, hands out a shared mutable object, or survives an invalidation
 * would make storm state wrong in ways nobody sees: a storm that never ends,
 * or an incident opened on another tenant's data. These tests pin the TTL,
 * the tenant-scoped key and query, the copies, and every invalidation shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runQueryOne = vi.fn()
const close = vi.fn(async () => undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close })),
  runQueryOne: (...a: unknown[]) => runQueryOne(...a) as unknown,
}))

const { loadSource, invalidateSourceCache, SOURCE_CACHE_TTL_MS } = await import('../sourceCache.js')

beforeEach(() => {
  invalidateSourceCache()
  runQueryOne.mockReset()
  close.mockClear()
})

describe('loadSource', () => {
  it('reads the source scoped to its tenant and closes the session', async () => {
    runQueryOne.mockResolvedValueOnce({ props: { id: 's1', storm_since: null } })
    await expect(loadSource('t1', 's1', { nowMs: 0 })).resolves.toEqual({ id: 's1', storm_since: null })
    const [, cypher, params] = runQueryOne.mock.calls[0] as [unknown, string, Record<string, unknown>]
    expect(cypher).toContain('tenant_id: $tenantId')
    expect(params).toEqual({ sourceId: 's1', tenantId: 't1' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('serves a hit within the TTL and reads again once it expired', async () => {
    runQueryOne.mockResolvedValue({ props: { id: 's1' } })
    await loadSource('t1', 's1', { nowMs: 1000 })
    await loadSource('t1', 's1', { nowMs: 1000 + SOURCE_CACHE_TTL_MS - 1 })
    expect(runQueryOne).toHaveBeenCalledTimes(1)
    await loadSource('t1', 's1', { nowMs: 1000 + SOURCE_CACHE_TTL_MS })
    expect(runQueryOne).toHaveBeenCalledTimes(2)
  })

  it('caches a missing source as null too, and serves it as null', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    await expect(loadSource('t1', 'gone', { nowMs: 0 })).resolves.toBeNull()
    await expect(loadSource('t1', 'gone', { nowMs: 1 })).resolves.toBeNull()
    expect(runQueryOne).toHaveBeenCalledTimes(1)
  })

  it('fresh: true bypasses the cache (reads under lock) and refreshes it', async () => {
    runQueryOne.mockResolvedValueOnce({ props: { storm_since: null } })
    runQueryOne.mockResolvedValueOnce({ props: { storm_since: '2026-09-22T10:00:00Z' } })
    await loadSource('t1', 's1', { nowMs: 0 })
    await expect(loadSource('t1', 's1', { nowMs: 1, fresh: true })).resolves.toEqual({ storm_since: '2026-09-22T10:00:00Z' })
    // The next non-fresh read sees the refreshed value, not the stale one.
    await expect(loadSource('t1', 's1', { nowMs: 2 })).resolves.toEqual({ storm_since: '2026-09-22T10:00:00Z' })
    expect(runQueryOne).toHaveBeenCalledTimes(2)
  })

  it('hands every caller a copy: mutating the result does not alter the cache', async () => {
    runQueryOne.mockResolvedValueOnce({ props: { storm_since: null } })
    const first = await loadSource('t1', 's1', { nowMs: 0 })
    first!['storm_since'] = 'mutated'
    const second = await loadSource('t1', 's1', { nowMs: 1 })
    second!['storm_since'] = 'mutated again'
    await expect(loadSource('t1', 's1', { nowMs: 2 })).resolves.toEqual({ storm_since: null })
  })

  it('keeps the same source id of two tenants apart', async () => {
    runQueryOne.mockResolvedValueOnce({ props: { owner: 't1' } })
    runQueryOne.mockResolvedValueOnce({ props: { owner: 't2' } })
    await expect(loadSource('t1', 's1', { nowMs: 0 })).resolves.toEqual({ owner: 't1' })
    await expect(loadSource('t2', 's1', { nowMs: 0 })).resolves.toEqual({ owner: 't2' })
  })

  it('closes the session even when the read fails, and caches nothing', async () => {
    runQueryOne.mockRejectedValueOnce(new Error('neo4j down'))
    await expect(loadSource('t1', 's1', { nowMs: 0 })).rejects.toThrow('neo4j down')
    expect(close).toHaveBeenCalledTimes(1)
    runQueryOne.mockResolvedValueOnce({ props: { id: 's1' } })
    await expect(loadSource('t1', 's1', { nowMs: 1 })).resolves.toEqual({ id: 's1' })
  })

  it('uses the wall clock when no time is given', async () => {
    runQueryOne.mockResolvedValue({ props: { id: 's1' } })
    await loadSource('t1', 's1')
    await loadSource('t1', 's1')
    expect(runQueryOne).toHaveBeenCalledTimes(1)
  })
})

describe('invalidateSourceCache', () => {
  async function prime(): Promise<void> {
    runQueryOne.mockResolvedValue({ props: {} })
    for (const [t, s] of [['t1', 'a'], ['t1', 'b'], ['t10', 'a'], ['t2', 'a']] as const) await loadSource(t, s, { nowMs: 0 })
    runQueryOne.mockClear()
  }
  const reread = async (t: string, s: string) => {
    const before = runQueryOne.mock.calls.length
    await loadSource(t, s, { nowMs: 1 })
    return runQueryOne.mock.calls.length > before
  }

  it('with a source id drops only that entry', async () => {
    await prime()
    invalidateSourceCache('t1', 'a')
    expect(await reread('t1', 'a')).toBe(true)
    expect(await reread('t1', 'b')).toBe(false)
  })

  it('with only a tenant drops that tenant, not a tenant whose id merely starts the same', async () => {
    await prime()
    invalidateSourceCache('t1')
    expect(await reread('t1', 'a')).toBe(true)
    expect(await reread('t1', 'b')).toBe(true)
    // `t10` shares the prefix `t1`: the key separator keeps it out.
    expect(await reread('t10', 'a')).toBe(false)
    expect(await reread('t2', 'a')).toBe(false)
  })

  it('with no argument drops everything', async () => {
    await prime()
    invalidateSourceCache()
    expect(await reread('t2', 'a')).toBe(true)
    expect(await reread('t10', 'a')).toBe(true)
  })
})
