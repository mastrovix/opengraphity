/**
 * POST /api/logs/client — the brake and the gatekeeping around the write.
 *
 * Any authenticated user of any tenant can call this route, and since
 * 20 Sep 2026 its rows feed the platform diagnostics (and from there the
 * incidents the platform opens on itself). So:
 *  - past 60 entries per person per minute the answer is 429 with Retry-After
 *    and NOTHING is written: otherwise one looping page could flood the graph
 *    and poison the analysis;
 *  - the rate key is per tenant AND per user: one noisy user must not starve
 *    a colleague, and two tenants must never share a bucket;
 *  - an unknown level is a client error (400), not a free-form string in Neo4j;
 *  - a request that reaches the handler without `req.user` is a wiring bug and
 *    must fail loudly, never be filed under a made-up tenant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const run = vi.fn(async () => ({ records: [] }))
const close = vi.fn(async () => undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeWrite: (fn: (tx: { run: typeof run }) => unknown) => fn({ run }),
    close,
  }),
}))
vi.mock('../../middleware/auth.js', () => ({ authMiddleware: (_r: unknown, _s: unknown, next: () => void) => next() }))

const consumeMinuteRate = vi.fn<(key: string, limit: number, at: number) => Promise<{ allowed: boolean; count: number; limit: number; retryAfterSeconds: number }>>()
vi.mock('../../lib/webhookRateLimit.js', () => ({
  consumeMinuteRate: (k: string, l: number, a: number) => consumeMinuteRate(k, l, a),
}))
const registraErroreDelBrowser = vi.fn()
vi.mock('../../lib/serverLogSink.js', () => ({
  registraErroreDelBrowser: (...a: unknown[]) => { registraErroreDelBrowser(...a) },
}))

const { clientLogRouter } = await import('../client-logs.js')

type Handler = (req: unknown, res: unknown, next: (err?: unknown) => void) => void

/** The route's own handler (after the mocked authMiddleware). */
function handler(): Handler {
  const layer = (clientLogRouter as unknown as { stack: { route?: { path: string; stack: { handle: unknown }[] } }[] })
    .stack.find((l) => l.route?.path === '/logs/client')
  return layer!.route!.stack[1]!.handle as Handler
}

function fakeRes() {
  const res = {
    statusCode: 0, body: undefined as unknown, headers: {} as Record<string, string>,
    setHeader(k: string, v: string) { res.headers[k] = v; return res },
    status(c: number) { res.statusCode = c; return res },
    json(b: unknown) { res.body = b; return res },
    end() { return res },
  }
  return res
}

/** Runs the handler and resolves once it has answered or passed an error to next(). */
async function post(body: unknown, user: unknown = { tenantId: 'c-test', userId: 'u1' }) {
  const res = fakeRes()
  const err = await new Promise<unknown>((resolve) => {
    const origEnd = res.end.bind(res)
    const origJson = res.json.bind(res)
    res.end = () => { const r = origEnd(); resolve(undefined); return r }
    res.json = (b: unknown) => { const r = origJson(b); resolve(undefined); return r }
    handler()({ body, user }, res, (e?: unknown) => resolve(e))
  })
  return { res, err }
}

beforeEach(() => {
  vi.clearAllMocks()
  consumeMinuteRate.mockResolvedValue({ allowed: true, count: 1, limit: 60, retryAfterSeconds: 30 })
})

describe('the per-person brake', () => {
  it('over the limit → 429 with Retry-After, and nothing reaches Neo4j or the platform sink', async () => {
    consumeMinuteRate.mockResolvedValue({ allowed: false, count: 61, limit: 60, retryAfterSeconds: 17 })
    const { res } = await post({ level: 'error', message: 'loop' })
    expect(res.statusCode).toBe(429)
    expect(res.headers['Retry-After']).toBe('17')
    expect(res.body).toEqual({ error: 'too many client log entries: 60 per minute' })
    expect(run).not.toHaveBeenCalled()
    expect(registraErroreDelBrowser).not.toHaveBeenCalled()
  })

  it('the bucket is keyed by tenant and user, per minute, with a limit of 60', async () => {
    await post({ level: 'info', message: 'hi' }, { tenantId: 'c-one', userId: 'alice' })
    const [key, limit] = consumeMinuteRate.mock.calls[0]!
    // Why: a shared key would let one user (or tenant) exhaust someone else's quota.
    expect(key).toMatch(/^og:clientlog:rate:c-one:alice:\d+$/)
    expect(limit).toBe(60)
  })

  it('the brake runs before validation: a malformed entry still spends quota', async () => {
    // Otherwise a client could hammer the route with invalid bodies for free.
    await post({ level: 'bogus', message: 'x' })
    expect(consumeMinuteRate).toHaveBeenCalledTimes(1)
  })
})

describe('validation and wiring', () => {
  it('an unknown level → 400 naming the allowed ones, nothing written', async () => {
    const { res } = await post({ level: 'fatal', message: 'x' })
    expect(res.statusCode).toBe(400)
    expect(res.body).toEqual({ error: 'level must be one of: error, warn, info' })
    expect(run).not.toHaveBeenCalled()
  })

  it('a blank message → 400', async () => {
    const { res } = await post({ level: 'warn', message: '   ' })
    expect(res.statusCode).toBe(400)
    expect(run).not.toHaveBeenCalled()
  })

  it('without req.user the handler fails loudly instead of inventing a tenant', async () => {
    const { err } = await post({ level: 'error', message: 'x' }, null)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/req\.user missing/)
    expect(consumeMinuteRate).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('an accepted entry is written under the caller tenant and handed to the platform sink with the SERVER time', async () => {
    const { res } = await post({ level: 'error', message: 'SSE down', stack: 'at x', timestamp: '1999-01-01T00:00:00Z' })
    expect(res.statusCode).toBe(204)
    const params = (run.mock.calls[0] as unknown as [string, Record<string, string>])[1]
    expect(params['tenantId']).toBe('c-test')
    const [msg, level, when, stack] = registraErroreDelBrowser.mock.calls[0]!
    expect([msg, level, stack]).toEqual(['SSE down', 'error', 'at x'])
    expect(when).toBe(params['timestamp'])
    expect(String(when)).not.toContain('1999')
    expect(close).toHaveBeenCalled()
  })
})
