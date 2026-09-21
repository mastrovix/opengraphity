import { describe, it, expect, vi } from 'vitest'
import { verifyKeycloakToken } from '../keycloak.js'

vi.mock('jwks-rsa', () => ({
  default: () => ({
    getSigningKey: (_kid: string, cb: (err: Error | null, key?: { getPublicKey: () => string }) => void) =>
      cb(null, { getPublicKey: () => 'mock-key' }),
  }),
}))

vi.mock('jsonwebtoken', () => ({
  default: {
    // The source pre-decodes the (unverified) token to read the issuer
    decode: (token: string) => ({ iss: token === 'odd-realm' ? 'http://localhost:8080/realms/../admin' : 'http://localhost:8080/realms/c-one' }),
    verify: (
      token: string,
      _getKey: unknown,
      _options: unknown,
      cb: (err: Error | null, decoded?: unknown) => void,
    ) => {
      const base = { sub: 'user-123', email: 'test@demo.opengrafo.io', realm_access: { roles: ['operator'] }, preferred_username: 'test' }
      if (token === 'valid-token') {
        cb(null, { ...base, azp: 'opengrafo-web' })
      } else if (token === 'portal-token') {
        cb(null, { ...base, azp: 'opengrafo-portal' })
      } else if (token === 'other-client') {
        cb(null, { ...base, azp: 'account-console' })
      } else if (token === 'no-azp') {
        cb(null, base)
      } else {
        cb(new Error('Invalid token'))
      }
    },
  },
}))

describe('verifyKeycloakToken', () => {
  it('verifica token valido', async () => {
    const result = await verifyKeycloakToken('valid-token')
    expect(result.email).toBe('test@demo.opengrafo.io')
    expect(result.realm_access.roles).toContain('operator')
  })

  it('rigetta token invalido', async () => {
    await expect(verifyKeycloakToken('invalid-token')).rejects.toThrow('Invalid token')
  })

  it('accetta il token del portale', async () => {
    await expect(verifyKeycloakToken('portal-token')).resolves.toMatchObject({ azp: 'opengrafo-portal' })
  })

  it('revisione totale · A-7: un token dello stesso realm emesso per un altro client è rifiutato', async () => {
    await expect(verifyKeycloakToken('other-client')).rejects.toThrow(/not for an OpenGrafo app/)
    await expect(verifyKeycloakToken('no-azp')).rejects.toThrow(/not for an OpenGrafo app/)
  })

  it('revisione totale · A-14: un realm che non è uno slug non arriva al fetch delle chiavi', async () => {
    await expect(verifyKeycloakToken('odd-realm')).rejects.toThrow(/not an organization slug/)
  })
})
