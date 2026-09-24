/**
 * The graph's integrity from the platform console (`/platform/integrity`,
 * wave 7 · A3), on a real Express.
 *
 * Why these behaviours matter:
 *  - the tenant lints let a traversal from a scoped anchor go without naming
 *    the tenant: that holds only while no edge joins two tenants, and this is
 *    the one place that checks it on the live graph;
 *  - the check reads every relationship: the platform identity only, the
 *    maintenance limit, and a found edge is an error line in the log;
 *  - the answer is tenant ids and label names, never a node's data.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  cypher: [] as string[],
  scopes: [] as unknown[],
  closed: 0,
  logError: vi.fn(),
}))
vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: h.logError, debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
vi.mock('../../auth/platformAuth.js', () => ({
  platformAuthMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers['x-test-tenant-user'] === '1') { res.status(403).json({ error: 'platform identity required' }); return }
    next()
  },
}))
vi.mock('@opengraphity/neo4j', () => ({
  MAINTENANCE_SCOPE: { readTimeoutMs: 7_200_000, writeTimeoutMs: 7_200_000 },
  runInQueryScope: (scope: unknown, fn: () => unknown) => { h.scopes.push(scope); return fn() },
  getSession: () => ({ close: async () => { h.closed++ } }),
  runQuery: async (_s: unknown, cypher: string) => { h.cypher.push(cypher); return h.rows },
}))

const { platformIntegrityRouter } = await import('../platform-integrity.js')
const { CROSS_TENANT_EDGES_CYPHER, CROSS_TENANT_GROUPS_SHOWN } = await import('../../lib/crossTenantEdges.js')

let server: Server
let url: string
beforeAll(async () => {
  const app = express()
  app.use(platformIntegrityRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()) })
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/platform/integrity/cross-tenant-edges`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => { h.rows = []; h.cypher = []; h.scopes = []; h.closed = 0; h.logError.mockClear() })

describe('GET /platform/integrity/cross-tenant-edges', () => {
  it('a clean graph: zero, nothing in the error log, the session closed, the maintenance limit', async () => {
    const res = await fetch(url)
    expect(res.status).toBe(200)
    const body = await res.json() as { total: number; groups: unknown[]; checkedAt: string; durationMs: number }
    expect(body).toMatchObject({ total: 0, groups: [] })
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false)
    expect(h.cypher).toEqual([CROSS_TENANT_EDGES_CYPHER])
    expect(h.scopes).toEqual([{ readTimeoutMs: 7_200_000, writeTimeoutMs: 7_200_000 }])
    expect(h.closed).toBe(1)
    expect(h.logError).not.toHaveBeenCalled()
  })

  it('edges between tenants: the total over every group, the groups capped, an error line in the log', async () => {
    h.rows = Array.from({ length: CROSS_TENANT_GROUPS_SHOWN + 5 }, (_, i) => ({
      fromTenant: 'a', toTenant: 'b', type: `T${String(i)}`, fromLabels: ['Incident'], toLabels: ['ConfigurationItem', 'Server'], count: 2,
    }))
    const body = await (await fetch(url)).json() as { total: number; groups: Array<{ count: number }> }
    expect(body.total).toBe(2 * (CROSS_TENANT_GROUPS_SHOWN + 5))
    expect(body.groups).toHaveLength(CROSS_TENANT_GROUPS_SHOWN)
    expect(h.logError).toHaveBeenCalledWith(expect.objectContaining({ total: body.total }), 'Edges between different tenants found')
  })

  it('only the platform identity reaches it', async () => {
    const res = await fetch(url, { headers: { 'x-test-tenant-user': '1' } })
    expect(res.status).toBe(403)
    expect(h.cypher).toEqual([])
  })
})

describe('CROSS_TENANT_EDGES_CYPHER', () => {
  it('two different tenants, neither the shared system one; ids and labels only, never properties', () => {
    expect(CROSS_TENANT_EDGES_CYPHER).toContain('a.tenant_id <> b.tenant_id')
    expect(CROSS_TENANT_EDGES_CYPHER).toContain("a.tenant_id <> 'system' AND b.tenant_id <> 'system'")
    const returned = /RETURN([\s\S]*?)ORDER BY/.exec(CROSS_TENANT_EDGES_CYPHER)![1]!.split(',').map((c) => c.trim())
    expect(returned).toEqual([
      'a.tenant_id AS fromTenant', 'b.tenant_id AS toTenant', 'type(r) AS type',
      'labels(a) AS fromLabels', 'labels(b) AS toLabels', 'count(*) AS count',
    ])
  })
})
