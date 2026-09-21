/**
 * REST v1 CI router (read-only) over a real Express app: tenant-scoped
 * pagination, label whitelist for `type` (no label injection), `status` as a
 * parameter, 404 on unknown id, label predicate on every query.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'

// ── Ondata 6 (A-9): le etichette dei CI vengono dal metamodello del tenant ────
// `LoadBalancer` è un tipo creato dal cliente: deve comparire nei predicati.
// Prima questi punti usavano la lista fissa di `lib/ciLabels.ts` e i CI di quel
// tipo non contavano, in silenzio.
vi.mock('../../lib/ciLabelsForTenant.js', () => ({
  ciLabelsForTenant:         vi.fn(async () => ['Application', 'LoadBalancer', 'Server']),
  ciLabelPredicateForTenant: vi.fn(async (alias: string) => `(${alias}:Application OR ${alias}:LoadBalancer OR ${alias}:Server)`),
  apocLabelFilterForTenant:  vi.fn(async () => '+Application|+LoadBalancer|+Server'),
  ciTypeNameForLabel:        vi.fn(async (_t: string, label: string) => (label === 'LoadBalancer' ? 'load_balancer' : null)),
  clearCILabelCache:         vi.fn(),
}))

// Il metamodello del tenant: `lib/ciTypeNameToLabel.ts` ci risolve il verso
// nome del tipo → etichetta (prima era una tabella fissa o una PascalCase a mano).
vi.mock('@opengraphity/schema-generator', () => ({
  loadMetamodel: vi.fn(async () => [
    { name: 'application',   neo4jLabel: 'Application',  scope: 'base',   active: true },
    { name: 'server',        neo4jLabel: 'Server',       scope: 'base',   active: true },
    { name: 'load_balancer', neo4jLabel: 'LoadBalancer', scope: 'tenant', active: true },
  ]),
}))
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../middleware/apiKeyAuth.js', () => ({
  requirePermission: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.apiKey = { keyId: 'key-1', tenantId: 'tenant-1', permissions: ['*'], rateLimit: 60 }
    next()
  },
}))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({
  withSession: vi.fn().mockImplementation(async (fn: (s: unknown) => Promise<unknown>) => fn({ close: vi.fn() })),
}))

const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { ciRouter } = await import('../v1/ci.js')
const { restErrorHandler } = await import('../errorHandler.js')

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/ci', ciRouter)
  app.use(restErrorHandler)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/ci`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => { vi.clearAllMocks() })

type ErrBody = { error: { code: string; message: string } }
const err = async (res: Response) => (await res.json() as ErrBody).error

describe('GET /api/v1/ci', () => {
  it('paginates with integer offset/limit and the key tenant; label predicate present', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ total: 12 })
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'ci-1', name: 'db-01', type: 'server', status: 'active', environment: 'prod', extra: 'hidden' } }])
    const res = await fetch(`${base}?page=2&limit=10`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: [{ id: 'ci-1', name: 'db-01', type: 'server', status: 'active', environment: 'prod', description: null }],
      meta: { page: 2, limit: 10, total: 12 },
    })
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    // Ondata 6 (A-9): il predicato viene dal metamodello del tenant, quindi
    // comprende il tipo creato dal cliente (prima erano quindici etichette fisse).
    expect(cypher).toMatch(/\(ci:Application OR ci:LoadBalancer OR ci:Server\)/)
    expect(cypher).toMatch(/SKIP toInteger\(\$offset\) LIMIT toInteger\(\$limit\)/)
    expect(params).toEqual({ tenantId: 'tenant-1', offset: 10, limit: 10 })
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual(params)
  })

  it('type filter is mapped through the whitelist into a label (case-insensitive)', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ total: 0 })
    vi.mocked(runQuery).mockResolvedValueOnce([])
    const res = await fetch(`${base}?type=Server&status=active`)
    expect(res.status).toBe(200)
    const [, cypher, params] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toMatch(/AND ci:Server AND ci\.status = \$status/)
    expect(params).toEqual({ tenantId: 'tenant-1', offset: 0, limit: 20, status: 'active' })
  })

  it('unknown type → 400, nothing interpolated, no query', async () => {
    const res = await fetch(`${base}?type=Server)%20OR%20true%20//`)
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/Unknown CI type/)
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  // A-9: un tipo creato dal cliente è interrogabile — prima
  // `?type=load_balancer` dava 400 «Unknown CI type» perché il tipo non era
  // nella tabella dei tipi spediti col prodotto.
  it('un tipo del CLIENTE è un filtro valido e diventa la sua etichetta', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ total: 0 })
    vi.mocked(runQuery).mockResolvedValueOnce([])
    const res = await fetch(`${base}?type=load_balancer`)
    expect(res.status).toBe(200)
    const [, cypher] = vi.mocked(runQuery).mock.calls[0]!
    expect(cypher).toMatch(/AND ci:LoadBalancer/)
  })

  it('il 400 di un tipo sconosciuto elenca i tipi ammessi (del cliente compresi)', async () => {
    const res = await fetch(`${base}?type=bilanciatore`)
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/Unknown CI type: bilanciatore \(available: .*load_balancer/)
  })

  it.each(['?status[]=a', '?type[]=server', '?limit=999'])('%s → 400', async (qs) => {
    const res = await fetch(`${base}${qs}`)
    expect(res.status).toBe(400)
    expect(runQueryOne).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/ci/:id', () => {
  it('unknown id → 404', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    const res = await fetch(`${base}/ci-404`)
    expect(res.status).toBe(404)
    expect(await err(res)).toEqual({ code: 'NOT_FOUND', message: 'CI ci-404 not found' })
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toMatch(/tenant_id: \$tenantId/)
    expect(cypher).toMatch(/ci:LoadBalancer OR/)
    expect(params).toEqual({ id: 'ci-404', tenantId: 'tenant-1' })
  })

  it('found → raw properties', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'ci-1', name: 'db-01', ip: '10.0.0.1' } })
    const res = await fetch(`${base}/ci-1`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { id: 'ci-1', name: 'db-01', ip: '10.0.0.1' } })
  })
})
