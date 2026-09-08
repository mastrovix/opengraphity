/**
 * Issuer trust + JWKS origin (auth/keycloak.ts):
 *  - `iss` must be a Keycloak realm URL on one of the configured origins
 *    (KEYCLOAK_PUBLIC_URL list + KEYCLOAK_URL); anything else is rejected
 *    BEFORE any JWKS client is created (no SSRF / forged-JWKS takeover);
 *  - the JWKS is always fetched from the INTERNAL origin (KEYCLOAK_URL) with the
 *    realm path taken from the token, never from the public issuer host;
 *  - one JWKS client per issuer (cache), RS256 only, issuer pinned in verify.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type jwt from 'jsonwebtoken'
import { resetConfigCache } from '../../lib/config.js'

// ── Mocks (lazy factories; the module under test is imported below) ─────────

const jwksClientFactory = vi.fn()
vi.mock('jwks-rsa', () => ({ default: (opts: unknown) => jwksClientFactory(opts) }))

const decode = vi.fn()
const verify = vi.fn()
vi.mock('jsonwebtoken', () => ({
  default: {
    decode: (token: string) => decode(token),
    verify: (...args: unknown[]) => verify(...args),
  },
}))

const logError = vi.fn()
vi.mock('../../lib/logger.js', () => ({
  authLogger: { error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// Origins are computed at import time from config → env first, then import.
vi.stubEnv('NODE_ENV', 'test')
vi.stubEnv('KEYCLOAK_URL', 'http://keycloak:8080')
vi.stubEnv('KEYCLOAK_PUBLIC_URL', 'http://localhost:8080, https://macbook.tailnet.ts.net')
resetConfigCache()

const { verifyKeycloakToken } = await import('../keycloak.js')

// ── Helpers ──────────────────────────────────────────────────────────────────

type GetKey = (header: jwt.JwtHeader, cb: jwt.SigningKeyCallback) => void
type VerifyCb = (err: Error | null, decoded?: unknown) => void
type VerifyOpts = { algorithms: string[]; issuer: string }

const PAYLOAD = { sub: 'u-1', email: 'alice@acme.io', preferred_username: 'alice', realm_access: { roles: ['operator'] } }

/** jwt.verify stub: resolves the key through getKey (like the real one) then answers with PAYLOAD. */
function verifySucceeds() {
  verify.mockImplementation((_token: string, getKey: GetKey, opts: VerifyOpts, cb: VerifyCb) => {
    getKey({ alg: 'RS256', kid: 'kid-1' }, (err, key) => {
      if (err) { cb(err); return }
      cb(null, { ...PAYLOAD, iss: opts.issuer, key })
    })
  })
}

const jwksUris = () => jwksClientFactory.mock.calls.map((c) => (c[0] as { jwksUri: string }).jwksUri)

beforeEach(() => {
  jwksClientFactory.mockReset()
  jwksClientFactory.mockImplementation(() => ({
    getSigningKey: (_kid: string, cb: (err: Error | null, key?: { getPublicKey: () => string }) => void) =>
      cb(null, { getPublicKey: () => 'PEM-PUBLIC-KEY' }),
  }))
  decode.mockReset()
  verify.mockReset()
  logError.mockClear()
  verifySucceeds()
})

// ── Issuer allowlist ─────────────────────────────────────────────────────────

describe('verifyKeycloakToken — issuer non fidato', () => {
  it('origin non in allowlist → rifiuto esplicito, NESSUN client JWKS creato, jwt.verify mai chiamato', async () => {
    decode.mockReturnValue({ iss: 'https://evil.example/realms/c-one' })

    await expect(verifyKeycloakToken('tok')).rejects.toThrow('Untrusted token issuer origin: https://evil.example')
    expect(jwksClientFactory).not.toHaveBeenCalled()
    expect(verify).not.toHaveBeenCalled()
  })

  it('stesso host ma porta diversa è un altro origin → rifiutato', async () => {
    decode.mockReturnValue({ iss: 'http://localhost:8081/realms/c-one' })
    await expect(verifyKeycloakToken('tok')).rejects.toThrow(/Untrusted token issuer origin: http:\/\/localhost:8081/)
    expect(jwksClientFactory).not.toHaveBeenCalled()
  })

  it('schema diverso (https vs http) è un altro origin → rifiutato', async () => {
    decode.mockReturnValue({ iss: 'https://localhost:8080/realms/c-one' })
    await expect(verifyKeycloakToken('tok')).rejects.toThrow(/Untrusted token issuer origin/)
    expect(jwksClientFactory).not.toHaveBeenCalled()
  })

  it('issuer senza /realms/ → rifiutato prima del controllo origin', async () => {
    decode.mockReturnValue({ iss: 'http://localhost:8080/' })
    await expect(verifyKeycloakToken('tok')).rejects.toThrow(/not a Keycloak realm URL/)
    expect(jwksClientFactory).not.toHaveBeenCalled()
  })

  it('issuer che non è un URL → rifiutato', async () => {
    decode.mockReturnValue({ iss: 'garbage/realms/c-one' })
    await expect(verifyKeycloakToken('tok')).rejects.toThrow(/not a valid URL/)
    expect(jwksClientFactory).not.toHaveBeenCalled()
  })

  it('token senza claim iss / non decodificabile → rifiutato', async () => {
    decode.mockReturnValue({})
    await expect(verifyKeycloakToken('tok')).rejects.toThrow('Token missing issuer claim')
    decode.mockReturnValue(null)
    await expect(verifyKeycloakToken('tok')).rejects.toThrow('Token missing issuer claim')
    expect(jwksClientFactory).not.toHaveBeenCalled()
  })
})

