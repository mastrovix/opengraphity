/**
 * The web app's binding of the shared token refresh (E-05, revisione totale
 * E-14). The logic lives in `@opengraphity/web-core` and is tested there;
 * what can break HERE is the wiring, and every break is visible to a user:
 *  - the three notices must come from i18n in the language ACTIVE when they
 *    fire (the package fallback is English-only: an Italian tenant read
 *    English sentences when the session expired);
 *  - the notices must reach sonner (a notifier that goes nowhere means the
 *    user is sent to the login page with no word of why);
 *  - the exported functions must be bound to the app's keycloak instance.
 *
 * The module keeps state (one login redirect per page life), so every test
 * imports a fresh copy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { toast } from 'sonner'
import i18n from '@/i18n/i18n'
import { TEST_TOKEN, type MockKeycloak } from '@/test/mocks/keycloak'

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
vi.mock('./clientLogger', () => ({ clientLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

/** The keycloak the module under test is bound to (re-created with every fresh import). */
let mockKeycloak: MockKeycloak

const fresh = async () => {
  vi.resetModules()
  const mod = await import('./tokenRefresh')
  mockKeycloak = (await import('./keycloak')).keycloak as unknown as MockKeycloak
  mockKeycloak.updateToken.mockResolvedValue(true)
  mockKeycloak.token = TEST_TOKEN
  return mod
}

beforeEach(() => {
  vi.mocked(toast.error).mockClear()
  vi.mocked(toast.success).mockClear()
})

afterEach(async () => {
  // The language is shared with every other test file in the worker.
  await i18n.changeLanguage('en')
})

describe('tokenRefresh (web binding)', () => {
  it('session expired: tells the user in their language, then redirects to login exactly once', async () => {
    const { forceLogin } = await fresh()
    forceLogin()
    forceLogin()   // N concurrent 401s must not stack N redirects and N notices
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith('Session expired — please sign in again', undefined)
    expect(mockKeycloak.login).toHaveBeenCalledTimes(1)
  })

  it('the message is resolved when it fires, not at import: a language switch after load is honoured', async () => {
    const { forceLogin } = await fresh()
    await i18n.changeLanguage('it')
    forceLogin()
    expect(toast.error).toHaveBeenCalledWith(i18n.t('errors.sessionExpired'), undefined)
    // Not the English package fallback.
    expect(vi.mocked(toast.error).mock.calls[0]![0]).not.toBe('Session expired — please sign in again')
  })

  it('isSessionInvalid reads the app keycloak: no token means the session is gone', async () => {
    const { isSessionInvalid } = await fresh()
    expect(isSessionInvalid()).toBe(false)
    mockKeycloak.token = undefined
    expect(isSessionInvalid()).toBe(true)
  })

  it('refreshToken goes through the app keycloak and shares one round-trip between callers', async () => {
    const { refreshToken } = await fresh()
    const [a, b] = await Promise.all([refreshToken(-1), refreshToken(-1)])
    expect(a).toBe(true)
    expect(b).toBe(true)
    // Two callers, one request to Keycloak.
    expect(mockKeycloak.updateToken).toHaveBeenCalledTimes(1)
  })

  it('auth server unreachable: an i18n notice with the retry delay, then a "restored" notice when it comes back', async () => {
    const { startTokenRefreshLoop } = await fresh()
    const stop = startTokenRefreshLoop()
    try {
      // Transport error: the token is still there, so this is NOT a logout.
      mockKeycloak.updateToken.mockRejectedValueOnce(new Error('network down'))
      mockKeycloak.onTokenExpired!()
      await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith(
        'Authentication server unreachable — retrying in 5s',
        expect.objectContaining({ id: 'keycloak-refresh' }),
      ))
      expect(mockKeycloak.login).not.toHaveBeenCalled()

      mockKeycloak.onTokenExpired!()
      await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith(
        'Connection to the authentication server restored',
        { id: 'keycloak-refresh' },   // same id: it replaces the "unreachable" toast
      ))
    } finally {
      stop()
    }
  })
})
