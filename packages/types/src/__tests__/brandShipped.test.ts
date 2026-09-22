/**
 * THE CUSTOMER'S BRAND, AND THE LABELS THE PRODUCT SHIPS.
 *
 * Two places where the customer's choice and the product's default meet, and
 * both have the same rule: once the customer has said something, the product
 * stops deciding. A renamed label stays renamed in every language; a chosen
 * sender name replaces the product's — but never the sending ADDRESS, which
 * stays on the domain whose SPF and DKIM records we control.
 */
import { describe, it, expect } from 'vitest'
import {
  FACTORY_TENANT_BRAND, BRAND_NAME_MAX_LENGTH, BRAND_LOGO_MIME_TYPES, BrandError,
  assertBrandName, assertReplyTo, parseTenantBrand, emailAddressOf, brandedFrom,
} from '../brand.js'
import { SHIPPED_LABELS, shippedLabelIn } from '../shippedLabels.js'

describe('assertBrandName', () => {
  it('trims and accepts an ordinary name', () => {
    expect(assertBrandName('  Acme S.p.A.  ', 'displayName')).toBe('Acme S.p.A.')
  })

  it('refuses the characters that would break a From: header', () => {
    // The name goes into `Name <address>`: an angle bracket or a newline
    // there is header injection, not a typo.
    for (const bad of ['Acme <evil@x>', 'Acme"', 'Acme\r\nBcc: someone@x', 'a>b']) {
      expect(() => assertBrandName(bad, 'senderName')).toThrow(BrandError)
    }
  })

  it('refuses empty, whitespace-only, non-string and over-long names', () => {
    for (const bad of ['', '   ', null, undefined, 42, {}, 'a'.repeat(BRAND_NAME_MAX_LENGTH + 1)]) {
      expect(() => assertBrandName(bad, 'displayName')).toThrow(BrandError)
    }
    expect(assertBrandName('a'.repeat(BRAND_NAME_MAX_LENGTH), 'displayName')).toHaveLength(BRAND_NAME_MAX_LENGTH)
  })

  it('the error names the field and carries an i18n key: the customer reads it in their language', () => {
    try { assertBrandName('', 'senderName') }
    catch (e) {
      expect((e as BrandError).key).toBe('errors.brand.senderName')
      expect((e as BrandError).params).toEqual({ max: BRAND_NAME_MAX_LENGTH })
    }
  })
})

describe('assertReplyTo', () => {
  it('absent, null or blank means "no reply-to", not an error', () => {
    for (const nothing of [null, undefined, '', '   ']) expect(assertReplyTo(nothing)).toBeNull()
  })

  it('accepts an address and trims it', () => {
    expect(assertReplyTo('  help@acme.example  ')).toBe('help@acme.example')
  })

  it('refuses anything that is not an address, including one with header characters', () => {
    for (const bad of ['not an address', 'a@b', '@acme.example', 'a b@acme.example', 'a@acme.example, b@x.y',
                       'a<b@acme.example', `${'a'.repeat(250)}@acme.example`, 42]) {
      expect(() => assertReplyTo(bad), String(bad)).toThrow(BrandError)
    }
  })
})

