/**
 * REST API-key middleware (middleware/apiKeyAuth.ts):
 *  - the key is looked up by sha256 hash, the plaintext never reaches Cypher;
 *  - expiry/disable are enforced by the lookup query itself (`enabled: true`,
 *    `expires_at > $now`) — pinned on the query text + params;
 *  - usage stats are a fire-and-forget WRITE that never blocks or fails the request;
 *  - the per-key in-memory limiter answers 429 with `retry_after`;
 *  - requirePermission is an exact-match check (no wildcard).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import type { Request, Response, NextFunction } from 'express'

interface FakeSession { mode: string | undefined; close: ReturnType<typeof vi.fn> }
const sessions: FakeSession[] = []
const runQueryOne = vi.fn()

vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn((_db?: string, mode?: string) => {
    const s: FakeSession = { mode, close: vi.fn().mockResolvedValue(undefined) }
    sessions.push(s)
    return s
  }),
  runQueryOne: (...args: unknown[]) => runQueryOne(...args),
}))

const logError = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  logger: { error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// Fake timers BEFORE the import: the module registers a module-level
// setInterval (bucket pruning) that must not outlive the test worker.
vi.useFakeTimers()
const T0 = new Date('2026-09-08T10:00:00.000Z')
vi.setSystemTime(T0)

const { apiKeyAuth, apiRateLimiter, requirePermission } = await import('../apiKeyAuth.js')

afterAll(() => { vi.useRealTimers() })

// ── Helpers ──────────────────────────────────────────────────────────────────

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

interface FakeRes {
  statusCode: number
  body: unknown
  headers: Record<string, string>
  status(code: number): FakeRes
  json(body: unknown): FakeRes
  setHeader(name: string, value: string): FakeRes
  set(name: string, value: string): FakeRes
}
function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    body: undefined,
    headers: {},
    status(code) { res.statusCode = code; return res },
    json(body) { res.body = body; return res },
    setHeader(name, value) { res.headers[name.toLowerCase()] = value; return res },
    set(name, value) { res.headers[name.toLowerCase()] = value; return res },
  }
  return res
}
const asRes = (r: FakeRes) => r as unknown as Response
const makeReq = (headers: Record<string, string> = {}): Request => ({ headers } as unknown as Request)

const keyRow = (over: Record<string, unknown> = {}) => ({
  props: { id: 'key-1', tenant_id: 'tenant-1', permissions: ['incidents:read'], rate_limit: 5, ...over },
})

/** Drains the microtask queue (fire-and-forget promise chains). */
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

const errBody = (res: FakeRes) => res.body as { error: { code: string; message: string; retry_after?: number } }

beforeEach(() => {
  runQueryOne.mockReset()
  logError.mockClear()
  sessions.length = 0
  vi.setSystemTime(T0)
})

// ── apiKeyAuth ───────────────────────────────────────────────────────────────

