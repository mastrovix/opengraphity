/**
 * Keycloak finto condiviso da `setup.ts` (vi.mock di `keycloak-js` e di
 * `@/lib/keycloak`) e dai test che asseriscono sulle chiamate
 * (`logout`, `accountManagement`, `updateToken`…). Nessuna rete.
 */
import { vi } from 'vitest'

export const TEST_TOKEN = 'test-token'

export function createMockKeycloak() {
  return {
    token:          TEST_TOKEN as string | undefined,
    authenticated:  true,
    realm:          'test-tenant',
    tokenParsed:    { sub: 'user-1', preferred_username: 'tester' },
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

export const mockKeycloak: MockKeycloak = createMockKeycloak()

export class FakeKeycloak {
  constructor(_config?: unknown) {
    return createMockKeycloak() as unknown as FakeKeycloak
  }
}
