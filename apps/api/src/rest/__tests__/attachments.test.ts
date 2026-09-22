/**
 * /api/attachments — the paths attachmentsUpload.test.ts does not walk:
 * the download route, the portal user's rights, form-draft uploads and the
 * failure branches of the multipart handler.
 *
 * Why these behaviours matter:
 *  - GET must answer "not found" for an attachment the caller may not see,
 *    exactly as for one that does not exist: otherwise a portal user could
 *    probe ids and learn which files other customers attached;
 *  - a portal user uploads only to the ticket types they own, never to a
 *    change; a form draft needs no ticket yet, but must name its form field;
 *  - one request carries ONE file: a second file must not slip through, and a
 *    file already written for the rejected request must not stay on disk;
 *  - every failure (unreadable policy, broken stream, malformed body, missing
 *    user) must end in exactly one error reply, never a hung request or a
 *    crashed process;
 *  - a tenant id that would escape the storage folder never becomes a path.
 * Express, busboy and the filesystem are real (scratch dir); Neo4j and auth are mocked.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { perms } from '../../lib/__tests__/testPermissions.js'

const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'og-attachments-more-'))

vi.mock('../../lib/config.js', () => ({ config: { attachmentDir: UPLOAD_DIR } }))
vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (req.headers['x-test-nouser'] === '1') { next(); return }
    const role = typeof req.headers['x-test-role'] === 'string' ? req.headers['x-test-role'] : 'operator'
    const tenantId = typeof req.headers['x-test-tenant'] === 'string' ? req.headers['x-test-tenant'] : 'tenant-1'
    req.user = { tenantId, userId: 'user-1', email: 'u@example.com', role, permissions: perms(role) }
    next()
  },
}))
const policyMock = vi.hoisted(() => ({ fail: false }))
vi.mock('../../lib/attachmentPolicy.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/attachmentPolicy.js')>()
  return {
    ...real,
    attachmentPolicy: vi.fn(async () => {
      if (policyMock.fail) throw new Error('policy JSON corrupted')
      return { ...real.FACTORY_ATTACHMENT_POLICY, extensions: [...real.FACTORY_ATTACHMENT_POLICY.extensions], isDefault: true }
    }),
  }
})
vi.mock('@opengraphity/neo4j', () => ({
  getSession:  vi.fn(),
  runQuery:    vi.fn(),
  runQueryOne: vi.fn(),
}))

const { getSession, runQueryOne } = await import('@opengraphity/neo4j')
const { attachmentRouter } = await import('../attachments.js')

const UUID = '6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b'

interface Write { q: string; p: Record<string, unknown> }
const writes: Write[] = []
const reads: Array<Record<string, unknown>> = []
/** Rows the GET lookup returns (keyed like the Cypher RETURN). */
let attachmentRows: Array<Record<string, unknown>> = []

function fakeSession() {
  return {
    executeRead: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({ run: (_q: string, p: Record<string, unknown>) => {
        reads.push(p)
        return Promise.resolve({ records: attachmentRows.map((row) => ({ get: (k: string) => row[k] })) })
      } })),
    executeWrite: vi.fn().mockImplementation((fn: (tx: unknown) => unknown) =>
      fn({ run: (q: string, p: Record<string, unknown>) => { writes.push({ q, p }); return Promise.resolve({ records: [] }) } })),
    close: vi.fn().mockResolvedValue(undefined),
  }
}

let server: Server
let base: string
const jsonReplies: number[] = []

