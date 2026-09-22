/**
 * The audit-dossier PDF routes (`GET /api/<entity>/:id/pdf`), on a real Express.
 *
 * Why these behaviours matter: the dossier is what an auditor downloads to
 * prove what happened on an incident, change or problem. So:
 *  - the loader must be called with the tenant of the SESSION, never one taken
 *    from the request, or a user could export another tenant's ticket;
 *  - a ticket that does not exist (or belongs to someone else) is a 404, not
 *    a 500 that leaks a stack or looks like an outage;
 *  - the dossier's dates are written in the tenant's time zone: a tenant with
 *    none configured must fail loudly, not print dates in the server's zone;
 *  - the organisation logo appears only when it is a PNG (the PDF library
 *    cannot embed an SVG) and is read from disk;
 *  - every export leaves an audit entry;
 *  - the Neo4j session is always closed, whatever happens.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { perms } from '../../lib/__tests__/testPermissions.js'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'og-pdfrouter-test-'))
const LOGO = path.join(DIR, 'logo.png')
fs.writeFileSync(LOGO, Buffer.from('PNGDATA'))

const close = vi.fn().mockResolvedValue(undefined)
const getSession = vi.fn(() => ({ close }))
vi.mock('@opengraphity/neo4j', () => ({ getSession: (...a: unknown[]) => getSession(...(a as [])) }))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { tenantId: 'tenant-1', userId: 'user-1', email: 'u@example.com', role: 'admin', permissions: perms('admin') }
    next()
  },
}))
vi.mock('../../lib/logger.js', () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }))
const audit = vi.fn()
vi.mock('../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))
const tenantBrand = vi.fn()
const tenantLogoFile = vi.fn()
vi.mock('../../lib/brand.js', () => ({
  tenantBrand: (...a: unknown[]) => tenantBrand(...a),
  tenantLogoFile: (...a: unknown[]) => tenantLogoFile(...a),
}))
const languageFor = vi.fn()
vi.mock('../../lib/tenantLanguage.js', () => ({ languageFor: (...a: unknown[]) => languageFor(...a) }))
const tenantTimezone = vi.fn()
vi.mock('../../lib/tenantTimezone.js', () => ({ tenantTimezone: (...a: unknown[]) => tenantTimezone(...a) }))

const { makePdfRouter } = await import('../pdfRouter.js')
const { NotFoundError } = await import('../../lib/errors.js')
const { logger } = await import('../../lib/logger.js')

interface Dossier { number: string | null; id: string }
const loader = vi.fn<(s: unknown, id: string, tenantId: string) => Promise<Dossier>>()
const builder = vi.fn<(d: Dossier, meta: Record<string, unknown>) => Promise<Buffer>>()

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use('/api', makePdfRouter<Dossier>({
    path: '/incidents/:id/pdf',
    entity: 'Incident',
    loader: (s, id, t) => loader(s, id, t),
    builder: (d, m) => builder(d, m as unknown as Record<string, unknown>),
    filename: (d) => d.number ?? d.id,
  }))
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(DIR, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  loader.mockResolvedValue({ number: 'INC 0001', id: 'inc-1' })
  builder.mockResolvedValue(Buffer.from('%PDF-1.7 fake'))
  languageFor.mockResolvedValue('it')
  tenantTimezone.mockResolvedValue('Europe/Rome')
  tenantBrand.mockResolvedValue({ displayName: 'Acme', logo: null })
  tenantLogoFile.mockResolvedValue(null)
})

describe('makePdfRouter', () => {
  it('serves the PDF as a download named after the ticket number, loaded for the session tenant', async () => {
    const res = await fetch(`${base}/incidents/inc-1/pdf`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    // The number is URL-encoded: a space or quote in it must not break the header.
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="INC%200001.pdf"')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('%PDF-1.7 fake')

    expect(getSession).toHaveBeenCalledWith(undefined, 'READ')
    expect(loader.mock.calls[0]!.slice(1)).toEqual(['inc-1', 'tenant-1'])
    expect(close).toHaveBeenCalledOnce()
  })

  it('writes the dossier in the tenant language and time zone, signed by the exporting user', async () => {
    await fetch(`${base}/incidents/inc-1/pdf`)
    const meta = builder.mock.calls[0]![1]
    expect(meta).toMatchObject({
      generatedBy: 'u@example.com',
      tenantId: 'tenant-1',
      locale: { language: 'it', timeZone: 'Europe/Rome' },
      brand: { displayName: 'Acme', logoPng: null },
    })
    expect(Number.isNaN(Date.parse(meta['generatedAt'] as string))).toBe(false)
  })

  it('leaves an audit entry for the export, attributed to the user', async () => {
    await fetch(`${base}/incidents/inc-1/pdf`)
    await vi.waitFor(() => expect(audit).toHaveBeenCalled())
    const [ctx, action, entity, id] = audit.mock.calls[0] as [Record<string, unknown>, string, string, string]
    expect(ctx).toMatchObject({ tenantId: 'tenant-1', userId: 'user-1', userEmail: 'u@example.com', role: 'admin' })
    expect([action, entity, id]).toEqual(['incident.pdf_exported', 'Incident', 'inc-1'])
  })

  it('falls back to the id for the filename when the ticket has no number', async () => {
    loader.mockResolvedValueOnce({ number: null, id: 'inc-9' })
    const res = await fetch(`${base}/incidents/inc-9/pdf`)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="inc-9.pdf"')
  })

  it('embeds the organisation logo when it is a PNG, read from its file', async () => {
    tenantBrand.mockResolvedValueOnce({ displayName: 'Acme', logo: { mimeType: 'image/png' } })
    tenantLogoFile.mockResolvedValueOnce({ path: LOGO })
    await fetch(`${base}/incidents/inc-1/pdf`)
    const brand = builder.mock.calls[0]![1]['brand'] as { logoPng: Buffer | null }
    expect(brand.logoPng?.toString()).toBe('PNGDATA')
    expect(tenantLogoFile).toHaveBeenCalledWith('tenant-1')
  })

  it('a PNG logo whose file is gone is left out rather than failing the export', async () => {
    tenantBrand.mockResolvedValueOnce({ displayName: 'Acme', logo: { mimeType: 'image/png' } })
    tenantLogoFile.mockResolvedValueOnce(null)
    const res = await fetch(`${base}/incidents/inc-1/pdf`)
    expect(res.status).toBe(200)
    expect((builder.mock.calls[0]![1]['brand'] as { logoPng: unknown }).logoPng).toBeNull()
  })

  it('an SVG logo is not embedded (the PDF cannot draw it) and its file is not read', async () => {
    tenantBrand.mockResolvedValueOnce({ displayName: 'Acme', logo: { mimeType: 'image/svg+xml' } })
    await fetch(`${base}/incidents/inc-1/pdf`)
    expect((builder.mock.calls[0]![1]['brand'] as { logoPng: unknown }).logoPng).toBeNull()
    expect(tenantLogoFile).not.toHaveBeenCalled()
  })

  it('a ticket that does not exist in the tenant is a 404 naming the entity', async () => {
    loader.mockRejectedValueOnce(new NotFoundError('Incident'))
    const res = await fetch(`${base}/incidents/other-tenant/pdf`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Incident not found' })
    expect(builder).not.toHaveBeenCalled()
    expect(audit).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('a tenant without a time zone fails the export instead of printing dates in the server zone', async () => {
    tenantTimezone.mockResolvedValueOnce(null)
    const res = await fetch(`${base}/incidents/inc-1/pdf`)
    expect(res.status).toBe(500)
    // The client gets a generic message; the reason goes to the log.
    expect(await res.json()).toEqual({ error: 'Failed to generate PDF' })
    const [logged] = vi.mocked(logger.error).mock.calls[0] as [{ err: Error; id: string; tenantId: string }]
    expect(logged.err.message).toMatch(/Tenant tenant-1 has no time zone configured/)
    expect(logged).toMatchObject({ id: 'inc-1', tenantId: 'tenant-1' })
    expect(builder).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })

  it('a builder failure is a 500 without details, and no audit entry claims an export', async () => {
    builder.mockRejectedValueOnce(new Error('pdfkit exploded at /srv/app/x.js'))
    const res = await fetch(`${base}/incidents/inc-1/pdf`)
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('/srv/app')
    expect(audit).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
  })
})
