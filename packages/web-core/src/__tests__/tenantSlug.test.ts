import { describe, it, expect } from 'vitest'
import { getTenantSlug, requireTenantSlug } from '../tenantSlug.js'

// Same table as `extractTenantFromHost` in
// apps/api/src/auth/__tests__/resolveAuth.test.ts — keep the two in sync.
describe('getTenantSlug (mirror of API extractTenantFromHost)', () => {
  it.each([
    ['c-one.localhost',                 'c-one'],
    ['c-one.localhost:4000',            'c-one'],
    ['c-one.opengrafo.com',             'c-one'],
    ['acme.opengrafo.com:443',          'acme'],
    ['portal.c-one.localhost',          'c-one'],      // portal prefix skipped
    ['portal.acme.opengrafo.com',       'acme'],
    ['portal.localhost',                'portal'],     // only 2 labels: "portal" is the slug
    ['10x-labs.example.com',            '10x-labs'],   // starts with "10" but is a slug, not an IP
    ['192corp.example.com',             '192corp'],    // idem with "192"
    ['c-one.localhost, proxy.internal', 'c-one'],      // proxy chain: first value
  ])('%s → %s', (host, tenant) => {
    expect(getTenantSlug(host)).toBe(tenant)
  })

  it.each([
    '', 'localhost', 'localhost:5173',
    '127.0.0.1', '127.0.0.1:4000', '192.168.1.10', '10.0.0.5:80', '172.16.0.1',
    '[::1]', '[::1]:4000', '[fe80::1%25en0]:4000', '[2001:db8::1]',
  ])('%s → null', (host) => {
    expect(getTenantSlug(host)).toBeNull()
  })
})

describe('requireTenantSlug', () => {
  it('returns the slug from the hostname', () => {
    expect(requireTenantSlug({ hostname: 'c-one.localhost', hint: 'x' })).toBe('c-one')
  })

  it('override wins over the hostname; empty override is ignored', () => {
    expect(requireTenantSlug({ hostname: 'c-one.localhost', override: 'acme', hint: 'x' })).toBe('acme')
    expect(requireTenantSlug({ hostname: 'c-one.localhost', override: '', hint: 'x' })).toBe('c-one')
  })

  it('throws a readable error (with the hint) instead of guessing a tenant', () => {
    expect(() => requireTenantSlug({ hostname: 'localhost', hint: 'c-one.localhost:5173' }))
      .toThrow(/Nessun tenant nel sottodominio \("localhost"\).*c-one\.localhost:5173.*VITE_TENANT_SLUG/)
    expect(() => requireTenantSlug({ hostname: '192.168.1.5', hint: 'x' })).toThrow(/Nessun tenant/)
  })
})
