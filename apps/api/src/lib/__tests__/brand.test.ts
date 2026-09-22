/**
 * The organization brand on the API: name, sender, reply-to and logo.
 *
 * Why these behaviours matter:
 *  - the logo is served on a PUBLIC route (mail clients have no session) and
 *    can be opened on its own, outside an `<img>`: an SVG with a script, an
 *    event handler or an external link would run on our origin. The type is
 *    decided from the bytes, never from the browser's MIME;
 *  - the file lives in `ATTACHMENT_DIR/<tenant>/_brand/`, and the path read
 *    back from the database must stay inside THAT tenant's folder — a stored
 *    path pointing elsewhere would turn the public route into a file reader;
 *  - replacing a PNG with an SVG must not leave the old file behind, and
 *    removing the logo must delete it;
 *  - a bad name or reply-to must reach the admin as a translatable
 *    ValidationError, and a write must invalidate the caches (schema and
 *    e-mail brand) so the new name shows up without a restart.
 * Neo4j is faked in memory; the filesystem is real (a scratch dir).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'og-brand-lib-test-'))

vi.mock('../config.js', () => ({ config: { attachmentDir: DIR } }))

/** Tenant id → stored `t.brand` JSON (undefined = tenant does not exist). */
const tenants = new Map<string, string | null>()
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
  runQueryOne: vi.fn(async (_s: unknown, cypher: string, params: { tenantId: string; json?: string }) => {
    if (!tenants.has(params.tenantId)) return null
    if (cypher.includes('SET t.brand')) {
      tenants.set(params.tenantId, params.json!)
      return { id: params.tenantId }
    }
    return { raw: tenants.get(params.tenantId) }
  }),
}))
vi.mock('@opengraphity/notifications', () => ({ invalidateTenantBrand: vi.fn() }))
vi.mock('../schemaInvalidator.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../schemaInvalidator.js')>(),
  invalidateSchema: vi.fn(),
}))

const brand = await import('../brand.js')
const { invalidateTenantBrand } = await import('@opengraphity/notifications')
const { invalidateSchema } = await import('../schemaInvalidator.js')
const { NotFoundError, ValidationError } = await import('../errors.js')
const { BRAND_LOGO_MAX_BYTES } = await import('@opengraphity/types')

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest-of-png')])
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>')
const brandDir = (t: string) => path.join(DIR, t, '_brand')
const stored = (t: string) => JSON.parse(tenants.get(t)!) as { displayName: string; logo: { path: string; mimeType: string } | null }

beforeEach(() => {
  vi.clearAllMocks()
  brand.clearBrandCache()
  tenants.clear()
  tenants.set('tenant-a', null)
  fs.rmSync(DIR, { recursive: true, force: true })
  fs.mkdirSync(DIR, { recursive: true })
})
afterAll(() => { fs.rmSync(DIR, { recursive: true, force: true }) })

describe('detectLogoType — the bytes decide, not the MIME', () => {
  it('PNG by magic number', () => {
    expect(brand.detectLogoType(PNG)).toBe('image/png')
  })

  it('SVG, also behind a BOM, an XML declaration and comments', () => {
    expect(brand.detectLogoType(SVG)).toBe('image/svg+xml')
    const wrapped = Buffer.from('﻿  <?xml version="1.0"?>\n<!-- made by hand --><svg viewBox="0 0 1 1"></svg>')
    expect(brand.detectLogoType(wrapped)).toBe('image/svg+xml')
    // Internal fragment links are harmless and common in real logos.
    expect(brand.detectLogoType(Buffer.from('<svg><use href="#a"/></svg>'))).toBe('image/svg+xml')
  })

  it('an SVG that can run code or load something external is refused', () => {
    for (const bad of [
      '<svg><script>alert(1)</script></svg>',
      '<svg onload="alert(1)"></svg>',
      '<svg><a href="javascript:alert(1)">x</a></svg>',
      '<svg><foreignObject></foreignObject></svg>',
      '<svg><image xlink:href="https://evil.example/x.png"/></svg>',
      '<svg><image href="https://evil.example/x.png"/></svg>',
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg></svg>',
    ]) {
      let err: unknown = null
      try { brand.detectLogoType(Buffer.from(bad)) } catch (e) { err = e }
      // The DOCTYPE case fails the SVG shape test instead: either way it is refused.
      expect(err, bad).toBeInstanceOf(ValidationError)
    }
    expect(() => brand.detectLogoType(Buffer.from('<svg onload="x()"></svg>'))).toThrow(/scripts, event handlers/)
  })

  it('anything else (a JPEG, HTML) is refused with its i18n key', () => {
    let err: InstanceType<typeof ValidationError> | null = null
    try { brand.detectLogoType(Buffer.from('<html><svg></svg></html>')) } catch (e) { err = e as InstanceType<typeof ValidationError> }
    expect(err?.extensions['i18n']).toMatchObject({ key: 'errors.brand.logoType' })
  })

  it('over 1 MB is refused before the content is even looked at', () => {
    expect(() => brand.detectLogoType(Buffer.concat([PNG, Buffer.alloc(BRAND_LOGO_MAX_BYTES)]))).toThrow(/larger than 1 MB/)
  })
})