describe('apiKeyAuth — header', () => {
  it('header mancante → 401 UNAUTHORIZED, nessuna query', async () => {
    const res = makeRes(); const next = vi.fn()
    await apiKeyAuth(makeReq(), asRes(res), next as NextFunction)
    expect(res.statusCode).toBe(401)
    expect(errBody(res).error).toEqual({ code: 'UNAUTHORIZED', message: 'Missing X-API-Key header' })
    expect(runQueryOne).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('header vuoto → 401 (stringa vuota trattata come assente)', async () => {
    const res = makeRes(); const next = vi.fn()
    await apiKeyAuth(makeReq({ 'x-api-key': '' }), asRes(res), next as NextFunction)
    expect(res.statusCode).toBe(401)
    expect(runQueryOne).not.toHaveBeenCalled()
  })
})

describe('apiKeyAuth — chiave valida', () => {
  it('popola req.apiKey (keyId, tenantId, permissions, rateLimit) e chiama next', async () => {
    runQueryOne.mockResolvedValueOnce(keyRow()).mockResolvedValueOnce({ id: 'key-1' })
    const req = makeReq({ 'x-api-key': 'sk_live_secret' }); const res = makeRes(); const next = vi.fn()

    await apiKeyAuth(req, asRes(res), next as NextFunction)

    expect(next).toHaveBeenCalledOnce()
    expect(req.apiKey).toEqual({ keyId: 'key-1', tenantId: 'tenant-1', permissions: ['incidents:read'], rateLimit: 5 })
    expect(res.statusCode).toBe(0)
  })

  it('la lookup usa lo sha256 della chiave: la chiave in chiaro non compare mai nei parametri', async () => {
    runQueryOne.mockResolvedValueOnce(keyRow()).mockResolvedValueOnce(null)
    await apiKeyAuth(makeReq({ 'x-api-key': 'sk_live_secret' }), asRes(makeRes()), vi.fn() as NextFunction)

    const [session, query, params] = runQueryOne.mock.calls[0] as [FakeSession, string, Record<string, unknown>]
    expect(session).toBe(sessions[0])
    expect(params).toEqual({ keyHash: sha256('sk_live_secret'), now: '2026-09-08T10:00:00.000Z' })
    expect(JSON.stringify(params)).not.toContain('sk_live_secret')
    expect(query).toContain('ApiKey {key_hash: $keyHash')
  })

  it('la query esclude le chiavi disabilitate e quelle scadute (enabled: true, expires_at > $now)', async () => {
    runQueryOne.mockResolvedValueOnce(keyRow()).mockResolvedValueOnce(null)
    await apiKeyAuth(makeReq({ 'x-api-key': 'k' }), asRes(makeRes()), vi.fn() as NextFunction)

    const query = runQueryOne.mock.calls[0]![1] as string
    expect(query).toMatch(/enabled: true/)
    expect(query).toMatch(/k\.expires_at IS NULL OR k\.expires_at > \$now/)
  })

  it('chiave scaduta/disabilitata/sconosciuta (lookup senza riga) → 401 Invalid API key, nessuna scrittura', async () => {
    runQueryOne.mockResolvedValueOnce(null)
    const req = makeReq({ 'x-api-key': 'expired' }); const res = makeRes(); const next = vi.fn()

    await apiKeyAuth(req, asRes(res), next as NextFunction)

    expect(res.statusCode).toBe(401)
    expect(errBody(res).error).toEqual({ code: 'UNAUTHORIZED', message: 'Invalid API key' })
    expect(next).not.toHaveBeenCalled()
    expect(req.apiKey).toBeUndefined()
    expect(runQueryOne).toHaveBeenCalledTimes(1)     // nessun update di last_used_at
    expect(sessions).toHaveLength(1)                 // nessuna sessione WRITE aperta
    expect(sessions[0]!.close).toHaveBeenCalledOnce()
  })

  it('la scadenza è valutata con l\'ora corrente (now = orologio finto)', async () => {
    vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'))
    runQueryOne.mockResolvedValueOnce(null)
    await apiKeyAuth(makeReq({ 'x-api-key': 'k' }), asRes(makeRes()), vi.fn() as NextFunction)
    expect((runQueryOne.mock.calls[0]![2] as { now: string }).now).toBe('2027-01-01T00:00:00.000Z')
  })

  it('permissions serializzate come JSON string → parsate; rate_limit assente → 60', async () => {
    runQueryOne.mockResolvedValueOnce(keyRow({ permissions: '["ci:read","kb:read"]', rate_limit: undefined })).mockResolvedValueOnce(null)
    const req = makeReq({ 'x-api-key': 'k' })
    await apiKeyAuth(req, asRes(makeRes()), vi.fn() as NextFunction)
    expect(req.apiKey).toEqual({ keyId: 'key-1', tenantId: 'tenant-1', permissions: ['ci:read', 'kb:read'], rateLimit: 60 })
  })

  it('errore DB nella lookup → 500 INTERNAL_ERROR, loggato, sessione chiusa', async () => {
    runQueryOne.mockRejectedValueOnce(new Error('neo4j down'))
    const res = makeRes(); const next = vi.fn()
    await apiKeyAuth(makeReq({ 'x-api-key': 'k' }), asRes(res), next as NextFunction)

    expect(res.statusCode).toBe(500)
    expect(errBody(res).error).toEqual({ code: 'INTERNAL_ERROR', message: 'Authentication error' })
    expect(next).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining('Error validating API key'))
    expect(sessions[0]!.close).toHaveBeenCalledOnce()
  })
})

describe('apiKeyAuth — aggiornamento last_used_at (fire-and-forget)', () => {
  it('apre una sessione WRITE e aggiorna last_used_at/request_count con lo stesso hash', async () => {
    runQueryOne.mockResolvedValueOnce(keyRow()).mockResolvedValueOnce({ id: 'key-1' })
    await apiKeyAuth(makeReq({ 'x-api-key': 'sk' }), asRes(makeRes()), vi.fn() as NextFunction)
    await flush()

    expect(runQueryOne).toHaveBeenCalledTimes(2)
    const [session, query, params] = runQueryOne.mock.calls[1] as [FakeSession, string, Record<string, unknown>]
    expect(session.mode).toBe('WRITE')
    expect(sessions[0]!.mode).toBeUndefined()        // la lookup usa la sessione di default (read)
    expect(query).toMatch(/SET k\.last_used_at = \$now, k\.request_count = coalesce\(k\.request_count, 0\) \+ 1/)
    expect(params).toEqual({ keyHash: sha256('sk'), now: '2026-09-08T10:00:00.000Z' })
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('next() è chiamato prima che la scrittura finisca (non bloccante)', async () => {
    let resolveWrite!: (v: unknown) => void
    runQueryOne
      .mockResolvedValueOnce(keyRow())
      .mockImplementationOnce(() => new Promise((r) => { resolveWrite = r }))
    const next = vi.fn()
    await apiKeyAuth(makeReq({ 'x-api-key': 'sk' }), asRes(makeRes()), next as NextFunction)

    expect(next).toHaveBeenCalledOnce()             // la write è ancora pendente
    resolveWrite({ id: 'key-1' })
    await flush()
    expect(sessions[1]!.close).toHaveBeenCalledOnce()
  })

  it('la scrittura che fallisce NON cambia la risposta: next già chiamato, errore loggato, sessione chiusa', async () => {
    runQueryOne.mockResolvedValueOnce(keyRow()).mockRejectedValueOnce(new Error('write failed'))
    const res = makeRes(); const next = vi.fn()
    await apiKeyAuth(makeReq({ 'x-api-key': 'sk' }), asRes(res), next as NextFunction)
    await flush()

    expect(next).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(0)
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining('Failed to update usage stats'))
    expect(sessions[1]!.close).toHaveBeenCalledOnce()
  })
})

// ── apiRateLimiter ───────────────────────────────────────────────────────────

describe('apiRateLimiter', () => {
  const reqFor = (keyId: string, rateLimit: number): Request =>
    ({ headers: {}, apiKey: { keyId, tenantId: 't', permissions: [], rateLimit } } as unknown as Request)

  it('senza req.apiKey passa oltre (il limiter non è un gate di autenticazione)', () => {
    const next = vi.fn()
    apiRateLimiter(makeReq(), asRes(makeRes()), next as NextFunction)
    expect(next).toHaveBeenCalledOnce()
  })

  it('la N+1-esima richiesta nella finestra → 429 RATE_LIMITED con retry_after in secondi', () => {
    const results: FakeRes[] = []
    for (let i = 0; i < 3; i++) {
      const res = makeRes()
      apiRateLimiter(reqFor('rl-key-a', 2), asRes(res), vi.fn() as NextFunction)
      results.push(res)
    }
    expect(results[0]!.statusCode).toBe(0)
    expect(results[1]!.statusCode).toBe(0)
    expect(results[2]!.statusCode).toBe(429)
    expect(errBody(results[2]!).error).toEqual({ code: 'RATE_LIMITED', message: 'Rate limit exceeded (2/min)', retry_after: 60 })
  })

  it('retry_after decresce con il tempo trascorso nella finestra', () => {
    apiRateLimiter(reqFor('rl-key-b', 1), asRes(makeRes()), vi.fn() as NextFunction)
    vi.advanceTimersByTime(45_000)
    const res = makeRes()
    apiRateLimiter(reqFor('rl-key-b', 1), asRes(res), vi.fn() as NextFunction)
    expect(res.statusCode).toBe(429)
    expect(errBody(res).error.retry_after).toBe(15)
  })

  it('la 429 dovrebbe portare anche l\'header HTTP Retry-After — BUG: apiKeyAuth.ts:113 imposta solo body.retry_after, nessun header (i client REST standard leggono Retry-After)', () => {
    apiRateLimiter(reqFor('rl-key-hdr', 1), asRes(makeRes()), vi.fn() as NextFunction)
    const res = makeRes()
    apiRateLimiter(reqFor('rl-key-hdr', 1), asRes(res), vi.fn() as NextFunction)
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBe('60')
  })

  it('dopo 60s la finestra si azzera e la chiave passa di nuovo', () => {
    apiRateLimiter(reqFor('rl-key-c', 1), asRes(makeRes()), vi.fn() as NextFunction)
    const blocked = makeRes()
    apiRateLimiter(reqFor('rl-key-c', 1), asRes(blocked), vi.fn() as NextFunction)
    expect(blocked.statusCode).toBe(429)

    vi.advanceTimersByTime(60_000)
    const next = vi.fn(); const res = makeRes()
    apiRateLimiter(reqFor('rl-key-c', 1), asRes(res), next as NextFunction)
    expect(next).toHaveBeenCalledOnce()
    expect(res.statusCode).toBe(0)
  })

  it('i bucket sono per chiave: un\'altra chiave non è influenzata', () => {
    apiRateLimiter(reqFor('rl-key-d', 1), asRes(makeRes()), vi.fn() as NextFunction)
    const blocked = makeRes()
    apiRateLimiter(reqFor('rl-key-d', 1), asRes(blocked), vi.fn() as NextFunction)
    expect(blocked.statusCode).toBe(429)

    const next = vi.fn()
    apiRateLimiter(reqFor('rl-key-e', 1), asRes(makeRes()), next as NextFunction)
    expect(next).toHaveBeenCalledOnce()
  })

  it('il prune periodico (60s) rimuove i bucket scaduti senza rompere le richieste successive', () => {
    apiRateLimiter(reqFor('rl-key-f', 1), asRes(makeRes()), vi.fn() as NextFunction)
    vi.advanceTimersByTime(120_000)      // scatta almeno un giro di setInterval con resetAt <= now
    const next = vi.fn()
    apiRateLimiter(reqFor('rl-key-f', 1), asRes(makeRes()), next as NextFunction)
    expect(next).toHaveBeenCalledOnce()
  })
})

// ── requirePermission ────────────────────────────────────────────────────────

describe('requirePermission', () => {
  const withPerms = (permissions: string[]): Request =>
    ({ headers: {}, apiKey: { keyId: 'k', tenantId: 't', permissions, rateLimit: 60 } } as unknown as Request)

  it('senza req.apiKey → 401 Not authenticated', () => {
    const res = makeRes(); const next = vi.fn()
    requirePermission('incidents:read')(makeReq(), asRes(res), next as NextFunction)
    expect(res.statusCode).toBe(401)
    expect(errBody(res).error.code).toBe('UNAUTHORIZED')
    expect(next).not.toHaveBeenCalled()
  })

  it('permesso presente → next', () => {
    const next = vi.fn()
    requirePermission('incidents:read')(withPerms(['incidents:read', 'ci:read']), asRes(makeRes()), next as NextFunction)
    expect(next).toHaveBeenCalledOnce()
  })

  it('permesso assente → 403 FORBIDDEN con l\'elenco dei mancanti', () => {
    const res = makeRes(); const next = vi.fn()
    requirePermission('incidents:read', 'incidents:write')(withPerms(['incidents:read']), asRes(res), next as NextFunction)
    expect(res.statusCode).toBe(403)
    expect(errBody(res).error).toEqual({ code: 'FORBIDDEN', message: 'Missing permissions: incidents:write' })
    expect(next).not.toHaveBeenCalled()
  })

  it('"*" NON è un wildcard: il confronto è esatto (coerente con la UI, che non offre "*")', () => {
    const res = makeRes(); const next = vi.fn()
    requirePermission('incidents:read')(withPerms(['*']), asRes(res), next as NextFunction)
    expect(res.statusCode).toBe(403)
    expect(next).not.toHaveBeenCalled()
  })

  it('senza scope richiesti passa sempre (lista vuota di mancanti)', () => {
    const next = vi.fn()
    requirePermission()(withPerms([]), asRes(makeRes()), next as NextFunction)
    expect(next).toHaveBeenCalledOnce()
  })
})
