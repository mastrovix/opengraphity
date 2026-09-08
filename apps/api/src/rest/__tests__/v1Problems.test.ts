/**
 * REST v1 problems router over a real Express app: tenant-scoped pagination,
 * 404 on unknown id, POST delegating to problemService.createProblem with the
 * API-key context, typed vs generic errors, non-string optional fields → 400.
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
vi.mock('../../services/problemService.js', () => ({ createProblem: vi.fn() }))

const { runQuery, runQueryOne } = await import('@opengraphity/neo4j')
const { createProblem } = await import('../../services/problemService.js')
const { problemsRouter } = await import('../v1/problems.js')
const { restErrorHandler } = await import('../errorHandler.js')
const { ValidationError } = await import('../../lib/errors.js')

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/problems', problemsRouter)
  app.use(restErrorHandler)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/problems`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => { vi.clearAllMocks() })

const post = (body: unknown) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
type ErrBody = { error: { code: string; message: string } }
const err = async (res: Response) => (await res.json() as ErrBody).error

const problemProps = { id: 'prb-1', tenant_id: 'tenant-1', title: 'Recurring outage', priority: 'P2', status: 'new', root_cause: null, created_at: 'c', updated_at: 'u' }

describe('GET /api/v1/problems', () => {
  it('paginates with integer offset/limit and the key tenant', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ total: 7 })
    vi.mocked(runQuery).mockResolvedValueOnce([{ props: problemProps }])
    const res = await fetch(`${base}?page=3&limit=2`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: [{ id: 'prb-1', tenantId: 'tenant-1', title: 'Recurring outage', description: null, priority: 'P2', status: 'new', rootCause: null, workaround: null, createdAt: 'c', updatedAt: 'u' }],
      meta: { page: 3, limit: 2, total: 7 },
    })
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ tenantId: 'tenant-1' })
    expect(vi.mocked(runQuery).mock.calls[0]![1]).toMatch(/SKIP toInteger\(\$offset\) LIMIT toInteger\(\$limit\)/)
    expect(vi.mocked(runQuery).mock.calls[0]![2]).toEqual({ tenantId: 'tenant-1', offset: 4, limit: 2 })
  })

  it.each(['?page=0', '?limit=1.5', '?page[]=1'])('%s → 400 without querying', async (qs) => {
    const res = await fetch(`${base}${qs}`)
    expect(res.status).toBe(400)
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('GET /:id unknown → 404 with tenant in the lookup', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    const res = await fetch(`${base}/prb-404`)
    expect(res.status).toBe(404)
    expect(await err(res)).toEqual({ code: 'NOT_FOUND', message: 'Problem prb-404 not found' })
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ id: 'prb-404', tenantId: 'tenant-1' })
  })

  it('GET /:id found → mapped problem', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce({ props: { ...problemProps, workaround: 'restart' } })
    const res = await fetch(`${base}/prb-1`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: { id: 'prb-1', workaround: 'restart' } })
  })
})

describe('POST /api/v1/problems', () => {
  it('delegates to problemService.createProblem with the API-key ctx → 201', async () => {
    vi.mocked(createProblem).mockResolvedValueOnce({ id: 'prb-new', number: 'PRB00000001' } as never)
    const res = await post({ title: 'Recurring outage', priority: 'P2', description: 'd', category: 'network', workaround: 'w', status: 'closed' })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ data: { id: 'prb-new', number: 'PRB00000001' } })
    // `status` is not an accepted input: it never reaches the service
    expect(createProblem).toHaveBeenCalledWith(
      { title: 'Recurring outage', priority: 'P2', description: 'd', category: 'network', workaround: 'w' },
      { tenantId: 'tenant-1', userId: 'key-1' },
    )
  })

  it.each([
    [{ priority: 'P2' }, /title is required/],
    [{ title: 'x' }, /priority is required/],
    [{ title: 'x', priority: 'P2', description: 5 }, /description must be a string/],
    [{ title: 'x', priority: 'P2', workaround: ['a'] }, /workaround must be a string/],
  ])('invalid body %j → 400 before the service', async (body, msg) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(msg)
    expect(createProblem).not.toHaveBeenCalled()
  })

  it('service ValidationError → 400 with the service message', async () => {
    vi.mocked(createProblem).mockRejectedValueOnce(new ValidationError('Priorità non valida: P9'))
    const res = await post({ title: 'x', priority: 'P9' })
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/Priorità non valida/)
  })

  it('unexpected error → 500 generic', async () => {
    vi.mocked(createProblem).mockRejectedValueOnce(new Error('bolt refused'))
    const res = await post({ title: 'x', priority: 'P2' })
    expect(res.status).toBe(500)
    expect(await err(res)).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' })
  })
})
