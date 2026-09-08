/**
 * POST /api/attachments over a real Express app with real multipart bodies
 * (Node FormData/Blob → busboy): target whitelist/UUID validation, tenant
 * scoping of the existence check, upload-role gate, MIME whitelist, 10 MB
 * limit, single-response guard and the on-disk path staying inside
 * ATTACHMENT_DIR. Neo4j and auth are mocked; the filesystem is real (scratch dir).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'og-attachments-test-'))
process.env['ATTACHMENT_DIR'] = UPLOAD_DIR

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const role = typeof req.headers['x-test-role'] === 'string' ? req.headers['x-test-role'] : 'operator'
    req.user = { tenantId: 'tenant-1', userId: 'user-1', email: 'u@example.com', role }
    next()
  },
}))
vi.mock('@opengraphity/neo4j', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
}))

const { getSession, runQueryOne } = await import('@opengraphity/neo4j')
const { logger } = await import('../../lib/logger.js')
const { attachmentRouter } = await import('../attachments.js')

const UUID = '6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b'

interface Write { q: string; p: Record<string, unknown> }
const writes: Write[] = []
const jsonCalls: number[] = []

function fakeSession() {
  return {
    executeRead:  vi.fn(),
    executeWrite: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({ run: (q: string, p: Record<string, unknown>) => { writes.push({ q, p }); return Promise.resolve({ records: [] }) } })),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  // Count every JSON reply per request: a second call would be a double send.
  app.use((_req, res, next) => {
    const orig = res.json.bind(res)
    let n = 0
    res.json = ((body: unknown) => { n++; jsonCalls.push(n); return orig(body) }) as typeof res.json
    next()
  })
  app.use('/api', attachmentRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/attachments`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true })
})
beforeEach(() => {
  vi.clearAllMocks()
  writes.length = 0
  jsonCalls.length = 0
  vi.mocked(getSession).mockImplementation(() => fakeSession() as never)
  vi.mocked(runQueryOne).mockResolvedValue({ id: UUID })
})

interface UploadOpts {
  entityType?: string
  entityId?:   string
  description?: string
  content?:    string | Uint8Array
  mime?:       string
  filename?:   string
  role?:       string
  fieldsFirst?: boolean
}

function upload(opts: UploadOpts = {}) {
  const fd = new FormData()
  const file = new Blob([opts.content ?? 'hello attachment'], { type: opts.mime ?? 'text/plain' })
  const addFields = () => {
    fd.append('entityType', opts.entityType ?? 'incident')
    fd.append('entityId', opts.entityId ?? UUID)
    if (opts.description) fd.append('description', opts.description)
  }
  if (opts.fieldsFirst !== false) addFields()
  fd.append('file', file, opts.filename ?? 'note.txt')
  if (opts.fieldsFirst === false) addFields()
  const headers: Record<string, string> = {}
  if (opts.role) headers['x-test-role'] = opts.role
  return fetch(base, { method: 'POST', body: fd, headers })
}

const filesUnder = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(p))
    else out.push(p)
  }
  return out
}

const errorBody = async (res: Response) => (await res.json() as { error: string }).error

describe('POST /api/attachments — request validation', () => {
  it('non-multipart body → 400 before touching busboy or Neo4j', async () => {
    const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(400)
    expect(await errorBody(res)).toMatch(/multipart/)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('entityType outside the whitelist → 400, no existence check, no file on disk', async () => {
    const res = await upload({ entityType: 'user' })
    expect(res.status).toBe(400)
    expect(await errorBody(res)).toMatch(/entityType 'user' is not allowed/)
    expect(runQueryOne).not.toHaveBeenCalled()
    expect(filesUnder(UPLOAD_DIR)).toEqual([])
  })

  it('entityId that is not a UUID → 400', async () => {
    const res = await upload({ entityId: 'inc-1' })
    expect(res.status).toBe(400)
    expect(await errorBody(res)).toMatch(/entityId must be a UUID/)
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('path traversal in entityId (../../etc) → 400 and nothing written outside the upload dir', async () => {
    const res = await upload({ entityId: '../../etc' })
    expect(res.status).toBe(400)
    expect(filesUnder(UPLOAD_DIR)).toEqual([])
    expect(fs.existsSync(path.resolve(UPLOAD_DIR, '..', 'etc'))).toBe(false)
    expect(fs.existsSync(path.resolve(UPLOAD_DIR, 'tenant-1', '..', '..', 'etc'))).toBe(false)
    expect(writes).toHaveLength(0)
  })

  it('fields sent AFTER the file part → 400 (target must precede the stream)', async () => {
    const res = await upload({ fieldsFirst: false })
    expect(res.status).toBe(400)
    expect(await errorBody(res)).toMatch(/entityType is required/)
    expect(filesUnder(UPLOAD_DIR)).toEqual([])
  })
})

describe('POST /api/attachments — authorization and target', () => {
  it('viewer role → 403 without reading the body', async () => {
    const res = await upload({ role: 'viewer' })
    expect(res.status).toBe(403)
    expect(await errorBody(res)).toMatch(/Role 'viewer' cannot upload/)
    expect(runQueryOne).not.toHaveBeenCalled()
    expect(getSession).not.toHaveBeenCalled()
    expect(filesUnder(UPLOAD_DIR)).toEqual([])
  })

  it('entity not found in the tenant → 404; existence query is tenant-scoped; no dir created', async () => {
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    const res = await upload()
    expect(res.status).toBe(404)
    expect(await errorBody(res)).toMatch(new RegExp(`incident ${UUID} not found`))
    expect(vi.mocked(runQueryOne).mock.calls[0]![1]).toMatch(/e:Incident/)
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ entityId: UUID, tenantId: 'tenant-1' })
    expect(fs.existsSync(path.join(UPLOAD_DIR, 'tenant-1', UUID))).toBe(false)
    expect(writes).toHaveLength(0)
  })
})

describe('POST /api/attachments — file constraints', () => {
  it('disallowed MIME type → exactly one 400 reply, no ERR_HTTP_HEADERS_SENT', async () => {
    const res = await upload({ mime: 'application/x-msdownload', filename: 'evil.exe' })
    expect(res.status).toBe(400)
    expect(await errorBody(res)).toMatch(/File type 'application\/x-msdownload' is not allowed/)
    expect(jsonCalls).toEqual([1])
    const logged = JSON.stringify(vi.mocked(logger.error).mock.calls)
    expect(logged).not.toMatch(/ERR_HTTP_HEADERS_SENT|headers already sent/i)
    expect(runQueryOne).not.toHaveBeenCalled()
    expect(filesUnder(UPLOAD_DIR)).toEqual([])
  })

  it('file over 10 MB → 400 "exceeds maximum size", partial file removed, no Attachment node', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1)
    const res = await upload({ content: big, mime: 'application/zip', filename: 'big.zip' })
    expect(res.status).toBe(400)
    expect(await errorBody(res)).toMatch(/exceeds maximum size of 10MB/)
    expect(writes).toHaveLength(0)
    expect(filesUnder(UPLOAD_DIR)).toEqual([])
    expect(jsonCalls).toEqual([1])
  })
})

describe('POST /api/attachments — success', () => {
  it('stores the file under <dir>/<tenant>/<entity>/ and CREATEs an Attachment with tenant_id', async () => {
    const res = await upload({ content: 'contenuto allegato', description: 'screenshot', filename: 'nota finale.txt' })
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; filename: string; sizeBytes: number; downloadUrl: string }
    expect(body.filename).toBe('nota finale.txt')
    expect(body.sizeBytes).toBe(Buffer.byteLength('contenuto allegato'))
    expect(body.downloadUrl).toBe(`/api/attachments/${body.id}`)

    expect(writes).toHaveLength(1)
    expect(writes[0]!.q).toMatch(/CREATE \(a:Attachment/)
    expect(writes[0]!.q).toMatch(/tenant_id:\s+\$tenantId/)
    expect(writes[0]!.p).toMatchObject({
      id:          body.id,
      tenantId:    'tenant-1',
      entityType:  'incident',
      entityId:    UUID,
      filename:    'nota finale.txt',
      mimeType:    'text/plain',
      sizeBytes:   body.sizeBytes,
      uploadedBy:  'user-1',
      description: 'screenshot',
    })

    const storagePath = writes[0]!.p['storagePath'] as string
    const expectedDir = path.join(path.resolve(UPLOAD_DIR), 'tenant-1', UUID)
    expect(path.dirname(storagePath)).toBe(expectedDir)
    expect(path.basename(storagePath)).toBe(`${body.id}_nota finale.txt`)
    expect(fs.readFileSync(storagePath, 'utf-8')).toBe('contenuto allegato')
    expect(filesUnder(UPLOAD_DIR)).toEqual([storagePath])
    fs.rmSync(storagePath)
  })

  it('Neo4j write failure → 500 and the stored file is removed', async () => {
    vi.mocked(getSession).mockImplementation(() => ({
      executeRead:  vi.fn(),
      executeWrite: vi.fn().mockRejectedValue(new Error('bolt down')),
      close:        vi.fn().mockResolvedValue(undefined),
    }) as never)
    const res = await upload({ content: 'x' })
    expect(res.status).toBe(500)
    expect(await errorBody(res)).toMatch(/Failed to save attachment metadata/)
    expect(filesUnder(UPLOAD_DIR)).toEqual([])
    expect(jsonCalls).toEqual([1])
  })
})
