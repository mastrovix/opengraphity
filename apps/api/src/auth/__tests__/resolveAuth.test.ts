import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GraphQLError } from 'graphql'
import { resetConfigCache } from '../../lib/config.js'
import type express from 'express'

// ── Mocks (declared before the dynamic import below) ─────────────────────────

const verifyKeycloakToken = vi.fn()
vi.mock('../keycloak.js', () => ({ verifyKeycloakToken: (t: string) => verifyKeycloakToken(t) }))

const executeRead = vi.fn()
const close       = vi.fn().mockResolvedValue(undefined)
vi.mock('@opengraphity/neo4j', () => ({
  getSession: vi.fn(() => ({ executeRead, close })),
}))

vi.mock('../../lib/logger.js', () => ({
  authLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

process.env['JWT_SECRET'] = 'test-secret'
delete process.env['ALLOW_LEGACY_JWT']

const { resolveAuth, extractTenantFromHost, extractRealmFromIssuer } = await import('../resolveAuth.js')

// ── Helpers ──────────────────────────────────────────────────────────────────

const makeReq = (headers: Record<string, string> = {}): express.Request =>
  ({ headers } as unknown as express.Request)

const kcToken = (over: Partial<{ iss: string; email: string }> = {}) => ({
  sub:                'kc-sub',
  email:              'alice@acme.io',
  preferred_username: 'alice',
  realm_access:       { roles: ['operator'] },
  iss:                'http://localhost:8080/realms/tenant-a',
  ...over,
})

const record = (map: Record<string, unknown>) => ({ get: (k: string) => map[k] ?? null })

/** Makes the DB answer with the given rows and records the Cypher params it received. */
function dbReturns(rows: ReturnType<typeof record>[]) {
  executeRead.mockImplementation(async (work: (tx: { run: (q: string, p: unknown) => unknown }) => unknown) =>
    work({ run: (_q, _p) => ({ records: rows }) }),
  )
}
function lastQueryParams(): Record<string, unknown> {
  const captured: Record<string, unknown> = {}
  executeRead.mockImplementation(async (work: (tx: { run: (q: string, p: Record<string, unknown>) => unknown }) => unknown) =>
    work({ run: (_q, p) => { Object.assign(captured, p); return { records: [] } } }),
  )
  return captured
}

const rejectsWithCode = async (p: Promise<unknown>, code: string, msg?: string | RegExp) => {
  const err = await p.then(() => null, (e: unknown) => e)
  expect(err).toBeInstanceOf(GraphQLError)
  expect((err as GraphQLError).extensions['code']).toBe(code)
  if (msg) expect((err as GraphQLError).message).toMatch(msg)
}

beforeEach(() => {
  verifyKeycloakToken.mockReset()
  executeRead.mockReset()
  delete process.env['ALLOW_LEGACY_JWT']
  // config memoizza: ogni caso rilegge ALLOW_LEGACY_JWT/JWT_SECRET dall'env
  resetConfigCache()
})

// ── resolveAuth ──────────────────────────────────────────────────────────────

describe('resolveAuth (Keycloak)', () => {
  it('risolve l\'utente nel realm del token e usa u.role', async () => {
    verifyKeycloakToken.mockResolvedValue(kcToken())
    dbReturns([record({ id: 'u-1', role: 'operator' })])

    const ctx = await resolveAuth('tok', makeReq({ host: 'tenant-a.localhost' }))

    expect(ctx).toEqual({ tenantId: 'tenant-a', userId: 'u-1', userEmail: 'alice@acme.io', role: 'operator' })
    expect(close).toHaveBeenCalled()
  })

  it('cerca l\'utente con tenant_id = realm (mai LIMIT 1 senza tenant)', async () => {
    verifyKeycloakToken.mockResolvedValue(kcToken({ iss: 'http://localhost:8080/realms/tenant-b' }))
    const params = lastQueryParams()

    await rejectsWithCode(resolveAuth('tok', makeReq()), 'UNAUTHORIZED', /user not found/)
    expect(params).toEqual({ email: 'alice@acme.io', tenantId: 'tenant-b' })
  })

  it('realm diverso → stessa email in un altro tenant NON viene risolta', async () => {
    // L'utente esiste solo in tenant-a; il token arriva dal realm tenant-b.
    verifyKeycloakToken.mockResolvedValue(kcToken({ iss: 'http://localhost:8080/realms/tenant-b' }))
    executeRead.mockImplementation(async (work: (tx: { run: (q: string, p: { tenantId: string }) => unknown }) => unknown) =>
      work({ run: (_q, p) => ({ records: p.tenantId === 'tenant-a' ? [record({ id: 'u-1', role: 'admin' })] : [] }) }),
    )

    await rejectsWithCode(resolveAuth('tok', makeReq()), 'UNAUTHORIZED', /user not found/)
  })

  it('tenant/host mismatch → UNAUTHORIZED senza toccare il DB', async () => {
    verifyKeycloakToken.mockResolvedValue(kcToken())

    await rejectsWithCode(
      resolveAuth('tok', makeReq({ host: 'tenant-b.localhost' })),
      'UNAUTHORIZED', /tenant mismatch/,
    )
    expect(executeRead).not.toHaveBeenCalled()
  })

  it('il cross-check usa X-Forwarded-Host quando presente', async () => {
    verifyKeycloakToken.mockResolvedValue(kcToken())

    await rejectsWithCode(
      resolveAuth('tok', makeReq({ host: 'tenant-a.localhost', 'x-forwarded-host': 'tenant-b.localhost' })),
      'UNAUTHORIZED', /tenant mismatch/,
    )
  })

  it('host senza sottodominio (localhost / IP) → nessun cross-check', async () => {
    verifyKeycloakToken.mockResolvedValue(kcToken())
    dbReturns([record({ id: 'u-1', role: 'viewer' })])

    await expect(resolveAuth('tok', makeReq({ host: '127.0.0.1:4000' }))).resolves.toMatchObject({ tenantId: 'tenant-a' })
  })

  it('ruolo mancante sul nodo User → errore esplicito, nessun fallback a viewer', async () => {
    verifyKeycloakToken.mockResolvedValue(kcToken())
    dbReturns([record({ id: 'u-1', role: null })])

    await rejectsWithCode(resolveAuth('tok', makeReq()), 'INTERNAL_SERVER_ERROR', /has no valid role/)
  })

  it('ruolo sconosciuto → errore esplicito', async () => {
    verifyKeycloakToken.mockResolvedValue(kcToken())
    dbReturns([record({ id: 'u-1', role: 'superuser' })])

    await rejectsWithCode(resolveAuth('tok', makeReq()), 'INTERNAL_SERVER_ERROR', /superuser/)
  })

  it('issuer senza /realms/<slug> → rifiutato', async () => {
    verifyKeycloakToken.mockResolvedValue(kcToken({ iss: 'http://localhost:8080/' }))

    await rejectsWithCode(resolveAuth('tok', makeReq()), 'UNAUTHORIZED', /no Keycloak realm/)
    expect(executeRead).not.toHaveBeenCalled()
  })

  it('token senza claim email → rifiutato', async () => {
    verifyKeycloakToken.mockResolvedValue({ ...kcToken(), email: undefined })

    await rejectsWithCode(resolveAuth('tok', makeReq()), 'UNAUTHORIZED', /no email claim/)
  })

  it('più nodi User per (email, tenant) → errore, mai scelta arbitraria', async () => {
    verifyKeycloakToken.mockResolvedValue(kcToken())
    dbReturns([record({ id: 'u-1', role: 'admin' }), record({ id: 'u-2', role: 'viewer' })])

    await expect(resolveAuth('tok', makeReq())).rejects.toThrow(/Multiple User nodes/)
  })

  it('errore DB → propaga (non è un 401)', async () => {
    verifyKeycloakToken.mockResolvedValue(kcToken())
    executeRead.mockRejectedValue(new Error('neo4j down'))

    await expect(resolveAuth('tok', makeReq())).rejects.toThrow('neo4j down')
  })
})

describe('resolveAuth (legacy JWT)', () => {
  it('senza ALLOW_LEGACY_JWT un token non-Keycloak è rifiutato', async () => {
    verifyKeycloakToken.mockRejectedValue(new Error('not a keycloak token'))

    await rejectsWithCode(resolveAuth('tok', makeReq()), 'UNAUTHORIZED', /Invalid token/)
    expect(executeRead).not.toHaveBeenCalled()
  })

  it('con ALLOW_LEGACY_JWT=true accetta un JWT firmato con JWT_SECRET', async () => {
    process.env['ALLOW_LEGACY_JWT'] = 'true'
    resetConfigCache()
    verifyKeycloakToken.mockRejectedValue(new Error('not a keycloak token'))
    const jwt = (await import('jsonwebtoken')).default
    const token = jwt.sign({ tenant_id: 't', user_id: 'u', email: 'e@x', role: 'admin' }, 'test-secret')

    await expect(resolveAuth(token, makeReq())).resolves.toEqual({ tenantId: 't', userId: 'u', userEmail: 'e@x', role: 'admin' })
  })

  it('con ALLOW_LEGACY_JWT=true un JWT con firma errata è rifiutato', async () => {
    process.env['ALLOW_LEGACY_JWT'] = 'true'
    resetConfigCache()
    verifyKeycloakToken.mockRejectedValue(new Error('not a keycloak token'))
    const jwt = (await import('jsonwebtoken')).default
    const token = jwt.sign({ tenant_id: 't', user_id: 'u', email: 'e@x', role: 'admin' }, 'other-secret')

    await rejectsWithCode(resolveAuth(token, makeReq()), 'UNAUTHORIZED', /Invalid token/)
  })
})

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('extractRealmFromIssuer', () => {
  it.each([
    ['http://localhost:8080/realms/c-one', 'c-one'],
    ['https://auth.example.com/realms/acme/', 'acme'],
    ['https://host.tailnet.ts.net/realms/c-one', 'c-one'],
  ])('%s → %s', (iss, realm) => {
    expect(extractRealmFromIssuer(iss)).toBe(realm)
  })

  it.each(['http://localhost:8080', 'http://localhost:8080/realms/', 'http://localhost:8080/realms/a/protocol'])(
    'rifiuta %s', (iss) => {
      expect(() => extractRealmFromIssuer(iss)).toThrow(/no Keycloak realm/)
    },
  )
})

describe('extractTenantFromHost', () => {
  it.each([
    ['c-one.localhost',                 'c-one'],
    ['c-one.localhost:4000',            'c-one'],
    ['c-one.opengrafo.com',             'c-one'],
    ['portal.c-one.localhost',          'c-one'],
    ['portal.c-one.localhost:80',       'c-one'],
    ['10x-labs.example.com',            '10x-labs'],   // slug che inizia con "10" non è un IP
    ['192corp.example.com',             '192corp'],    // idem con "192"
    ['c-one.localhost, proxy.internal', 'c-one'],      // catena di proxy: primo valore
  ])('%s → %s', (host, tenant) => {
    expect(extractTenantFromHost(host)).toBe(tenant)
  })

  it.each([
    '', 'localhost', 'localhost:4000',
    '127.0.0.1', '127.0.0.1:4000', '192.168.1.10', '10.0.0.5:80', '172.16.0.1',
    '[::1]', '[::1]:4000', '[fe80::1%25en0]:4000', '[2001:db8::1]',
  ])('%s → null', (host) => {
    expect(extractTenantFromHost(host)).toBeNull()
  })
})
