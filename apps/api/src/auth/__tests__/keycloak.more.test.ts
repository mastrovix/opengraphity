/**
 * The JWKS client cache is BOUNDED (revisione totale · A-14).
 *
 * Its key is the `iss` of a token that has not been verified yet: anyone can
 * send tokens with a fresh realm slug on an allowed origin, and each one used
 * to add a JWKS client (with its own key cache and HTTP agent) to a map that
 * never shrank — a slow memory leak an unauthenticated caller could drive.
 * The contract pinned here: past JWKS_CLIENT_CACHE_MAX issuers the OLDEST
 * client is evicted (and rebuilt if its issuer comes back), while issuers
 * still in the cache keep reusing their client instead of refetching keys.
 */
import { describe, it, expect, vi } from 'vitest'
import { resetConfigCache } from '../../lib/config.js'

const created: string[] = []
vi.mock('jwks-rsa', () => ({
  default: (opts: { jwksUri: string }) => {
    created.push(opts.jwksUri)
    return {
      getSigningKey: (_kid: string, cb: (err: Error | null, key?: { getPublicKey: () => string }) => void) =>
        cb(null, { getPublicKey: () => 'public-key' }),
    }
  },
}))

type GetKey = (header: { kid: string }, cb: (err: Error | null, key?: string) => void) => void
vi.mock('jsonwebtoken', () => ({
  default: {
    // The token IS the issuer here: every call names the realm it comes from.
    decode: (token: string) => ({ iss: token }),
    verify: (token: string, getKey: GetKey, _opts: unknown, cb: (err: Error | null, decoded?: unknown) => void) => {
      getKey({ kid: 'k1' }, (err, key) => {
        if (err || key !== 'public-key') { cb(err ?? new Error('no key')); return }
        cb(null, { sub: 's', email: 'a@b.c', preferred_username: 'a', realm_access: { roles: [] }, iss: token, azp: 'opengrafo-web' })
      })
    },
  },
}))
vi.mock('../../lib/logger.js', () => ({ authLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

vi.stubEnv('NODE_ENV', 'test')
vi.stubEnv('KEYCLOAK_URL', 'http://keycloak:8080')
vi.stubEnv('KEYCLOAK_PUBLIC_URL', 'http://localhost:8080')
vi.stubEnv('KEYCLOAK_APP_CLIENT_IDS', 'opengrafo-web')
resetConfigCache()

const { verifyKeycloakToken, JWKS_CLIENT_CACHE_MAX } = await import('../keycloak.js')

const iss = (i: number) => `http://localhost:8080/realms/tenant-${i}`

describe('JWKS client cache bound', () => {
  it('evicts the oldest issuer past the limit, keeps the others, and fetches keys on the internal origin', async () => {
    await verifyKeycloakToken(iss(0))
    // The key fetch stays on the internal Docker origin, with the realm path of the token.
    expect(created[0]).toBe('http://keycloak:8080/realms/tenant-0/protocol/openid-connect/certs')

    for (let i = 1; i < JWKS_CLIENT_CACHE_MAX; i++) await verifyKeycloakToken(iss(i))
    expect(created).toHaveLength(JWKS_CLIENT_CACHE_MAX)

    // A known issuer reuses its client: no new JWKS client.
    await verifyKeycloakToken(iss(0))
    expect(created).toHaveLength(JWKS_CLIENT_CACHE_MAX)

    // One more issuer: the cache is full, the oldest (tenant-0) makes room.
    await verifyKeycloakToken(iss(JWKS_CLIENT_CACHE_MAX))
    expect(created).toHaveLength(JWKS_CLIENT_CACHE_MAX + 1)

    // tenant-1 survived the eviction…
    await verifyKeycloakToken(iss(1))
    expect(created).toHaveLength(JWKS_CLIENT_CACHE_MAX + 1)
    // …tenant-0 did not: its client is rebuilt, and the token is still accepted.
    await expect(verifyKeycloakToken(iss(0))).resolves.toMatchObject({ iss: iss(0), azp: 'opengrafo-web' })
    expect(created).toHaveLength(JWKS_CLIENT_CACHE_MAX + 2)
    expect(created.at(-1)).toBe('http://keycloak:8080/realms/tenant-0/protocol/openid-connect/certs')
  })

  it('a token with no issuer claim is refused before any JWKS client is created', async () => {
    const before = created.length
    await expect(verifyKeycloakToken('')).rejects.toThrow('Token missing issuer claim')
    expect(created).toHaveLength(before)
  })
})
