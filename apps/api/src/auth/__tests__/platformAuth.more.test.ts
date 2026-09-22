/**
 * THE PLATFORM CONSOLE MIDDLEWARE, end to end.
 *
 * `resolvePlatformActor` is pinned elsewhere; this file pins what the
 * Express middleware does with its answer. If it regressed, a rejected
 * request could fall through to the tenant-deleting routes (next() called
 * on failure), or the 401 body could start leaking WHICH bar stopped it —
 * a map for whoever is probing the console. It also pins the host sources
 * the resolver reads (array header, plain `Host` fallback, missing header),
 * because nginx and direct hits deliver the host in different shapes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type express from 'express'

let payload: Record<string, unknown> | null = null
let verifyThrows: unknown = null

vi.mock('../keycloak.js', () => ({
  verifyKeycloakToken: vi.fn(async () => {
    if (verifyThrows !== null) throw verifyThrows
    return payload
  }),
}))
vi.mock('../../lib/logger.js', () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
  authLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))
// resolveAuth (imported for the issuer parser) pulls in the driver: keep it off the network.
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../lib/config.js', () => ({
  config: { platformRealm: 'opengrafo-platform', platformHost: 'Opengrafo-Admin.localhost' },
}))

const { platformAuthMiddleware, resolvePlatformActor } = await import('../platformAuth.js')

function makeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res },
    json(b: unknown) { res.body = b; return res },
  }
  return res
}

/** Runs the middleware and waits for it to either call next() or answer. */
async function runMiddleware(req: express.Request) {
  const res = makeRes()
  const next = vi.fn()
  platformAuthMiddleware(req, res as unknown as express.Response, next)
  await vi.waitFor(() => {
    if (!next.mock.calls.length && res.statusCode === 0) throw new Error('pending')
  })
  return { res, next }
}

beforeEach(() => {
  verifyThrows = null
  payload = {
    iss: 'http://localhost:8080/realms/opengrafo-platform',
    email: 'admin@example.com',
    sub: 'user-1',
  }
})

describe('platformAuthMiddleware', () => {
  it('a valid platform request gets the actor attached and proceeds', async () => {
    const req = { headers: { 'x-forwarded-host': 'opengrafo-admin.localhost', authorization: 'Bearer t' } } as unknown as express.Request
    const { res, next } = await runMiddleware(req)
    expect(next).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(0)
    expect(req.platformActor).toEqual({ email: 'admin@example.com', subject: 'user-1' })
  })

  it('a rejected request answers 401 with the fixed phrase and never reaches next()', async () => {
    const req = { headers: { 'x-forwarded-host': 'c-one.localhost', authorization: 'Bearer t' } } as unknown as express.Request
    const { res, next } = await runMiddleware(req)
    // next() on failure would hand the request to the tenant-management routes.
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
    expect(req.platformActor).toBeUndefined()
  })

  it('a verification failure that is not an Error is still a plain 401', async () => {
    verifyThrows = 'boom'
    const req = { headers: { host: 'opengrafo-admin.localhost', authorization: 'Bearer t' } } as unknown as express.Request
    const { res, next } = await runMiddleware(req)
    expect(next).not.toHaveBeenCalled()
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })
})

describe('where the host comes from', () => {
  it('an array X-Forwarded-Host counts its first value; the configured host is compared case-insensitively', async () => {
    const req = { headers: { 'x-forwarded-host': ['opengrafo-admin.localhost:443', 'evil.example'], authorization: 'Bearer t' } } as unknown as express.Request
    await expect(resolvePlatformActor(req)).resolves.toEqual({ email: 'admin@example.com', subject: 'user-1' })
  })

  it('an empty array header is not a host', async () => {
    const req = { headers: { 'x-forwarded-host': [], authorization: 'Bearer t' } } as unknown as express.Request
    await expect(resolvePlatformActor(req)).rejects.toThrow('Unauthorized')
  })

  it('without X-Forwarded-Host the plain Host header is used', async () => {
    const req = { headers: { host: 'opengrafo-admin.localhost:4000', authorization: 'Bearer t' } } as unknown as express.Request
    await expect(resolvePlatformActor(req)).resolves.toMatchObject({ subject: 'user-1' })
  })

  it('with no host at all the request is rejected', async () => {
    const req = { headers: { authorization: 'Bearer t' } } as unknown as express.Request
    await expect(resolvePlatformActor(req)).rejects.toThrow('Unauthorized')
  })

  it('an Authorization header that is not a Bearer token counts as no token', async () => {
    const req = { headers: { host: 'opengrafo-admin.localhost', authorization: 'Basic abc' } } as unknown as express.Request
    await expect(resolvePlatformActor(req)).rejects.toThrow('Unauthorized')
  })

  it('a token without an issuer is not from the platform realm: still the same plain 401', async () => {
    payload = { email: 'admin@example.com', sub: 'user-1' }
    const req = { headers: { host: 'opengrafo-admin.localhost', authorization: 'Bearer t' } } as unknown as express.Request
    // The resolver lets the issuer parser's own error through; what matters to
    // the caller is that the middleware still answers the one fixed phrase.
    await expect(resolvePlatformActor(req)).rejects.toThrow()
    const { res, next } = await runMiddleware(req)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(401)
    expect(res.body).toEqual({ error: 'Unauthorized' })
  })

  it('a non-string email or sub is treated as missing', async () => {
    payload = { iss: 'http://localhost:8080/realms/opengrafo-platform', email: 42, sub: 7 }
    const req = { headers: { host: 'opengrafo-admin.localhost', authorization: 'Bearer t' } } as unknown as express.Request
    await expect(resolvePlatformActor(req)).rejects.toThrow('Unauthorized')
  })
})
