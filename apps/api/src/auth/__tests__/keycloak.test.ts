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
    verify: (
      token: string,
      _getKey: unknown,
      _options: unknown,
      cb: (err: Error | null, decoded?: unknown) => void,
    ) => {
      if (token === 'valid-token') {
        cb(null, {
          sub: 'user-123',
          email: 'test@demo.opengrafo.io',
          realm_access: { roles: ['operator'] },
          preferred_username: 'test',
        })
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
})
