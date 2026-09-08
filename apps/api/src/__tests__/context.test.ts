/**
 * GraphQL context (context.ts) and REST auth middleware (middleware/auth.ts):
 * both are thin shells over auth/resolveAuth.ts (covered in
 * auth/__tests__/resolveAuth.test.ts). Here: the Bearer gate, the request
 * pass-through (X-Forwarded-Host reaches the resolver untouched), the
 * UNAUTHORIZED/500 mapping, and the fact that an X-API-Key is NOT a GraphQL
 * credential (API keys are REST-only, via middleware/apiKeyAuth.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type express from 'express'

const resolveAuth = vi.fn()
vi.mock('../auth/resolveAuth.js', () => ({ resolveAuth: (token: string, req: unknown) => resolveAuth(token, req) }))

const authLogError = vi.fn()
vi.mock('../lib/logger.js', () => ({
  authLogger: { error: authLogError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  logger:     { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const { buildContext } = await import('../context.js')
const { authMiddleware } = await import('../middleware/auth.js')

const CTX = { tenantId: 'tenant-a', userId: 'u-1', userEmail: 'alice@acme.io', role: 'operator' as const }
const makeReq = (headers: Record<string, string> = {}): express.Request => ({ headers } as unknown as express.Request)
const unauthorized = (msg: string) => new GraphQLError(msg, { extensions: { code: 'UNAUTHORIZED' } })

const rejectsUnauthorized = async (p: Promise<unknown>, msg?: string | RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe('UNAUTHORIZED')
  if (msg) expect((err as GraphQLError).message).toMatch(msg)
}

beforeEach(() => {
  resolveAuth.mockReset()
  authLogError.mockClear()
})

// ── buildContext (GraphQL) ───────────────────────────────────────────────────

describe('buildContext', () => {
  it('senza header Authorization → GraphQLError UNAUTHORIZED, resolveAuth mai chiamato', async () => {
    await rejectsUnauthorized(buildContext(makeReq()), /^Unauthorized$/)
    expect(resolveAuth).not.toHaveBeenCalled()
  })

  it.each(['Basic dXNlcjpwdw==', 'bearer lowercase-token', 'Bearer', 'Token abc'])(
    'schema non Bearer (%s) → UNAUTHORIZED senza risolvere', async (auth) => {
      await rejectsUnauthorized(buildContext(makeReq({ authorization: auth })))
      expect(resolveAuth).not.toHaveBeenCalled()
    },
  )

  it('X-API-Key da sola NON è una credenziale GraphQL (API key = solo REST) → UNAUTHORIZED', async () => {
    await rejectsUnauthorized(buildContext(makeReq({ 'x-api-key': 'sk_live_abc' })))
    expect(resolveAuth).not.toHaveBeenCalled()
  })

  it('Bearer valido → delega a resolveAuth(token, req) e ritorna il contesto completo', async () => {
    resolveAuth.mockResolvedValue(CTX)
    const req = makeReq({ authorization: 'Bearer kc-token' })

    await expect(buildContext(req)).resolves.toEqual(CTX)
    expect(resolveAuth).toHaveBeenCalledWith('kc-token', req)
  })

  it('la request (con X-Forwarded-Host) arriva al resolver invariata: il cross-check tenant/host vive lì', async () => {
    resolveAuth.mockResolvedValue(CTX)
    const req = makeReq({ authorization: 'Bearer t', 'x-forwarded-host': 'tenant-a.localhost', host: 'api.internal' })

    await buildContext(req)

    const passed = resolveAuth.mock.calls[0]![1] as express.Request
    expect(passed).toBe(req)
    expect(passed.headers['x-forwarded-host']).toBe('tenant-a.localhost')
  })

  it('resolveAuth che rifiuta con UNAUTHORIZED → lo stesso GraphQLError propaga (messaggio conservato)', async () => {
    resolveAuth.mockRejectedValue(unauthorized('Unauthorized: token/tenant mismatch'))
    await rejectsUnauthorized(buildContext(makeReq({ authorization: 'Bearer t' })), /tenant mismatch/)
  })

  it('errore non-auth (DB) → propaga così com\'è, non viene mascherato in 401', async () => {
    resolveAuth.mockRejectedValue(new Error('neo4j down'))
    await expect(buildContext(makeReq({ authorization: 'Bearer t' }))).rejects.toThrow('neo4j down')
  })
})

// ── authMiddleware (REST) ────────────────────────────────────────────────────

interface Outcome { status?: number; body?: unknown; nextCalled: boolean; req: express.Request }

/** Runs the (fire-and-forget) middleware and resolves when it answers or calls next. */
function runMiddleware(headers: Record<string, string>): Promise<Outcome> {
  return new Promise<Outcome>((resolve) => {
    const req = makeReq(headers)
    let status: number | undefined
    const res = {
      status(code: number) { status = code; return res },
      json(body: unknown) { resolve({ status, body, nextCalled: false, req }); return res },
    } as unknown as express.Response
    authMiddleware(req, res, () => resolve({ nextCalled: true, req }))
  })
}

describe('authMiddleware', () => {
  it('senza Bearer → 401 senza toccare il resolver', async () => {
    const out = await runMiddleware({})
    expect(out).toMatchObject({ status: 401, body: { error: 'Unauthorized' }, nextCalled: false })
    expect(resolveAuth).not.toHaveBeenCalled()
  })

  it('Bearer valido → req.user popolato dal contesto risolto e next()', async () => {
    resolveAuth.mockResolvedValue(CTX)
    const out = await runMiddleware({ authorization: 'Bearer kc-token' })

    expect(out.nextCalled).toBe(true)
    expect(out.req.user).toEqual({ tenantId: 'tenant-a', userId: 'u-1', email: 'alice@acme.io', role: 'operator' })
    expect(resolveAuth).toHaveBeenCalledWith('kc-token', out.req)
  })

  it('UNAUTHORIZED dal resolver → 401 con il messaggio del resolver', async () => {
    resolveAuth.mockRejectedValue(unauthorized('Unauthorized: user not found'))
    const out = await runMiddleware({ authorization: 'Bearer t' })
    expect(out).toMatchObject({ status: 401, body: { error: 'Unauthorized: user not found' }, nextCalled: false })
    expect(authLogError).not.toHaveBeenCalled()
  })

  it('errore non-auth (DB / ruolo corrotto) → 500 "Auth lookup failed", loggato', async () => {
    resolveAuth.mockRejectedValue(new Error('neo4j down'))
    const out = await runMiddleware({ authorization: 'Bearer t' })
    expect(out).toMatchObject({ status: 500, body: { error: 'Auth lookup failed: neo4j down' }, nextCalled: false })
    expect(authLogError).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), 'Auth resolution failed')
  })

  it('GraphQLError con codice diverso da UNAUTHORIZED (es. INTERNAL_SERVER_ERROR) → 500, non 401', async () => {
    resolveAuth.mockRejectedValue(new GraphQLError('User u-1 has no valid role', { extensions: { code: 'INTERNAL_SERVER_ERROR' } }))
    const out = await runMiddleware({ authorization: 'Bearer t' })
    expect(out.status).toBe(500)
    expect((out.body as { error: string }).error).toMatch(/no valid role/)
  })
})
