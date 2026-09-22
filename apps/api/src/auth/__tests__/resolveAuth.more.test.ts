/**
 * resolveAuth on the three paths the main suite leaves out:
 *  - a DEACTIVATED user (revisione totale · M-6) with a still-valid token is
 *    refused on the very next request — otherwise "deactivate" would mean
 *    "deactivate in fifteen minutes", the lifetime of an access token;
 *  - the legacy dev JWT switched on WITHOUT a secret is a misconfiguration
 *    that must fail loudly, never verify against an empty key;
 *  - the host cross-check reads the first X-Forwarded-Host when Node hands
 *    the header over as an array, and a host with an empty first label
 *    (".opengrafo.com") names no tenant rather than the tenant "".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GraphQLError } from 'graphql'
import type express from 'express'
import { resetConfigCache } from '../../lib/config.js'
import { perms } from '../../lib/__tests__/testPermissions.js'

const verifyKeycloakToken = vi.fn()
vi.mock('../keycloak.js', () => ({ verifyKeycloakToken: (t: string) => verifyKeycloakToken(t) }))

const executeRead = vi.fn()
const close = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({ getSession: vi.fn(() => ({ executeRead, close })) }))

vi.mock('../../lib/roles.js', () => ({
  rolePermissions: vi.fn(async (_t: string, role: string) => perms(role)),
  tenantRoles: vi.fn(async () => new Map(['admin', 'operator'].map((key) => [key, { key, name: null, permissions: perms(key), isFactory: true }]))),
}))
vi.mock('../../lib/logger.js', () => ({ authLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

const { resolveAuth, extractTenantFromHost } = await import('../resolveAuth.js')

const req = (headers: Record<string, string | string[]> = {}): express.Request => ({ headers } as unknown as express.Request)
const kcToken = { sub: 's', email: 'alice@acme.io', preferred_username: 'alice', realm_access: { roles: [] }, iss: 'http://localhost:8080/realms/tenant-a' }

/** Tenant not suspended; the user lookup answers with `user` (or no row). */
function db(user: Record<string, unknown> | null) {
  executeRead.mockImplementation(async (work: (tx: { run: (q: string) => unknown }) => unknown) =>
    work({
      run: (q: string) => {
        if (q.includes('suspended_at')) return { records: [{ get: () => null }] }
        return { records: user ? [{ get: (k: string) => user[k] }] : [] }
      },
    }),
  )
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  return String((err as GraphQLError).extensions['code'])
}

beforeEach(() => {
  verifyKeycloakToken.mockReset()
  executeRead.mockReset()
})

describe('a deactivated user', () => {
  it('is refused with UNAUTHORIZED even with a valid token', async () => {
    verifyKeycloakToken.mockResolvedValue(kcToken)
    db({ id: 'u1', role: 'operator', active: false })
    const err = await resolveAuth('tok', req({ host: 'tenant-a.localhost' })).then(() => null, (e: unknown) => e) as GraphQLError
    expect(err.extensions['code']).toBe('UNAUTHORIZED')
    expect(err.message).toMatch(/deactivated/)
  })

  it('an active user on the same path is let in (the refusal is about `active`, nothing else)', async () => {
    verifyKeycloakToken.mockResolvedValue(kcToken)
    db({ id: 'u1', role: 'operator', active: true })
    await expect(resolveAuth('tok', req({ host: 'tenant-a.localhost' }))).resolves.toMatchObject({ tenantId: 'tenant-a', userId: 'u1', role: 'operator' })
  })
})

describe('host cross-check edge shapes', () => {
  it('X-Forwarded-Host as an array: the first value decides the tenant', async () => {
    verifyKeycloakToken.mockResolvedValue(kcToken)
    db({ id: 'u1', role: 'operator', active: true })
    expect(await codeOf(resolveAuth('tok', req({ 'x-forwarded-host': ['tenant-b.localhost', 'tenant-a.localhost'], host: 'tenant-a.localhost' }))))
      .toBe('UNAUTHORIZED')
    // …and it matches when the first value is the token's tenant.
    await expect(resolveAuth('tok', req({ 'x-forwarded-host': ['tenant-a.localhost'] }))).resolves.toMatchObject({ tenantId: 'tenant-a' })
  })

  it('an empty header array means no host, hence no cross-check', async () => {
    verifyKeycloakToken.mockResolvedValue(kcToken)
    db({ id: 'u1', role: 'operator', active: true })
    await expect(resolveAuth('tok', req({ 'x-forwarded-host': [] }))).resolves.toMatchObject({ tenantId: 'tenant-a' })
  })

  it('a host whose first label is empty names no tenant', () => {
    expect(extractTenantFromHost('.opengrafo.com')).toBeNull()
  })
})

describe('legacy dev JWT without a secret', () => {
  const saved = process.env['JWT_SECRET']
  beforeEach(() => {
    process.env['ALLOW_LEGACY_JWT'] = 'true'
    delete process.env['JWT_SECRET']
    resetConfigCache()
  })
  afterEach(() => {
    delete process.env['ALLOW_LEGACY_JWT']
    if (saved === undefined) delete process.env['JWT_SECRET']
    else process.env['JWT_SECRET'] = saved
    resetConfigCache()
  })

  it('fails loudly as a server misconfiguration, not as a bad credential', async () => {
    verifyKeycloakToken.mockRejectedValue('not a keycloak token')
    const err = await resolveAuth('tok', req()).then(() => null, (e: unknown) => e)
    // A plain Error (→ 500), not a GraphQLError UNAUTHORIZED that would hide the misconfiguration.
    expect(err).not.toBeInstanceOf(GraphQLError)
    expect((err as Error).message).toMatch(/ALLOW_LEGACY_JWT=true richiede JWT_SECRET/)
    expect(executeRead).not.toHaveBeenCalled()
  })
})