// ── JWKS origin ──────────────────────────────────────────────────────────────

describe('verifyKeycloakToken — JWKS dall\'origin interno', () => {
  it('iss pubblico http://localhost:8080 → JWKS da http://keycloak:8080 (path del realm conservato)', async () => {
    decode.mockReturnValue({ iss: 'http://localhost:8080/realms/c-one' })

    const result = await verifyKeycloakToken('tok')

    expect(jwksClientFactory).toHaveBeenCalledOnce()
    expect(jwksClientFactory).toHaveBeenCalledWith(expect.objectContaining({
      jwksUri: 'http://keycloak:8080/realms/c-one/protocol/openid-connect/certs',
      cache:   true,
    }))
    expect(jwksUris()[0]).not.toContain('localhost')
    expect(result.email).toBe('alice@acme.io')
  })

  it('iss pubblico Tailscale (https) → JWKS comunque da http://keycloak:8080, mai dall\'host pubblico', async () => {
    decode.mockReturnValue({ iss: 'https://macbook.tailnet.ts.net/realms/c-two' })

    await verifyKeycloakToken('tok')

    expect(jwksUris()).toEqual(['http://keycloak:8080/realms/c-two/protocol/openid-connect/certs'])
  })

  it('iss sull\'origin interno stesso (token server-to-server) è accettato', async () => {
    decode.mockReturnValue({ iss: 'http://keycloak:8080/realms/c-three' })
    await expect(verifyKeycloakToken('tok')).resolves.toMatchObject({ sub: 'u-1' })
    expect(jwksUris()).toEqual(['http://keycloak:8080/realms/c-three/protocol/openid-connect/certs'])
  })

  it('un client JWKS per issuer: due verifiche sullo stesso iss creano un solo client', async () => {
    decode.mockReturnValue({ iss: 'http://localhost:8080/realms/cache-realm' })
    await verifyKeycloakToken('tok-1')
    await verifyKeycloakToken('tok-2')
    expect(jwksUris().filter((u) => u.includes('/realms/cache-realm/'))).toHaveLength(1)
  })

  it('realm diversi → client JWKS distinti (cache per issuer, non globale)', async () => {
    decode.mockReturnValueOnce({ iss: 'http://localhost:8080/realms/alpha' })
    await verifyKeycloakToken('tok')
    decode.mockReturnValueOnce({ iss: 'http://localhost:8080/realms/beta' })
    await verifyKeycloakToken('tok')
    expect(jwksUris()).toEqual([
      'http://keycloak:8080/realms/alpha/protocol/openid-connect/certs',
      'http://keycloak:8080/realms/beta/protocol/openid-connect/certs',
    ])
  })
})

// ── Verify wiring ────────────────────────────────────────────────────────────

describe('verifyKeycloakToken — jwt.verify', () => {
  it('verifica con RS256 soltanto e con issuer pinnato a quello del token', async () => {
    decode.mockReturnValue({ iss: 'http://localhost:8080/realms/pin' })
    await verifyKeycloakToken('the-token')

    expect(verify).toHaveBeenCalledOnce()
    const [token, getKey, opts] = verify.mock.calls[0] as [string, GetKey, VerifyOpts, VerifyCb]
    expect(token).toBe('the-token')
    expect(typeof getKey).toBe('function')
    expect(opts).toEqual({ algorithms: ['RS256'], issuer: 'http://localhost:8080/realms/pin' })
  })

  it('getKey chiede la signing key per il kid dell\'header e passa la chiave pubblica', async () => {
    const getSigningKey = vi.fn((_kid: string, cb: (err: Error | null, key?: { getPublicKey: () => string }) => void) =>
      cb(null, { getPublicKey: () => 'PEM-FOR-KID' }))
    jwksClientFactory.mockImplementation(() => ({ getSigningKey }))
    decode.mockReturnValue({ iss: 'http://localhost:8080/realms/kid-realm' })

    const result = await verifyKeycloakToken('tok') as unknown as { key: string }

    expect(getSigningKey).toHaveBeenCalledWith('kid-1', expect.any(Function))
    expect(result.key).toBe('PEM-FOR-KID')
  })

  it('kid sconosciuto al JWKS → la verifica rigetta (errore propagato, loggato)', async () => {
    jwksClientFactory.mockImplementation(() => ({
      getSigningKey: (_kid: string, cb: (err: Error | null) => void) => cb(new Error('Unable to find a signing key that matches')),
    }))
    decode.mockReturnValue({ iss: 'http://localhost:8080/realms/nokid' })

    await expect(verifyKeycloakToken('tok')).rejects.toThrow(/Unable to find a signing key/)
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ err: expect.stringContaining('signing key') }), 'verify error')
  })

  it('firma non valida → rigetta', async () => {
    verify.mockImplementation((_t: string, _g: GetKey, _o: VerifyOpts, cb: VerifyCb) => cb(new Error('invalid signature')))
    decode.mockReturnValue({ iss: 'http://localhost:8080/realms/bad-sig' })
    await expect(verifyKeycloakToken('tok')).rejects.toThrow('invalid signature')
  })
})
