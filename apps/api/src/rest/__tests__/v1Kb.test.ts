/**
 * REST v1 KB router (published articles, read-only) over a real Express app:
 * tenant-scoped pagination limited to workflow steps with category
 * 'published', 404 for unknown/unpublished slugs.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
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
const { kbRouter } = await import('../v1/kb.js')
const { restErrorHandler } = await import('../errorHandler.js')

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/kb', kbRouter)
  app.use(restErrorHandler)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/kb`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => { vi.clearAllMocks() })

type ErrBody = { error: { code: string; message: string } }
const err = async (res: Response) => (await res.json() as ErrBody).error

describe('GET /api/v1/kb', () => {
  it('lists only published articles, paginated, tenant-scoped', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ total: 1 })
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: { id: 'kb-1', title: 'VPN setup', slug: 'vpn-setup', category: 'howto', published_at: '2026-01-01', body: 'secret body' } }])
    const res = await fetch(`${base}?page=2&limit=25`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: [{ id: 'kb-1', title: 'VPN setup', slug: 'vpn-setup', category: 'howto', publishedAt: '2026-01-01' }],
      meta: { page: 2, limit: 25, total: 1 },
    })
    const [, countCypher, countParams] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(countCypher).toMatch(/s\.category = 'published'/)
    expect(countParams).toEqual({ tenantId: 'tenant-1' })
    const [, listCypher, listParams] = vi.mocked(runQuery).mock.calls[0]!
    expect(listCypher).toMatch(/CURRENT_STEP\]->\(s:WorkflowStep\)/)
    expect(listCypher).toMatch(/s\.category = 'published'/)
    expect(listCypher).toMatch(/SKIP toInteger\(\$offset\) LIMIT toInteger\(\$limit\)/)
    expect(listParams).toEqual({ tenantId: 'tenant-1', offset: 25, limit: 25 })
  })

  it.each(['?page=-1', '?limit=abc', '?page[]=1'])('%s → 400 without querying', async (qs) => {
    const res = await fetch(`${base}${qs}`)
    expect(res.status).toBe(400)
    expect((await err(res)).code).toBe('VALIDATION_ERROR')
    expect(runQueryOne).not.toHaveBeenCalled()
  })
})

describe('GET /api/v1/kb/:slug', () => {
  it('unknown or unpublished slug → 404', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    const res = await fetch(`${base}/draft-article`)
    expect(res.status).toBe(404)
    expect(await err(res)).toEqual({ code: 'NOT_FOUND', message: 'Article draft-article not found' })
    const [, cypher, params] = vi.mocked(runQueryOne).mock.calls[0]!
    expect(cypher).toMatch(/KBArticle \{slug: \$slug, tenant_id: \$tenantId\}/)
    expect(cypher).toMatch(/s\.category = 'published'/)
    expect(params).toEqual({ slug: 'draft-article', tenantId: 'tenant-1' })
  })

  it('published slug → full article properties', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { id: 'kb-1', slug: 'vpn-setup', title: 'VPN setup', body: '# Steps' } })
    const res = await fetch(`${base}/vpn-setup`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: { id: 'kb-1', slug: 'vpn-setup', title: 'VPN setup', body: '# Steps' } })
  })
})
