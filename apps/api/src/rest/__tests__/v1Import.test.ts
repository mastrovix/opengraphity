/**
 * REST v1 importer over a real Express app with real multipart uploads
 * (FormData/Blob → busboy) and the REAL requirePermission middleware:
 * missing permission → 403; non-multipart / no `file` field / header-only CSV
 * → 400 with a message; > 20 MB → 400; dryRun=true reaches the importer as
 * {dryRun: true}; importer ValidationError → 400, other errors → 500.
 * The importers themselves are mocked; parseCsv is the real one.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// Ondata 7: la traduzione fra valori di dominio è una lettura (la matrice è
// dato del cliente). Qui si misura altro: il doppio risponde con la matrice di
// fabbrica e i vocabolari spediti, senza grafo (lib/__tests__/domainMatrixFake.ts).
vi.mock('../../lib/domainMatrix.js', () => import('../../lib/__tests__/domainMatrixFake.js'))

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(), runQuery: vi.fn(), runQueryOne: vi.fn() }))
vi.mock('@opengraphity/workflow', () => ({ workflowEngine: {} }))
vi.mock('../../graphql/resolvers/ci-utils.js', () => ({ withSession: vi.fn(), getSession: vi.fn() }))
vi.mock('../../lib/workflowHelpers.js', () => ({ getWorkflowSteps: vi.fn() }))
vi.mock('../../services/ticketImportService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/ticketImportService.js')>()
  return { ...actual, importIncidents: vi.fn(), importKBArticles: vi.fn() }
})

const { importIncidents, importKBArticles } = await import('../../services/ticketImportService.js')
const { importRouter } = await import('../v1/import.js')
const { restErrorHandler } = await import('../errorHandler.js')
const { ValidationError } = await import('../../lib/errors.js')

const OK_RESULT = { totalRows: 2, created: 2, updated: 0, errors: [], warnings: [] }

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  // Inject the API-key context; permissions come from a test header so the
  // REAL requirePermission decides 403 vs pass.
  app.use((req, _res, next) => {
    const raw = typeof req.headers['x-test-perms'] === 'string' ? req.headers['x-test-perms'] : 'incidents:write,kb:write'
    req.apiKey = { keyId: 'key-1', tenantId: 'tenant-1', permissions: raw ? raw.split(',') : [], rateLimit: 60 }
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
  vi.mocked(importIncidents).mockResolvedValue(OK_RESULT)
  vi.mocked(importKBArticles).mockResolvedValue(OK_RESULT)
})

const CSV = 'external_id,title,severity\nINC-1,Disk full,high\nINC-2,"Slow, very slow",low\n'

interface UploadOpts { path?: string; query?: string; csv?: string | Uint8Array; field?: string; perms?: string; noFile?: boolean }
function upload(opts: UploadOpts = {}) {
  const fd = new FormData()
  if (!opts.noFile) fd.append(opts.field ?? 'file', new Blob([opts.csv ?? CSV], { type: 'text/csv' }), 'data.csv')
  else fd.append('note', 'no file here')
  const headers: Record<string, string> = {}
  if (opts.perms !== undefined) headers['x-test-perms'] = opts.perms
  return fetch(`${base}${opts.path ?? '/incidents'}${opts.query ?? ''}`, { method: 'POST', body: fd, headers })
}
type ErrBody = { error: { code: string; message: string } }
const err = async (res: Response) => (await res.json() as ErrBody).error

describe('POST /api/v1/import/incidents — permissions and upload validation', () => {
  it('missing incidents:write → 403 from requirePermission, body never parsed', async () => {
    const res = await upload({ perms: 'incidents:read' })
    expect(res.status).toBe(403)
    expect(await err(res)).toEqual({ code: 'FORBIDDEN', message: 'Missing permissions: incidents:write' })
    expect(importIncidents).not.toHaveBeenCalled()
  })

  it('kb-articles needs kb:write (incidents:write alone → 403)', async () => {
    const res = await upload({ path: '/kb-articles', perms: 'incidents:write' })
    expect(res.status).toBe(403)
    expect(await err(res)).toEqual({ code: 'FORBIDDEN', message: 'Missing permissions: kb:write' })
    expect(importKBArticles).not.toHaveBeenCalled()
  })

  it('non-multipart body → 400', async () => {
    const res = await fetch(`${base}/incidents`, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: CSV })
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/Expected multipart\/form-data with a "file" field/)
    expect(importIncidents).not.toHaveBeenCalled()
  })

  it('multipart without a `file` field → 400', async () => {
    const res = await upload({ noFile: true })
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/No file uploaded/)
    expect(importIncidents).not.toHaveBeenCalled()
  })

  it('file under another field name is ignored → 400 "No file uploaded"', async () => {
    const res = await upload({ field: 'csv' })
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/No file uploaded/)
  })

  it('header-only CSV (no data rows) → 400 with the Italian message', async () => {
    const res = await upload({ csv: 'external_id,title,severity\n' })
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/non contiene righe dati/)
    expect(importIncidents).not.toHaveBeenCalled()
  })

  it('malformed CSV (unterminated quote swallowing everything) → 400, importer untouched', async () => {
    const res = await upload({ csv: '"external_id,title\nINC-1,x\nINC-2,y' })
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/non contiene righe dati/)
    expect(importIncidents).not.toHaveBeenCalled()
  })

  it('file over 20 MB → 400 "exceeds maximum size", importer untouched', async () => {
    const big = new Uint8Array(20 * 1024 * 1024 + 1).fill(0x61)
    const res = await upload({ csv: big })
    expect(res.status).toBe(400)
    expect((await err(res)).message).toMatch(/exceeds maximum size of 20MB/)
    expect(importIncidents).not.toHaveBeenCalled()
  })
})

describe('POST /api/v1/import/* — delegation', () => {
  it('dryRun=true → importer receives parsed rows, key ctx and {dryRun: true}', async () => {
    const res = await upload({ query: '?dryRun=true' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(OK_RESULT)
    expect(importIncidents).toHaveBeenCalledWith(
      [
        { external_id: 'INC-1', title: 'Disk full', severity: 'high' },
        { external_id: 'INC-2', title: 'Slow, very slow', severity: 'low' },
      ],
      { tenantId: 'tenant-1', userId: 'key-1' },
      { dryRun: true },
    )
  })

  it.each(['', '?dryRun=false', '?dryRun=1', '?dryRun=yes'])('query %j → {dryRun: false}', async (query) => {
    const res = await upload({ query })
    expect(res.status).toBe(200)
    expect(vi.mocked(importIncidents).mock.calls[0]![2]).toEqual({ dryRun: false })
  })

  it('BOM + CRLF CSV is parsed the same way', async () => {
    const res = await upload({ csv: '\uFEFFexternal_id,title\r\nKB-1,Article\r\n', path: '/kb-articles' })
    expect(res.status).toBe(200)
    expect(importKBArticles).toHaveBeenCalledWith([{ external_id: 'KB-1', title: 'Article' }], { tenantId: 'tenant-1', userId: 'key-1' }, { dryRun: false })
    expect(importIncidents).not.toHaveBeenCalled()
  })

  it('importer ValidationError → 400 with the message', async () => {
    vi.mocked(importIncidents).mockRejectedValueOnce(new ValidationError('Colonna obbligatoria mancante: title'))
    const res = await upload()
    expect(res.status).toBe(400)
    expect(await err(res)).toEqual({ code: 'VALIDATION_ERROR', message: 'Colonna obbligatoria mancante: title' })
  })

  it('unexpected importer error → 500 generic', async () => {
    vi.mocked(importIncidents).mockRejectedValueOnce(new Error('bolt refused'))
    const res = await upload()
    expect(res.status).toBe(500)
    expect(await err(res)).toEqual({ code: 'INTERNAL_ERROR', message: 'Internal server error' })
  })
})
