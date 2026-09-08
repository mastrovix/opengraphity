/**
 * POST /api/logs/client over a real Express app (express.json() as in
 * server.ts): valid entry → 204 and a LogEntry CREATE whose tenant/user come
 * from the auth context and whose message/data travel as Cypher PARAMETERS
 * (never interpolated); bad level / array / oversized body → 4xx, no write.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { tenantId: 'tenant-1', userId: 'user-1', email: 'u@example.com', role: 'viewer' }
    next()
  },
}))

const { getSession } = await import('@opengraphity/neo4j')
const { clientLogRouter } = await import('../client-logs.js')

interface Write { q: string; p: Record<string, unknown> }
const writes: Write[] = []
const session = {
  executeWrite: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({ run: (q: string, p: Record<string, unknown>) => { writes.push({ q, p }); return Promise.resolve({ records: [] }) } })),
  close: vi.fn().mockResolvedValue(undefined),
}

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use('/api', clientLogRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/logs/client`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => {
  vi.clearAllMocks()
  writes.length = 0
  vi.mocked(getSession).mockReturnValue(session as never)
})

const post = (body: unknown, raw = false) => fetch(base, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? String(body) : JSON.stringify(body),
})

describe('POST /api/logs/client', () => {
  it('valid entry → 204; tenant/user from auth context; message and data as parameters', async () => {
    const res = await post({
      level: 'error', message: 'Uncaught TypeError', url: 'https://app/incidents/1',
      stack: 'TypeError: x\n  at y', data: { component: 'IncidentDetail' }, timestamp: '2026-09-08T10:00:00.000Z',
    })
    expect(res.status).toBe(204)
    expect(writes).toHaveLength(1)
    const { q, p } = writes[0]!
    expect(q).toMatch(/CREATE \(l:LogEntry/)
    expect(q).toMatch(/tenant_id:\s+\$tenantId/)
    expect(q).toMatch(/message:\s+\$message/)
    expect(p).toMatchObject({ tenantId: 'tenant-1', level: 'error', message: 'Uncaught TypeError', timestamp: '2026-09-08T10:00:00.000Z' })
    expect(JSON.parse(p['data'] as string)).toEqual({
      component: 'IncidentDetail', url: 'https://app/incidents/1', stack: 'TypeError: x\n  at y', userId: 'user-1',
    })
    expect(session.close).toHaveBeenCalled()
  })

  it('a client-supplied tenantId/userId in the body is ignored (identity only from auth)', async () => {
    const res = await post({ level: 'warn', message: 'm', tenantId: 'tenant-evil', userId: 'admin', data: { userId: 'admin' } })
    expect(res.status).toBe(204)
    expect(writes[0]!.p['tenantId']).toBe('tenant-1')
    expect(JSON.parse(writes[0]!.p['data'] as string)['userId']).toBe('user-1')
  })

  it('no log injection: quotes/newlines/Cypher in message never reach the query text', async () => {
    const message = `"}) DETACH DELETE l //\n MATCH (n) DETACH DELETE n`
    const res = await post({ level: 'info', message })
    expect(res.status).toBe(204)
    expect(writes[0]!.q).not.toContain('DETACH DELETE')
    expect(writes[0]!.p['message']).toBe(message)
  })

  it('missing timestamp → server time is used (ISO string)', async () => {
    const res = await post({ level: 'info', message: 'hello' })
    expect(res.status).toBe(204)
    expect(writes[0]!.p['timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(Number.isNaN(Date.parse(writes[0]!.p['timestamp'] as string))).toBe(false)
  })

  it.each(['debug', 'fatal', '', undefined, 42])('level %j → 400 and no write', async (level) => {
    const res = await post({ level, message: 'x' })
    expect(res.status).toBe(400)
    expect((await res.json() as { error: string }).error).toMatch(/level must be one of: error, warn, info/)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('JSON array body → 400 (no level), no write', async () => {
    const res = await post([{ level: 'error', message: 'x' }])
    expect(res.status).toBe(400)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('malformed JSON → 400 from the body parser, no write', async () => {
    const res = await post('{"level": "error", ', true)
    expect(res.status).toBe(400)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('body over the express.json() limit (100 kB) → 413, no write', async () => {
    const res = await post({ level: 'error', message: 'x'.repeat(120 * 1024) })
    expect(res.status).toBe(413)
    expect(getSession).not.toHaveBeenCalled()
  })
})
