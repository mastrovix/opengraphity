/**
 * The platform's own server-log archive, readable from the console
 * (`/platform/server-logs`), on a real Express.
 *
 * Why these behaviours matter:
 *  - The archive is cross-tenant by construction. Only the platform identity
 *    may read it: a request the platform middleware refuses must never reach
 *    the database.
 *  - The page is the "inspectable" half of the scrubbing promise: every
 *    response must declare WHAT is stored and what is not, and return the
 *    stored rows untouched (nulls stay null, counts are numbers).
 *  - The row cap is a declared ceiling: `?limit=100000` must not turn the
 *    page into a full dump, and a nonsense limit falls back to the default.
 *  - Filters (`fingerprint`, `since`) reach the query as parameters; an
 *    absent filter is NULL, which the query reads as "no filter".
 *  - `/signatures` answers "why was no incident opened for this?" with the
 *    same verdict function the night job uses, so the two cannot disagree.
 *  - `/sink` says whether the sink is broken: "it works" must be knowable.
 *  - A database failure is a 500 with a generic body and the session is
 *    still closed.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../../lib/logger.js', () => {
  const child = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => child } }
})
const session = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(async () => {}) }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: () => session, toNumber: (v: unknown) => Number(v) }))
// The platform boundary: a request marked as a tenant user is refused here,
// exactly as the real middleware refuses a token from a customer realm.
vi.mock('../../auth/platformAuth.js', () => ({
  platformAuthMiddleware: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers['x-test-tenant-user'] === '1') { res.status(403).json({ error: 'platform identity required' }); return }
    next()
  },
}))
// Pulled in by serverLogEvents; never used by these routes.
vi.mock('../../jobs/eventIngestWorker.js', () => ({ enqueueEvents: vi.fn() }))
vi.mock('../../lib/aiSettings.js', () => ({ aiFeatureEnabled: vi.fn() }))

const { platformServerLogsRouter } = await import('../platform-server-logs.js')
const { SOGLIE } = await import('../../lib/serverLogEvents.js')
const { azzeraSink, registraRigaDelServer } = await import('../../lib/serverLogSink.js')

let server: Server
let base: string
beforeAll(async () => {
  const app = express()
  app.use(platformServerLogsRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/platform/server-logs`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })

function rec(fields: Record<string, unknown>) {
  return { get: (k: string) => fields[k] }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  azzeraSink()
})

describe('the platform boundary', () => {
  it.each(['', '/signatures', '/sink'])('a tenant user is refused on %s before any query', async (path) => {
    const res = await fetch(base + path, { headers: { 'x-test-tenant-user': '1' } })
    expect(res.status).toBe(403)
    expect(session.run).not.toHaveBeenCalled()
  })
})

describe('GET /platform/server-logs', () => {
  it('declares the projection and returns the stored rows as they are', async () => {
    vi.stubEnv('SERVER_LOG_RETENTION_DAYS', '30')
    session.run.mockResolvedValue({ records: [
      rec({ fingerprint: 'f1', day: '2026-09-20', service: 'opengrafo-api', module: 'graphql', level: 'error',
        template: 'Variable <str> not defined', stackHead: 'at x (y.ts:1)', count: '7', firstAt: '2026-09-20T01:00:00Z', lastAt: '2026-09-20T02:00:00Z' }),
      rec({ fingerprint: 'f2', day: '2026-09-19', service: 'opengrafo-worker', module: 'sla', level: 'fatal',
        template: 'SLA engine down', stackHead: null, count: 1, firstAt: '2026-09-19T01:00:00Z', lastAt: null }),
    ] })
    const res = await fetch(base)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    // What is NOT stored is part of the answer: the tenant is never in this archive.
    expect(body['notStored']).toContain('the tenant')
    expect(body['projection']).toEqual(['fingerprint', 'day', 'service', 'module', 'level', 'template', 'stackHead', 'count', 'firstAt', 'lastAt'])
    expect(body['retentionDays']).toBe(30)
    expect(body['entries']).toEqual([
      { fingerprint: 'f1', day: '2026-09-20', service: 'opengrafo-api', module: 'graphql', level: 'error',
        template: 'Variable <str> not defined', stackHead: 'at x (y.ts:1)', count: 7, firstAt: '2026-09-20T01:00:00Z', lastAt: '2026-09-20T02:00:00Z' },
      { fingerprint: 'f2', day: '2026-09-19', service: 'opengrafo-worker', module: 'sla', level: 'fatal',
        template: 'SLA engine down', stackHead: null, count: 1, firstAt: '2026-09-19T01:00:00Z', lastAt: null },
    ])
    expect(session.close).toHaveBeenCalledOnce()
  })

  it('without filters the query receives NULLs and the default limit', async () => {
    session.run.mockResolvedValue({ records: [] })
    await fetch(base)
    expect(session.run.mock.calls[0]![1]).toEqual({ firma: null, dal: null, limite: 50 })
  })

  it('forwards the filters and caps the limit at 200', async () => {
    session.run.mockResolvedValue({ records: [] })
    await fetch(`${base}?fingerprint=abc&since=2026-09-01&limit=100000`)
    expect(session.run.mock.calls[0]![1]).toEqual({ firma: 'abc', dal: '2026-09-01', limite: 200 })
  })

  it('a nonsense limit falls back to the default instead of asking for NaN rows', async () => {
    session.run.mockResolvedValue({ records: [] })
    await fetch(`${base}?limit=lots`)
    expect((session.run.mock.calls[0]![1] as { limite: number }).limite).toBe(50)
  })

  it('a repeated filter is ignored rather than passed as an array into Cypher', async () => {
    session.run.mockResolvedValue({ records: [] })
    await fetch(`${base}?fingerprint=a&fingerprint=b`)
    expect((session.run.mock.calls[0]![1] as { firma: unknown }).firma).toBeNull()
  })

  it('a database failure is a generic 500 and the session is still closed', async () => {
    session.run.mockRejectedValue(new Error('Neo4j unreachable at bolt://secret-host'))
    const res = await fetch(base)
    expect(res.status).toBe(500)
    // The internal message does not leak to the client.
    expect(await res.text()).not.toContain('secret-host')
    expect(session.close).toHaveBeenCalledOnce()
  })
})

describe('GET /platform/server-logs/signatures', () => {
  it('returns the thresholds and the verdict of the night job for each signature', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString()
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString()
    const base_ = { service: 'opengrafo-api', module: 'graphql', level: 'error', template: 't', stackHead: null, ultimoGiorno: '2026-09-20' }
    session.run.mockResolvedValue({ records: [
      rec({ ...base_, fingerprint: 'acute', occorrenzeOggi: 25, occorrenzeTotali: 25, giorniDistinti: 1, ultimoIstante: recent }),
      rec({ ...base_, fingerprint: 'quiet', occorrenzeOggi: 0, occorrenzeTotali: 50, giorniDistinti: 5, ultimoIstante: old }),
      rec({ ...base_, fingerprint: 'noise', occorrenzeOggi: 1, occorrenzeTotali: 1, giorniDistinti: 1, ultimoIstante: recent }),
    ] })
    const res = await fetch(`${base}/signatures`)
    expect(res.status).toBe(200)
    const body = await res.json() as { thresholds: unknown; signatures: Array<{ fingerprint: string; verdict: unknown }> }
    expect(body.thresholds).toEqual(SOGLIE)
    const verdicts = Object.fromEntries(body.signatures.map((s) => [s.fingerprint, s.verdict]))
    expect(verdicts).toEqual({
      acute: { stato: 'firing', severita: 'critical', motivo: 'acuto' },
      quiet: { stato: 'resolved' },
      // Below every threshold: no incident, and the page says so with null.
      noise: null,
    })
  })
})

describe('GET /platform/server-logs/sink', () => {
  it('reports the live state of the sink', async () => {
    registraRigaDelServer({ time: Date.now(), module: 'graphql', msg: 'boom' }, 'error')
    const res = await fetch(`${base}/sink`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ inAttesa: 1, scartate: 0, scritte: 0, fallimenti: 0, senzaConsenso: 0, ultimoErrore: null })
  })
})
