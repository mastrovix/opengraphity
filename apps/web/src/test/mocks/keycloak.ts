/**
 * Keycloak finto condiviso da `setup.ts` (vi.mock di `keycloak-js` e di
 * `@/lib/keycloak`) e dai test che vogliono asserire sulle chiamate
 * (`logout`, `accountManagement`, `updateToken`…).
 *
 * Nessuna rete: `init` risolve subito come autenticato, `updateToken` risolve
 * `true`, il token è una stringa fissa.
 */
import { vi } from 'vitest'

export const TEST_TOKEN = 'test-token'

export function createMockKeycloak() {
  return {
    token:          TEST_TOKEN as string | undefined,
    authenticated:  true,
    realm:          'test-tenant',
    tokenParsed:    { sub: 'user-1', preferred_username: 'tester', realm_access: { roles: ['admin'] } },
    init:           vi.fn(async () => true),
    updateToken:    vi.fn(async () => true),
    login:          vi.fn(async () => {}),
    logout:         vi.fn(async () => {}),
    accountManagement: vi.fn(async () => {}),
    clearToken:     vi.fn(),
    onTokenExpired: undefined as (() => void) | undefined,
  }
}

export type MockKeycloak = ReturnType<typeof createMockKeycloak>

/** Istanza unica usata da `@/lib/keycloak` mockato. */
export const mockKeycloak: MockKeycloak = createMockKeycloak()

/** Sostituto della classe `keycloak-js`: ogni `new Keycloak()` ritorna un'istanza finta. */
export class FakeKeycloak {
  constructor(_config?: unknown) {
    return createMockKeycloak() as unknown as FakeKeycloak
  }
}