beforeAll(async () => {
  const app = express()
  // Count JSON replies per request: a second one would be a double send.
  app.use((_req, res, next) => {
    const orig = res.json.bind(res)
    let n = 0
    res.json = ((body: unknown) => { n++; jsonReplies.push(n); return orig(body) }) as typeof res.json
    next()
  })
  app.use('/api', attachmentRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/attachments`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true })
})
beforeEach(() => {
  vi.clearAllMocks()
  policyMock.fail = false
  writes.length = 0
  reads.length = 0
  jsonReplies.length = 0
  attachmentRows = []
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true })
  fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  vi.mocked(getSession).mockImplementation(() => fakeSession() as never)
  vi.mocked(runQueryOne).mockResolvedValue({ id: UUID })
})

const filesUnder = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? filesUnder(p) : [p]
  })
}
const errorOf = async (res: Response) => (await res.json() as { error: string }).error

function post(fd: FormData, headers: Record<string, string> = {}) {
  return fetch(base, { method: 'POST', body: fd, headers })
}
function form(fields: Record<string, string>, files: Array<{ name: string; content?: string; field?: string }> = [{ name: 'note.txt' }]) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  for (const f of files) fd.append(f.field ?? 'file', new Blob([f.content ?? 'hello'], { type: 'text/plain' }), f.name)
  return fd
}

// ══════════════════════════════════════════════════════════════════════════════
describe('POST — who may attach to what', () => {
  it('a portal user may not attach to a change: 403, no existence query, nothing on disk', async () => {
    const res = await post(form({ entityType: 'change', entityId: UUID }), { 'x-test-role': 'end_user' })
    expect(res.status).toBe(403)
    expect(await errorOf(res)).toMatch(/cannot attach files to a change/)
    expect(runQueryOne).not.toHaveBeenCalled()
    expect(filesUnder(UPLOAD_DIR)).toEqual([])
  })

  it('a portal user attaches to an incident only if they created it (ownership in the query)', async () => {
    const res = await post(form({ entityType: 'incident', entityId: UUID }), { 'x-test-role': 'end_user' })
    expect(res.status).toBe(201)
    expect(vi.mocked(runQueryOne).mock.calls[0]![1]).toContain('e.created_by = $userId')
  })

  it('a form draft skips the existence check and records the form field it answers', async () => {
    const res = await post(form({ entityType: 'form_draft', entityId: UUID, fieldName: 'screenshot', description: 'the error' }))
    expect(res.status).toBe(201)
    expect(runQueryOne).not.toHaveBeenCalled()
    expect(writes[0]!.p).toMatchObject({ entityType: 'form_draft', fieldName: 'screenshot', description: 'the error' })
  })

  it('a form draft without a field name is refused', async () => {
    const res = await post(form({ entityType: 'form_draft', entityId: UUID }))
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatch(/fieldName is required/)
    expect(filesUnder(UPLOAD_DIR)).toEqual([])
  })

  it('a tenant id that would escape the storage folder never becomes a path', async () => {
    const res = await post(form({ entityType: 'incident', entityId: UUID }), { 'x-test-tenant': '../../outside' })
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatch(/escapes the storage directory/)
    expect(fs.existsSync(path.resolve(UPLOAD_DIR, '..', '..', 'outside'))).toBe(false)
  })
})

describe('POST — one file, one reply', () => {
  it('a second file → 400, and the first file already written is removed', async () => {
    const res = await post(form({ entityType: 'incident', entityId: UUID }, [{ name: 'a.txt' }, { name: 'b.txt' }]))
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatch(/Only one file per request/)
    // The 400 goes out as soon as busboy sees the second file; the first one is
    // removed when the multipart stream finishes, a moment later.
    await vi.waitFor(() => expect(filesUnder(UPLOAD_DIR)).toEqual([]))
    expect(writes).toHaveLength(0)
  })

  it('a refused first file and then a second one: still exactly one reply', async () => {
    const res = await post(form({ entityType: 'incident', entityId: UUID }, [{ name: 'evil.exe' }, { name: 'b.txt' }]))
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toMatch(/'\.exe' is not allowed/)
    expect(jsonReplies).toEqual([1])
  })

  it('a part named other than `file` is ignored → "No file uploaded"', async () => {
    const res = await post(form({ entityType: 'incident', entityId: UUID }, [{ name: 'a.txt', field: 'other' }]))
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('No file uploaded')
  })

  it('fields only, no file → "No file uploaded", no Attachment node', async () => {
    const res = await post(form({ entityType: 'incident', entityId: UUID }, []))
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('No file uploaded')
    expect(writes).toHaveLength(0)
  })
})

describe('POST — failures end in one clear reply', () => {
  it('an unreadable attachment policy → 500 before the body is parsed', async () => {
    policyMock.fail = true
    const res = await post(form({ entityType: 'incident', entityId: UUID }))
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toMatch(/attachment policy of this organization cannot be read/)
    expect(filesUnder(UPLOAD_DIR)).toEqual([])
  })

  it('the existence check failing → 500 "Failed to store attachment", nothing left on disk', async () => {
    vi.mocked(runQueryOne).mockRejectedValueOnce(new Error('bolt down'))
    const res = await post(form({ entityType: 'incident', entityId: UUID }))
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe('Failed to store attachment')
    expect(filesUnder(UPLOAD_DIR)).toEqual([])
    expect(writes).toHaveLength(0)
  })

  it('a truncated multipart body → 400 "Malformed multipart body"', async () => {
    const body = '--XYZ\r\nContent-Disposition: form-data; name="entityType"\r\n\r\nincident'
    const res = await fetch(base, { method: 'POST', body, headers: { 'content-type': 'multipart/form-data; boundary=XYZ' } })
    expect(res.status).toBe(400)
    expect(await errorOf(res)).toBe('Malformed multipart body')
  })

  it('a request without a user (auth wiring broken) → 500, not a hung request', async () => {
    const res = await post(form({ entityType: 'incident', entityId: UUID }), { 'x-test-nouser': '1' })
    expect(res.status).toBe(500)
    expect(await errorOf(res)).toBe('upload failed')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
describe('GET /api/attachments/:id', () => {
  const storedFile = () => {
    const dir = path.join(UPLOAD_DIR, 'tenant-1', UUID)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'x_report final.txt')
    fs.writeFileSync(file, 'file body')
    return file
  }
  const row = (over: Record<string, unknown> = {}) => ({
    storagePath: storedFile(), filename: 'report final.txt', mimeType: 'text/plain', entityType: 'incident', entityId: UUID, ...over,
  })

  it('looks the attachment up in the caller tenant only; unknown id → 404', async () => {
    const res = await fetch(`${base}/att-1`)
    expect(res.status).toBe(404)
    expect(reads[0]).toEqual({ id: 'att-1', tenantId: 'tenant-1' })
  })

  it('streams the file with its type and an attachment disposition', async () => {
    attachmentRows = [row()]
    const res = await fetch(`${base}/att-1`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    // Always a download, never rendered inline: an uploaded HTML must not run on our origin.
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="report%20final.txt"')
    expect(await res.text()).toBe('file body')
    expect(vi.mocked(runQueryOne).mock.calls[0]![2]).toEqual({ entityId: UUID, tenantId: 'tenant-1', userId: 'user-1' })
  })

  it('an attachment of an entity the caller cannot reach answers exactly like a missing one', async () => {
    attachmentRows = [row()]
    vi.mocked(runQueryOne).mockResolvedValueOnce(null)
    const res = await fetch(`${base}/att-1`)
    expect(res.status).toBe(404)
    expect(await errorOf(res)).toBe('Attachment not found')
  })

  it('a portal user reading a change attachment: 404 without even querying the change', async () => {
    attachmentRows = [row({ entityType: 'change' })]
    const res = await fetch(`${base}/att-1`, { headers: { 'x-test-role': 'end_user' } })
    expect(res.status).toBe(404)
    expect(await errorOf(res)).toBe('Attachment not found')
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('a stored entity type outside the whitelist (e.g. a form draft never claimed) → 404', async () => {
    attachmentRows = [row({ entityType: 'form_draft' })]
    const res = await fetch(`${base}/att-1`)
    expect(res.status).toBe(404)
    expect(runQueryOne).not.toHaveBeenCalled()
  })

  it('a record whose file is gone from disk → 404 "File not found on disk"', async () => {
    attachmentRows = [row({ storagePath: path.join(UPLOAD_DIR, 'missing.txt') })]
    const res = await fetch(`${base}/att-1`)
    expect(res.status).toBe(404)
    expect(await errorOf(res)).toBe('File not found on disk')
  })
})
