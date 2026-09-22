/**
 * REST v1 importer: the malformed-upload paths and the remaining routes.
 *
 * An integration that pushes history into OpenGrafo gets only the HTTP
 * status and message back. If these regressed, a broken multipart request
 * (no boundary, a body cut off mid-upload) or a CSV the parser refuses would
 * surface as a 500 "internal error" — which the client retries forever —
 * instead of a 400 that says what to fix. The problem/change/request routes
 * are pinned to their own write permission and to the importer of their own
 * kind, with the tenant taken from the API key (never from the request).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() })) },
}))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('../../services/ticketImportService.js', () => ({
  parseCsv: vi.fn(),
  importIncidents: vi.fn(),
  importProblems: vi.fn(),
  importChanges: vi.fn(),
  importServiceRequests: vi.fn(),
  importKBArticles: vi.fn(),
}))

const svc = await import('../../services/ticketImportService.js')
const { importRouter } = await import('../v1/import.js')
const { restErrorHandler } = await import('../errorHandler.js')

const OK_RESULT = { totalRows: 1, created: 1, updated: 0, errors: [], warnings: [] }

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use((req, _res, next) => {
    const raw = typeof req.headers['x-test-perms'] === 'string' ? req.headers['x-test-perms'] : 'problems:write,changes:write,requests:write,incidents:write'
    req.apiKey = { keyId: 'key-7', tenantId: 'tenant-7', permissions: raw.split(','), rateLimit: 60 }
    next()
  })
  app.use('/api/v1/import', importRouter)
  app.use(restErrorHandler)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/import`
})
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())) })
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(svc.parseCsv).mockReturnValue([{ external_id: 'X-1' }] as never)
  for (const f of [svc.importIncidents, svc.importProblems, svc.importChanges, svc.importServiceRequests]) {
    vi.mocked(f).mockResolvedValue(OK_RESULT)
  }
})

function upload(path: string, perms?: string) {
  const fd = new FormData()
  fd.append('file', new Blob(['external_id\nX-1\n'], { type: 'text/csv' }), 'data.csv')
  const headers: Record<string, string> = {}
  if (perms !== undefined) headers['x-test-perms'] = perms
  return fetch(`${base}${path}`, { method: 'POST', body: fd, headers })
}
const errorOf = async (res: Response) => (await res.json() as { error: { code: string; message: string } }).error

describe('malformed multipart', () => {
  it('multipart without a boundary → 400 with the parser reason, not a 500', async () => {
    const res = await fetch(`${base}/incidents`, { method: 'POST', body: 'x', headers: { 'content-type': 'multipart/form-data' } })
    expect(res.status).toBe(400)
    expect((await errorOf(res)).message).toMatch(/boundary/i)
    expect(svc.importIncidents).not.toHaveBeenCalled()
  })

  it('a body cut off mid-upload → 400, and no unhandled stream error', async () => {
    // Before the fix busboy destroyed the file stream with "Unexpected end of
    // form" and nobody listened: an uncaught exception that crashes the API
    // process (vitest reports it as an unhandled error and fails the run).
    const body = '--XYZ\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\nContent-Type: text/csv\r\n\r\nexternal_id\nX-1'
    const res = await fetch(`${base}/incidents`, { method: 'POST', body, headers: { 'content-type': 'multipart/form-data; boundary=XYZ' } })
    expect(res.status).toBe(400)
    expect(svc.importIncidents).not.toHaveBeenCalled()
  })
})

describe('CSV the parser refuses', () => {
  it('a parser Error becomes a 400 "invalid CSV" with its reason', async () => {
    vi.mocked(svc.parseCsv).mockImplementation(() => { throw new Error('bad quote at line 3') })
    const res = await upload('/incidents')
    expect(res.status).toBe(400)
    expect((await errorOf(res)).message).toBe('invalid CSV: bad quote at line 3')
    expect(svc.importIncidents).not.toHaveBeenCalled()
  })

  it('a non-Error throw is still a 400, with a generic reason', async () => {
    vi.mocked(svc.parseCsv).mockImplementation(() => { throw 'nope' as unknown as Error })
    const res = await upload('/incidents')
    expect(res.status).toBe(400)
    expect((await errorOf(res)).message).toBe('invalid CSV: parse error')
  })
})

describe('problem / change / service-request routes', () => {
  it.each([
    ['/problems', 'problems:write', () => svc.importProblems],
    ['/changes', 'changes:write', () => svc.importChanges],
    ['/service-requests', 'requests:write', () => svc.importServiceRequests],
  ])('%s runs its own importer with the key tenant, dryRun off by default', async (path, _perm, importer) => {
    const res = await upload(path)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(OK_RESULT)
    expect(importer()).toHaveBeenCalledWith([{ external_id: 'X-1' }], { tenantId: 'tenant-7', userId: 'key-7' }, { dryRun: false })
    // Why: a mis-wired route would import problems as incidents.
    expect(svc.importIncidents).not.toHaveBeenCalled()
  })

  it.each([
    ['/problems', 'problems:write'],
    ['/changes', 'changes:write'],
    ['/service-requests', 'requests:write'],
  ])('%s without %s → 403', async (path, perm) => {
    const res = await upload(path, 'incidents:write')
    expect(res.status).toBe(403)
    expect((await errorOf(res)).message).toBe(`Missing permissions: ${perm}`)
  })
})
