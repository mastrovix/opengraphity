/**
 * The organization logo upload — the edges brandLogo.test.ts leaves open.
 *
 * Why these matter:
 *  - A broken multipart body (a proxy that cuts the upload, a client that
 *    lies about the boundary) must answer 400 ONCE and never reach the
 *    storage: answering twice crashes the request with "headers already
 *    sent", and storing half a file would put a corrupt logo in every e-mail.
 *  - A request with no Content-Type at all must be refused as "not
 *    multipart", not blow up on `undefined.includes`.
 *  - A ValidationError from the storage without an i18n key must still reach
 *    the admin as a 400 with its message (key null), not as a 500.
 *  - The audit entry must be written even when the stored brand reports no
 *    logo metadata: the change still happened.
 *
 * Real Express and real multipart bodies, as in brandLogo.test.ts: busboy is
 * the part that can break, so it is not faked.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { perms } from '../../lib/__tests__/testPermissions.js'

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { tenantId: 'tenant-1', userId: 'user-1', email: 'u@example.com', role: 'admin', permissions: perms('admin') }
    next()
  },
}))

const setTenantLogo = vi.fn()
vi.mock('../../lib/brand.js', () => ({
  setTenantLogo: (...a: unknown[]) => setTenantLogo(...a),
  removeTenantLogo: vi.fn(),
  tenantLogoFile: vi.fn(),
}))

const audit = vi.fn()
vi.mock('../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))

const { brandRouter } = await import('../brand.js')
const { ValidationError } = await import('../../lib/errors.js')

let server: Server
let port: number

beforeAll(async () => {
  const app = express()
  app.use('/api', brandRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  port = (server.address() as AddressInfo).port
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
beforeEach(() => {
  vi.clearAllMocks()
  setTenantLogo.mockResolvedValue({ logo: { mimeType: 'image/png' }, isDefault: false })
})

/** A raw POST, so the test controls the exact bytes and headers (fetch would fix them up). */
function rawPost(headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/brand/logo', method: 'POST', headers }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

function multipart(field: string, content: string, boundary = 'XBOUNDARY'): string {
  return `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="${field}"; filename="logo.png"\r\n`
    + 'Content-Type: image/png\r\n\r\n'
    + `${content}\r\n--${boundary}--\r\n`
}

describe('POST /brand/logo — malformed and header-less bodies', () => {
  it('no Content-Type header at all: 400 "expected multipart", nothing stored', async () => {
    const res = await rawPost({ 'content-length': '2' }, '{}')
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: expect.stringContaining('multipart/form-data') })
    expect(setTenantLogo).not.toHaveBeenCalled()
  })

  it('a truncated multipart body: one 400 "Malformed", and the half file is never stored', async () => {
    // The closing boundary never arrives: busboy reports "Unexpected end of form"
    // on itself AND destroys the open file stream with it. Before the fix the
    // file stream had no 'error' listener, so this test died with an uncaught
    // exception (vitest fails the run on it): in production, the API process.
    const cut = multipart('file', 'half-a-png').split('\r\n--XBOUNDARY--')[0]!
    const res = await rawPost({ 'content-type': 'multipart/form-data; boundary=XBOUNDARY' }, cut)
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'Malformed multipart body' })
    expect(setTenantLogo).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
  })
})

describe('POST /brand/logo — what the storage answers', () => {
  it('a ValidationError without an i18n key is still a 400 with its message (key null)', async () => {
    setTenantLogo.mockRejectedValue(new ValidationError('The SVG contains a script.'))
    const res = await rawPost({ 'content-type': 'multipart/form-data; boundary=XBOUNDARY' }, multipart('file', '<svg/>'))
    expect(res.status).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'VALIDATION_ERROR', key: null, message: 'The SVG contains a script.' } })
    expect(audit).not.toHaveBeenCalled()
  })

  it('stored without logo metadata: 201, and the audit entry records mimeType null rather than being skipped', async () => {
    setTenantLogo.mockResolvedValue({ logo: null, isDefault: false })
    const res = await rawPost({ 'content-type': 'multipart/form-data; boundary=XBOUNDARY' }, multipart('file', 'png-bytes'))
    expect(res.status).toBe(201)
    expect(setTenantLogo).toHaveBeenCalledWith('tenant-1', Buffer.from('png-bytes'))
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', userId: 'user-1' }),
      'tenant.brand.logo_updated', 'Tenant', 'tenant-1', { mimeType: null },
    )
  })
})
