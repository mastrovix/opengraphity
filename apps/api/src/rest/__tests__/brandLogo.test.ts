/**
 * IL LOGO DELL'ORGANIZZAZIONE, su un Express vero (22 set 2026).
 *
 * ## Perché non c'erano test
 * `rest/brand.ts` stava a ZERO. Sono tre rotte, e una è **pubblica di
 * proposito**: la leggono i client di posta, che una sessione non ce l'hanno.
 * Una rotta senza sessione e senza test è il posto dove si guarda per primo, e
 * qui la difesa è tutta negli header — una CSP che non esegue niente, perché un
 * SVG aperto da solo potrebbe lanciare script.
 *
 * Le altre due chiedono il permesso «Organizzazione», e il caricamento passa da
 * un corpo multipart vero.
 *
 * ## Express vero, disco vero
 * Come `attachmentsUpload.test.ts`: l'app si alza davvero e i corpi multipart
 * sono quelli di Node. Fingere busboy vorrebbe dire non provare la parte che
 * puo' rompersi — il limite di dimensione arriva come evento `limit` sullo
 * stream, non come un `if`.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { perms } from '../../lib/__tests__/testPermissions.js'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'og-brand-test-'))

vi.mock('../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const role = typeof req.headers['x-test-role'] === 'string' ? req.headers['x-test-role'] : 'admin'
    const extra = req.headers['x-test-noperm'] === '1' ? new Set<string>() : perms(role)
    req.user = { tenantId: 'tenant-1', userId: 'user-1', email: 'u@example.com', role, permissions: extra }
    next()
  },
}))

const setTenantLogo = vi.fn()
const removeTenantLogo = vi.fn()
const tenantLogoFile = vi.fn()
vi.mock('../../lib/brand.js', () => ({
  setTenantLogo: (...a: unknown[]) => setTenantLogo(...a),
  removeTenantLogo: (...a: unknown[]) => removeTenantLogo(...a),
  tenantLogoFile: (...a: unknown[]) => tenantLogoFile(...a),
}))

const audit = vi.fn()
vi.mock('../../lib/audit.js', () => ({ audit: (...a: unknown[]) => audit(...a) }))

const { brandRouter } = await import('../brand.js')
const { ValidationError } = await import('../../lib/errors.js')
const { BRAND_LOGO_MAX_BYTES } = await import('@opengraphity/types')

let server: Server
let base: string

beforeAll(async () => {
  const app = express()
  app.use('/api', brandRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, resolve) })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(DIR, { recursive: true, force: true })
})

beforeEach(() => {
  vi.clearAllMocks()
  setTenantLogo.mockResolvedValue({ logo: { mimeType: 'image/png' }, isDefault: false })
  removeTenantLogo.mockResolvedValue({ isDefault: true })
  tenantLogoFile.mockResolvedValue(null)
})

/** Un POST multipart con un campo file, come lo manda un browser. */
async function carica(bytes: Buffer, campo = 'file', headers: Record<string, string> = {}) {
  const form = new FormData()
  form.append(campo, new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'logo.png')
  return fetch(`${base}/brand/logo`, { method: 'POST', body: form, headers })
}

