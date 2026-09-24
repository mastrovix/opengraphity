/**
 * `check:cross-tenant-edges` (wave 7 · A3): the command the CI runs against a
 * real Neo4j (C2). It must FAIL when an edge joins two tenants — a check that
 * only prints is a check nobody reads — and say which ones.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  main: null as null | (() => Promise<void>),
  result: { total: 0, groups: [] as Array<Record<string, unknown>> },
  closed: 0,
}))
vi.mock('../lib/runScript.js', () => ({ runScript: (_name: string, main: () => Promise<void>) => { h.main = main } }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: () => ({ close: async () => { h.closed++ } }) }))
vi.mock('../../lib/crossTenantEdges.js', () => ({ crossTenantEdges: async () => h.result }))

await import('../check-cross-tenant-edges.js')

beforeEach(() => { h.closed = 0; h.result = { total: 0, groups: [] } })

describe('check-cross-tenant-edges', () => {
  it('a clean graph passes, and the session is closed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await h.main!()
    expect(log).toHaveBeenCalledWith('✓ no relationship between different tenants')
    expect(h.closed).toBe(1)
    log.mockRestore()
  })

  it('an edge between tenants fails the command, naming each group', async () => {
    h.result = { total: 3, groups: [{ fromTenant: 'a', toTenant: 'b', type: 'AFFECTS', fromLabels: ['Incident'], toLabels: ['ConfigurationItem'], count: 3 }] }
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(h.main!()).rejects.toThrow('3 relationship(s) join two different tenants')
    expect(err).toHaveBeenCalledWith('  a Incident -[:AFFECTS]-> ConfigurationItem b: 3')
    expect(h.closed).toBe(1)
    err.mockRestore()
  })
})
