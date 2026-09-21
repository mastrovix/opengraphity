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

  /**
   * Terza revisione: l'override NON vince piu su `*.localhost`.
   *
   * Vinceva sempre, e la conseguenza era che un'installazione locale
   * multi-tenant poteva raggiungerne uno solo: il bundle e costruito una volta
   * con `VITE_TENANT_SLUG` dentro, quindi `c-two.localhost` finiva sul realm
   * `c-one` e Keycloak rifiutava il `redirect_uri`. Verificato in un browser
   * vero prima della modifica.
   */
  it('su *.localhost decide l\'HOSTNAME, non l\'override', () => {
    expect(requireTenantSlug({ hostname: 'c-one.localhost', override: 'acme', hint: 'x' })).toBe('c-one')
    expect(requireTenantSlug({ hostname: 'c-test.localhost', override: 'c-one', hint: 'x' })).toBe('c-test')
    expect(requireTenantSlug({ hostname: 'c-two.localhost:5173', override: 'c-one', hint: 'x' })).toBe('c-two')
  })

  it('fuori da *.localhost l\'override vince, ed e cosi che Tailscale funziona', () => {
    // Su quell'host `getTenantSlug` restituirebbe «macbook-pro-di-vittorio»,
    // che non e un tenant: senza l'override l'app era irraggiungibile.
    expect(requireTenantSlug({ hostname: 'macbook-pro-di-vittorio.tailcf0f55.ts.net', override: 'c-one', hint: 'x' })).toBe('c-one')
    // In produzione l'hostname nomina il tenant e l'override non c'e.
    expect(requireTenantSlug({ hostname: 'acme.opengrafo.com', hint: 'x' })).toBe('acme')
    // Ma se c'e, continua a vincere: comportamento invariato fuori dal locale.
    expect(requireTenantSlug({ hostname: 'acme.opengrafo.com', override: 'altro', hint: 'x' })).toBe('altro')
  })

  it('override vuoto e ignorato', () => {
    expect(requireTenantSlug({ hostname: 'c-one.localhost', override: '', hint: 'x' })).toBe('c-one')
    expect(requireTenantSlug({ hostname: 'acme.opengrafo.com', override: '', hint: 'x' })).toBe('acme')
  })

  it('`localhost` nudo non ha tenant: l\'override resta l\'unica via', () => {
    expect(requireTenantSlug({ hostname: 'localhost', override: 'c-one', hint: 'x' })).toBe('c-one')
  })

  it('throws a readable error (with the hint) instead of guessing a tenant', () => {
    expect(() => requireTenantSlug({ hostname: 'localhost', hint: 'c-one.localhost:5173' }))
      // CONTRATTO RINEGOZIATO (revisione totale · H-34): i messaggi di
      // bootstrap sono in inglese — succedono prima che ci sia un tenant, e
      // quindi prima che ci sia una lingua del cliente.
      .toThrow(/No tenant in the subdomain \("localhost"\).*c-one\.localhost:5173.*VITE_TENANT_SLUG/)
    expect(() => requireTenantSlug({ hostname: '192.168.1.5', hint: 'x' })).toThrow(/No tenant/)
  })
})