// ══════════════════════════════════════════════════════════════════════════════
describe('POST /brand/logo — il permesso Organizzazione', () => {
  it('senza quel permesso: 403, e non si tocca niente', async () => {
    const res = await carica(Buffer.from('png'), 'file', { 'x-test-noperm': '1' })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('Organization permission') })
    expect(setTenantLogo).not.toHaveBeenCalled()
  })

  it('un corpo che non è multipart si rifiuta prima di leggerlo', async () => {
    const res = await fetch(`${base}/brand/logo`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('multipart/form-data') })
  })

  it('un multipart senza il campo `file` non è un caricamento a vuoto: lo dice', async () => {
    const res = await carica(Buffer.from('png'), 'altro')
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'No file uploaded' })
    expect(setTenantLogo).not.toHaveBeenCalled()
  })

  it('caricato: 201, e nel registro finisce il tipo del file', async () => {
    const res = await carica(Buffer.from('finto-png'))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })
    expect((setTenantLogo.mock.calls[0]![1] as Buffer).toString()).toBe('finto-png')
    expect(audit.mock.calls[0]![1]).toBe('tenant.brand.logo_updated')
    expect(audit.mock.calls[0]![4]).toEqual({ mimeType: 'image/png' })
  })

  it('oltre il tetto: il limite arriva dallo STREAM, e la risposta porta la chiave i18n', async () => {
    const res = await carica(Buffer.alloc(BRAND_LOGO_MAX_BYTES + 1024, 0x41))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { key: 'errors.brand.logoSize' } })
    expect(setTenantLogo).not.toHaveBeenCalled()
  })

  it('un file che non è un logo: il rifiuto della libreria esce con la sua chiave', async () => {
    setTenantLogo.mockRejectedValue(new ValidationError('Only PNG or SVG.', { key: 'errors.brand.logoType' }))
    const res = await carica(Buffer.from('non-un-png'))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR', key: 'errors.brand.logoType' } })
  })

  it('un guasto vero è 500 e NON racconta che cos\'è andato storto', async () => {
    setTenantLogo.mockRejectedValue(new Error('disco pieno su /var/lib/og'))
    const res = await carica(Buffer.from('png'))
    expect(res.status).toBe(500)
    const corpo = await res.text()
    expect(corpo).toContain('Failed to store the logo')
    expect(corpo).not.toContain('/var/lib/og')
  })
})

describe('DELETE /brand/logo', () => {
  it('serve lo stesso permesso', async () => {
    const res = await fetch(`${base}/brand/logo`, { method: 'DELETE', headers: { 'x-test-noperm': '1' } })
    expect(res.status).toBe(403)
    expect(removeTenantLogo).not.toHaveBeenCalled()
  })

  it('tolto: ok, e si registra', async () => {
    const res = await fetch(`${base}/brand/logo`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    expect(removeTenantLogo).toHaveBeenCalledWith('tenant-1')
    expect(audit.mock.calls[0]![1]).toBe('tenant.brand.logo_removed')
  })

  it('un guasto è 500 senza dettagli', async () => {
    removeTenantLogo.mockRejectedValue(new Error('permesso negato su /var/lib/og'))
    const res = await fetch(`${base}/brand/logo`, { method: 'DELETE' })
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('/var/lib/og')
  })
})

describe('GET /brand/:tenantId/logo — pubblica di proposito', () => {
  it('lo slug si valida PRIMA di toccare il disco: un percorso non è un tenant', async () => {
    for (const cattivo of ['..%2F..%2Fetc%2Fpasswd', 'a'.repeat(65), 'con spazio', 'punto.punto']) {
      const res = await fetch(`${base}/brand/${cattivo}/logo`)
      expect(res.status).toBe(404)
    }
    expect(tenantLogoFile).not.toHaveBeenCalled()
  })

  it('senza logo: 404 — e un tenant inesistente non si distingue da uno senza logo', async () => {
    expect((await fetch(`${base}/brand/tenant-1/logo`)).status).toBe(404)
    tenantLogoFile.mockRejectedValue(new Error('tenant mai esistito'))
    expect((await fetch(`${base}/brand/tenant-9/logo`)).status).toBe(404)
  })

  it('col logo: si serve con una CSP che non esegue NIENTE, e aperto alle altre origini', async () => {
    const file = path.join(DIR, 'logo.svg')
    fs.writeFileSync(file, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    tenantLogoFile.mockResolvedValue({ path: file, mimeType: 'image/svg+xml', updatedAt: 'ieri' })

    const res = await fetch(`${base}/brand/tenant-1/logo`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    // Un SVG aperto da solo potrebbe lanciare script: qui non può.
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    // Senza questo una webmail non lo mostrerebbe.
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin')
    expect(res.headers.get('cache-control')).toContain('max-age=86400')
    expect(await res.text()).toContain('<svg')
  })

  it('e non chiede una sessione: un client di posta non ne ha una', async () => {
    const file = path.join(DIR, 'logo2.png')
    fs.writeFileSync(file, 'png')
    tenantLogoFile.mockResolvedValue({ path: file, mimeType: 'image/png', updatedAt: 'ieri' })
    // Nessuna intestazione di autenticazione, nessun cookie.
    expect((await fetch(`${base}/brand/tenant-1/logo`)).status).toBe(200)
  })
})