describe('parseTenantBrand', () => {
  it('nothing stored means the product brand, and says so', () => {
    expect(parseTenantBrand(null, 'c-one')).toEqual({ ...FACTORY_TENANT_BRAND, isDefault: true })
  })

  it('a stored brand comes back parsed, and is no longer the default', () => {
    const stored = JSON.stringify({ displayName: 'Acme', senderName: 'Acme Support', replyTo: 'help@acme.example', logo: null })
    expect(parseTenantBrand(stored, 'c-one')).toEqual({
      displayName: 'Acme', senderName: 'Acme Support', replyTo: 'help@acme.example', logo: null, isDefault: false,
    })
  })

  it('a stored value that is not JSON is an error naming the tenant', () => {
    expect(() => parseTenantBrand('{not json', 'c-one')).toThrow(/Tenant c-one: brand is not valid JSON/)
  })

  it('a logo counts only with a path AND a mime type the product serves', () => {
    // The mime type goes into the Content-Type of the brand endpoint: an
    // arbitrary one would let a tenant serve anything from our origin.
    const withLogo = (logo: unknown) => parseTenantBrand(JSON.stringify({ ...FACTORY_TENANT_BRAND, logo }), 'c-one').logo
    for (const mimeType of BRAND_LOGO_MIME_TYPES) {
      expect(withLogo({ mimeType, path: 'p', updatedAt: 'v1' })).toEqual({ mimeType, path: 'p', updatedAt: 'v1' })
    }
    for (const bad of [
      null, {}, { path: 'p' }, { mimeType: 'image/png' },
      { mimeType: 'text/html', path: 'p' }, { mimeType: 'image/jpeg', path: 'p' }, { mimeType: 'image/png', path: 42 },
    ]) {
      expect(withLogo(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('a logo with no update time still parses: the cache buster just becomes empty', () => {
    expect(parseTenantBrand(JSON.stringify({ ...FACTORY_TENANT_BRAND, logo: { mimeType: 'image/png', path: 'p' } }), 'c-one').logo)
      .toEqual({ mimeType: 'image/png', path: 'p', updatedAt: '' })
  })

  it('an invalid name or reply-to inside the stored JSON surfaces as a brand error', () => {
    expect(() => parseTenantBrand(JSON.stringify({ displayName: '', senderName: 'x' }), 'c-one')).toThrow(BrandError)
    expect(() => parseTenantBrand(JSON.stringify({ displayName: 'A', senderName: 'A', replyTo: 'nope' }), 'c-one')).toThrow(BrandError)
  })
})

describe('the sender: the customer\'s name, the platform\'s address', () => {
  it('extracts the address from either form', () => {
    expect(emailAddressOf('OpenGrafo <no-reply@opengrafo.example>')).toBe('no-reply@opengrafo.example')
    expect(emailAddressOf('  no-reply@opengrafo.example  ')).toBe('no-reply@opengrafo.example')
  })

  it('keeps the address and replaces only the name', () => {
    // Swapping the address would make every message fail SPF/DKIM at the
    // receiver: the customer picks what is read, not what is authenticated.
    expect(brandedFrom('OpenGrafo <no-reply@opengrafo.example>', 'Acme Support'))
      .toBe('Acme Support <no-reply@opengrafo.example>')
    expect(brandedFrom('no-reply@opengrafo.example', 'Acme Support'))
      .toBe('Acme Support <no-reply@opengrafo.example>')
  })
})

describe('shipped labels — translated until the customer renames them', () => {
  it('every entry has both languages, and neither is empty', () => {
    for (const [kind, entries] of Object.entries(SHIPPED_LABELS)) {
      for (const [name, v] of Object.entries(entries)) {
        expect(v.en, `${kind}.${name}`).toBeTruthy()
        expect(v.it, `${kind}.${name}`).toBeTruthy()
      }
    }
  })

  it('a technical word stays the technical word in Italian: it names the thing', () => {
    // "Banca dati" and "Cambiamento" would give a product nobody in ITSM
    // recognises. This is the technical-words rule, not a missed translation.
    expect(SHIPPED_LABELS.type['database']!.it).toBe('Database')
    expect(SHIPPED_LABELS.type['incident']!.it).toBe('Incident')
    expect(SHIPPED_LABELS.type['change']!.it).toBe('Change')
    expect(SHIPPED_LABELS.type['problem']!.it).toBe('Problem')
  })

  it('a shipped label still carrying its shipped English text is translated', () => {
    expect(shippedLabelIn('field', 'severity', 'Severity', 'it')).toBe('Severità')
    expect(shippedLabelIn('type', 'server', 'Server', 'it')).toBe('Server')
    expect(shippedLabelIn('relation', 'dependencies', 'Dependencies', 'it')).toBe('Dipendenze')
  })

  it('once the customer RENAMES it, it is theirs — in every language (F-22)', () => {
    // The designer always wins over the product: translating a renamed label
    // would overwrite the customer's own words.
    expect(shippedLabelIn('field', 'severity', 'Gravità', 'it')).toBe('Gravità')
    expect(shippedLabelIn('field', 'severity', 'Gravità', 'en')).toBe('Gravità')
  })

  it('a name the product never shipped is the customer\'s by definition', () => {
    expect(shippedLabelIn('field', 'cost_centre', 'Centro di costo', 'it')).toBe('Centro di costo')
    expect(shippedLabelIn('field', 'cost_centre', null, 'it')).toBe('cost_centre')
  })

  it('an unknown or missing language falls back to what is stored, it never returns empty', () => {
    expect(shippedLabelIn('field', 'severity', 'Severity', 'de')).toBe('Severity')
    expect(shippedLabelIn('field', 'severity', 'Severity', null)).toBe('Severity')
    expect(shippedLabelIn('field', 'severity', 'Severity', undefined)).toBe('Severity')
  })

  it('with NO label in the graph the internal name comes back untranslated', () => {
    // The comparison is against the label stored, and there is none: the
    // internal name is not the shipped English text, so the entry counts as
    // renamed. Every field the product ships does carry its label, so this
    // is the shape of rows built elsewhere (an import, a test) rather than a
    // path a customer reaches.
    expect(shippedLabelIn('field', 'severity', undefined, 'it')).toBe('severity')
    expect(shippedLabelIn('field', 'severity', '', 'it')).toBe('severity')
  })

  it('a prototype property name is not an entry: it falls through to the stored label', () => {
    expect(shippedLabelIn('field', 'toString', 'Qualcosa', 'it')).toBe('Qualcosa')
  })
})
