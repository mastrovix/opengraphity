/**
 * THE CUSTOMER'S BRAND IN THE E-MAILS THAT GO OUT.
 *
 * One layout for every outgoing e-mail — the notification rules' and the
 * API's alike — carrying the organization's logo and name, with a small
 * "Powered by OpenGrafo" at the foot. The sender keeps the platform address
 * and takes the customer's name; replies go where the customer said.
 *
 * The part worth pinning is the ESCAPING. The display name is typed by a
 * customer administrator and lands in an HTML document read by e-mail
 * clients: a name containing a tag must arrive as text, not as markup. The
 * logo URL is built here too, and it goes into an `src` attribute.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { TenantBrand } from '@opengraphity/types'

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  reads: 0,
  closed: 0,
  sent: [] as Array<Record<string, unknown>>,
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
      fn({
        run: async (_c: string, _p: Record<string, unknown>) => {
          state.reads += 1
          return { records: state.rows.map((r) => ({ get: (k: string) => r[k] })) }
        },
      }),
    close: async () => { state.closed += 1 },
  }),
}))
vi.mock('../email.js', () => ({ sendEmail: async (m: Record<string, unknown>) => { state.sent.push(m) } }))

const { loadTenantBrand, invalidateTenantBrand, brandLogoUrl, brandedEmailHtml, sendTenantEmail } = await import('../brand.js')

const BRAND: TenantBrand = { displayName: 'Acme', senderName: 'Acme Support', replyTo: 'help@acme.example', logo: null }
const originalAppUrl = process.env['APP_URL']

beforeEach(() => {
  process.env['APP_URL'] = 'https://og.acme.example'
  state.rows = [{ brand: JSON.stringify(BRAND) }]
  state.reads = 0
  state.closed = 0
  state.sent = []
  invalidateTenantBrand()
})
afterEach(() => {
  if (originalAppUrl === undefined) delete process.env['APP_URL']
  else process.env['APP_URL'] = originalAppUrl
})

describe('loadTenantBrand', () => {
  it('reads the brand of the organization and drops the isDefault flag', async () => {
    // `isDefault` tells the API's diagnostics whether the customer ever
    // configured a brand; it has no business travelling into an e-mail.
    const b = await loadTenantBrand('c-one')
    expect(b).toEqual(BRAND)
    expect(b).not.toHaveProperty('isDefault')
    expect(state.closed).toBe(1)
  })

  it('a tenant with no brand configured gets the factory one', async () => {
    state.rows = [{ brand: null }]
    expect(await loadTenantBrand('c-one')).toMatchObject({ displayName: expect.any(String), logo: null })
  })

  it('a tenant that does not exist is an error naming it', async () => {
    state.rows = []
    await expect(loadTenantBrand('c-ghost')).rejects.toThrow('[notifications] Tenant c-ghost not found: cannot read its brand')
  })

  it('the answer is cached per tenant, and invalidating one does not clear the others', async () => {
    await loadTenantBrand('c-one')
    await loadTenantBrand('c-one')
    expect(state.reads).toBe(1)
    await loadTenantBrand('c-two')
    invalidateTenantBrand('c-one')
    await loadTenantBrand('c-one')
    await loadTenantBrand('c-two')
    expect(state.reads).toBe(3)
  })

  it('the session is closed even when the brand does not parse', async () => {
    state.rows = [{ brand: '{not json' }]
    await expect(loadTenantBrand('c-one')).rejects.toThrow(/brand is not valid JSON/)
    expect(state.closed).toBe(1)
  })
})

describe('brandLogoUrl', () => {
  it('no logo, no URL', () => {
    expect(brandLogoUrl('c-one', BRAND)).toBeNull()
  })

  it('points at the public endpoint and carries the update time as a cache buster', () => {
    // E-mail clients cache images hard: without `?v=` a customer who changes
    // the logo keeps seeing the old one in every new message.
    const withLogo: TenantBrand = { ...BRAND, logo: { mimeType: 'image/png', path: 'logos/c-one.png', updatedAt: '2026-09-01T10:00:00Z' } }
    expect(brandLogoUrl('c-one', withLogo))
      .toBe('https://og.acme.example/api/brand/c-one/logo?v=2026-09-01T10%3A00%3A00Z')
  })

  it('a tenant id needing escaping is encoded, not interpolated raw', () => {
    const withLogo: TenantBrand = { ...BRAND, logo: { mimeType: 'image/png', path: 'p', updatedAt: 'x' } }
    expect(brandLogoUrl('c one/../admin', withLogo)).toContain('/api/brand/c%20one%2F..%2Fadmin/logo')
  })
})

describe('brandedEmailHtml', () => {
  it('carries the display name, the language and the footer', () => {
    const html = brandedEmailHtml('c-one', BRAND, '<p>Incident INC-1</p>', 'it')
    expect(html).toContain('<html lang="it">')
    expect(html).toContain('Acme')
    expect(html).toContain('<p>Incident INC-1</p>')
    expect(html).toContain('Powered by OpenGrafo')
  })

  it('with a logo it shows the image AND the name; without one, the name alone', () => {
    const withLogo: TenantBrand = { ...BRAND, logo: { mimeType: 'image/png', path: 'p', updatedAt: 'v1' } }
    const html = brandedEmailHtml('c-one', withLogo, '', 'en')
    expect(html).toContain('<img src="https://og.acme.example/api/brand/c-one/logo?v=v1"')
    expect(html).toContain('alt="Acme"')
    expect(brandedEmailHtml('c-one', BRAND, '', 'en')).not.toContain('<img')
  })

  it('a display name containing markup arrives as TEXT: it is typed by a customer', () => {
    // The administrator who types it is not necessarily the person who reads
    // the message — in a shared tenant this is a stored-XSS surface.
    const evil: TenantBrand = { ...BRAND, displayName: '<script>alert(1)</script>' }
    const html = brandedEmailHtml('c-one', evil, '', 'en')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('the logo URL and the language are escaped inside their attributes', () => {
    const evil: TenantBrand = { ...BRAND, displayName: 'A" onerror="x', logo: { mimeType: 'image/png', path: 'p', updatedAt: 'v"1' } }
    const html = brandedEmailHtml('c-one', evil, '', 'en" onload="x')
    expect(html).not.toContain('onerror="x"')
    expect(html).not.toContain('onload="x"')
    expect(html).toContain('lang="en&quot; onload=&quot;x"')
  })

  it('the content is NOT escaped: it is the HTML the caller composed', () => {
    // Every caller builds it from already-escaped pieces; escaping here would
    // turn every e-mail into a page of visible tags.
    expect(brandedEmailHtml('c-one', BRAND, '<b>bold</b>', 'en')).toContain('<b>bold</b>')
  })
})

describe('sendTenantEmail', () => {
  it('sends with the organization\'s sender name and reply-to, leaving the address to the platform', async () => {
    await sendTenantEmail('c-one', { to: 'anna@acme.example', subject: 'INC-1', html: '<p>x</p>' })
    expect(state.sent).toEqual([{
      to: 'anna@acme.example', subject: 'INC-1', html: '<p>x</p>',
      senderName: 'Acme Support', replyTo: 'help@acme.example',
    }])
    expect(state.sent[0]).not.toHaveProperty('from')
  })

  it('an organization with no reply-to configured passes null, and the platform default applies', async () => {
    state.rows = [{ brand: JSON.stringify({ ...BRAND, replyTo: null }) }]
    await sendTenantEmail('c-one', { to: 'a@b.c', subject: 's', html: 'h' })
    expect(state.sent[0]!['replyTo']).toBeNull()
  })
})
