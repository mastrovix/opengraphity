/**
 * REST v1 main router (rest/v1/index.ts) over a real Express app.
 *
 * Why this matters: this file is the ONLY place that puts API-key
 * authentication and the rate limiter in front of every public v1 endpoint.
 * If a sub-router were mounted before the auth middleware, or the auth
 * middleware lost its async wrapper, an external client could read or write
 * tickets of a tenant without a key (or an auth failure would hang the
 * request instead of answering). The single error middleware at the end is
 * what turns typed errors thrown by any entity router into the documented
 * status codes (404/400/403) instead of a generic 500.
 *
 * The entity routers are replaced by tiny stubs: their own behaviour has
 * dedicated suites (v1Incidents, v1Kb, ...). Here we pin the wiring.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express, { Router } from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const calls = vi.hoisted(() => ({ order: [] as string[], limited: false }))

vi.mock('../../middleware/apiKeyAuth.js', async () => {
  const { GraphQLError } = await import('graphql')
  return {
    // Async, and it THROWS on a missing key: only the asyncHandler wrapper in
    // index.ts turns that rejection into a response.
    apiKeyAuth: async (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      calls.order.push('auth')
      await Promise.resolve()
      if (req.headers['x-api-key'] !== 'good') {
        throw new GraphQLError('Invalid API key', { extensions: { code: 'UNAUTHORIZED' } })
      }
      req.apiKey = { keyId: 'k1', tenantId: 'tenant-1', permissions: ['*'], rateLimit: 60 }
      next()
    },
    apiRateLimiter: (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      calls.order.push('rate')
      if (calls.limited) { res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'slow down' } }); return }
      next()
    },
  }
})

function stubRouter(name: string) {
  const r = Router()
  r.get('/', (req, res) => {
    calls.order.push(name)
    res.json({ router: name, tenant: req.apiKey?.tenantId })
  })
  r.get('/missing', async () => {
    const { NotFoundError } = await import('../../lib/errors.js')
    throw new NotFoundError('Incident', 'x')
  })
  r.get('/invalid', async () => {
    const { ValidationError } = await import('../../lib/errors.js')
    throw new ValidationError('bad input')
  })
  r.get('/crash', () => { throw new Error('secret internal detail') })
  return r
}

vi.mock('../v1/incidents.js', () => ({ incidentsRouter: stubRouter('incidents') }))
vi.mock('../v1/changes.js',   () => ({ changesRouter:   stubRouter('changes') }))
vi.mock('../v1/problems.js',  () => ({ problemsRouter:  stubRouter('problems') }))
vi.mock('../v1/ci.js',        () => ({ ciRouter:        stubRouter('ci') }))
vi.mock('../v1/kb.js',        () => ({ kbRouter:        stubRouter('kb') }))
vi.mock('../v1/import.js',    () => ({ importRouter:    stubRouter('import') }))

const { v1Router } = await import('../v1/index.js')

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use('/api/v1', v1Router)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => { calls.order.length = 0; calls.limited = false })

const get = (path: string, key: string | null = 'good') =>
  fetch(`${base}${path}`, { headers: key ? { 'x-api-key': key } : {} })

describe('v1 router — authentication in front of every entity router', () => {
  it.each(['incidents', 'changes', 'problems', 'ci', 'kb', 'import'])('/%s is mounted and sees the key tenant', async (name) => {
    const res = await get(`/${name}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ router: name, tenant: 'tenant-1' })
    // Auth first, then the rate limiter, then the entity router.
    expect(calls.order).toEqual(['auth', 'rate', name])
  })

  it('a request without a valid key is answered 401 and never reaches the entity router', async () => {
    const res = await get('/incidents', null)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } })
    expect(calls.order).toEqual(['auth'])
  })

  it('a rate-limited key is stopped before the entity router', async () => {
    calls.limited = true
    const res = await get('/changes')
    expect(res.status).toBe(429)
    expect(calls.order).toEqual(['auth', 'rate'])
  })
})

describe('v1 router — single error middleware', () => {
  it('maps a NotFoundError from an entity router to 404', async () => {
    const res = await get('/incidents/missing')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('maps a ValidationError to 400', async () => {
    const res = await get('/kb/invalid')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })

  it('an untyped error is a 500 that does not leak the internal message', async () => {
    const res = await get('/ci/crash')
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret internal detail')
  })
})