describe('tenantBrand / setTenantBrandTexts', () => {
  it('a tenant without a stored brand gets the product brand, flagged as default', async () => {
    await expect(brand.tenantBrand('tenant-a')).resolves.toMatchObject({ displayName: 'OpenGrafo', logo: null, isDefault: true })
  })

  it('an unknown tenant is NotFound, not a default brand', async () => {
    await expect(brand.tenantBrand('ghost')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('saves trimmed texts, keeps the current logo, and invalidates both caches', async () => {
    tenants.set('tenant-a', JSON.stringify({ displayName: 'Acme', senderName: 'Acme', replyTo: null, logo: { mimeType: 'image/png', path: '/x/logo.png', updatedAt: 't0' } }))
    const out = await brand.setTenantBrandTexts('tenant-a', { displayName: '  Acme Corp ', senderName: 'Acme Service Desk', replyTo: 'help@acme.example' })
    expect(out).toMatchObject({ displayName: 'Acme Corp', senderName: 'Acme Service Desk', replyTo: 'help@acme.example', isDefault: false })
    expect(stored('tenant-a').logo).toMatchObject({ path: '/x/logo.png' })
    expect(invalidateSchema).toHaveBeenCalledWith('tenant-a')
    expect(invalidateTenantBrand).toHaveBeenCalledWith('tenant-a')
  })

  it('an invalid name or reply-to becomes a ValidationError with the brand i18n key, and nothing is written', async () => {
    const before = tenants.get('tenant-a')
    await expect(brand.setTenantBrandTexts('tenant-a', { displayName: 'A <script>', senderName: 'A', replyTo: null }))
      .rejects.toMatchObject({ constructor: ValidationError, extensions: { i18n: { key: 'errors.brand.displayName' } } })
    await expect(brand.setTenantBrandTexts('tenant-a', { displayName: 'A', senderName: 'A', replyTo: 'not-an-email' }))
      .rejects.toMatchObject({ extensions: { i18n: { key: 'errors.brand.replyTo' } } })
    expect(tenants.get('tenant-a')).toBe(before)
  })

  it('a tenant that disappears between the read and the write is NotFound', async () => {
    const { runQueryOne } = await import('@opengraphity/neo4j')
    vi.mocked(runQueryOne).mockResolvedValueOnce({ raw: null }).mockResolvedValueOnce(null)
    await expect(brand.setTenantBrandTexts('tenant-a', { displayName: 'A', senderName: 'A', replyTo: null }))
      .rejects.toBeInstanceOf(NotFoundError)
    expect(invalidateTenantBrand).not.toHaveBeenCalled()
  })
})

describe('setTenantLogo / removeTenantLogo', () => {
  it('stores a PNG under the tenant brand folder and records it', async () => {
    const out = await brand.setTenantLogo('tenant-a', PNG)
    const file = path.join(brandDir('tenant-a'), 'logo.png')
    expect(fs.readFileSync(file).equals(PNG)).toBe(true)
    expect(out.logo).toMatchObject({ mimeType: 'image/png', path: file })
    expect(stored('tenant-a').logo?.path).toBe(file)
  })

  it('replacing a PNG with an SVG deletes the old PNG', async () => {
    await brand.setTenantLogo('tenant-a', PNG)
    await brand.setTenantLogo('tenant-a', SVG)
    expect(fs.readdirSync(brandDir('tenant-a'))).toEqual(['logo.svg'])
    expect(stored('tenant-a').logo?.mimeType).toBe('image/svg+xml')
  })

  it('an unsafe tenant id never becomes a path', async () => {
    await expect(brand.setTenantLogo('../etc', PNG)).rejects.toThrow(/Unsafe tenant id/)
    expect(fs.readdirSync(DIR)).toEqual([])
  })

  it('an invalid file is refused before anything touches the disk', async () => {
    await expect(brand.setTenantLogo('tenant-a', Buffer.from('GIF89a'))).rejects.toBeInstanceOf(ValidationError)
    expect(fs.existsSync(brandDir('tenant-a'))).toBe(false)
  })

  it('removing deletes the file and clears the record', async () => {
    await brand.setTenantLogo('tenant-a', PNG)
    const out = await brand.removeTenantLogo('tenant-a')
    expect(out.logo).toBeNull()
    expect(fs.readdirSync(brandDir('tenant-a'))).toEqual([])
    expect(stored('tenant-a').logo).toBeNull()
  })

  it('removing when the file is already gone (or there is no logo) still clears the record', async () => {
    await brand.setTenantLogo('tenant-a', PNG)
    fs.rmSync(path.join(brandDir('tenant-a'), 'logo.png'))
    await expect(brand.removeTenantLogo('tenant-a')).resolves.toMatchObject({ logo: null })
    await expect(brand.removeTenantLogo('tenant-a')).resolves.toMatchObject({ logo: null })
  })
})

describe('tenantLogoFile — what the public route may serve', () => {
  it('no logo → null', async () => {
    await expect(brand.tenantLogoFile('tenant-a')).resolves.toBeNull()
  })

  it('the stored logo inside the tenant folder is served', async () => {
    await brand.setTenantLogo('tenant-a', SVG)
    brand.clearBrandCache()
    await expect(brand.tenantLogoFile('tenant-a')).resolves.toMatchObject({
      path: path.join(brandDir('tenant-a'), 'logo.svg'), mimeType: 'image/svg+xml',
    })
  })

  it('a stored path outside THIS tenant brand folder is never served', async () => {
    // Another tenant's real logo: exists on disk, but belongs to someone else.
    tenants.set('tenant-b', null)
    await brand.setTenantLogo('tenant-b', PNG)
    const foreign = path.join(brandDir('tenant-b'), 'logo.png')
    tenants.set('tenant-a', JSON.stringify({ displayName: 'A', senderName: 'A', replyTo: null, logo: { mimeType: 'image/png', path: foreign, updatedAt: 't' } }))
    brand.clearBrandCache()
    await expect(brand.tenantLogoFile('tenant-a')).resolves.toBeNull()
  })

  it('a recorded logo whose file is missing on disk → null (a 404, not a crash)', async () => {
    tenants.set('tenant-a', JSON.stringify({ displayName: 'A', senderName: 'A', replyTo: null, logo: { mimeType: 'image/png', path: path.join(brandDir('tenant-a'), 'logo.png'), updatedAt: 't' } }))
    await expect(brand.tenantLogoFile('tenant-a')).resolves.toBeNull()
  })
})

describe('logoUrlOf', () => {
  it('carries the version for cache busting and encodes the tenant; null without a logo', () => {
    const b = { displayName: 'A', senderName: 'A', replyTo: null }
    expect(brand.logoUrlOf('tenant a', { ...b, logo: { mimeType: 'image/png', path: '/p', updatedAt: '2026-09-22T10:00:00Z' } }))
      .toBe('/api/brand/tenant%20a/logo?v=2026-09-22T10%3A00%3A00Z')
    expect(brand.logoUrlOf('tenant-a', { ...b, logo: null })).toBeNull()
  })
})
