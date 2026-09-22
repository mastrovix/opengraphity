/**
 * THE CONSOLE'S START-UP.
 *
 * Stricter than the web's and the portal's, on purpose: here nothing is
 * retried and nothing falls back. If Keycloak does not answer or the
 * configuration is missing, it writes why and stops — a console that opens
 * "somehow" on a wrong configuration is worse than one that does not open.
 *
 * The realm is FIXED and comes from the build configuration, not from the
 * hostname. That is the difference that matters against web and portal: there
 * the realm IS the tenant and is read from the host. If it were deduced here,
 * opening the console under another name would ask Keycloak for a token in
 * another realm.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const createKeycloak = vi.hoisted(() => vi.fn())
const createTokenRefresh = vi.hoisted(() => vi.fn())
const consoleLogger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }))

vi.mock('@opengraphity/web-core', () => ({ createKeycloak, createTokenRefresh, consoleLogger }))

/** Loads `keycloak.ts` fresh with the given build variables. */
async function caricaKeycloak(env: Record<string, string | undefined>) {
  vi.resetModules()
  createKeycloak.mockReturnValue({ initKeycloak: vi.fn(), getKeycloak: vi.fn(), keycloak: {} })
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string)
  return import('./keycloak')
}

const OK = { VITE_PLATFORM_REALM: 'opengrafo-platform', VITE_KEYCLOAK_URL: 'https://kc.example.com', VITE_KEYCLOAK_CLIENT_ID: 'og-console' }

beforeEach(() => { createKeycloak.mockReset(); createTokenRefresh.mockReset() })
afterEach(() => { vi.unstubAllEnvs() })

describe('the console realm', () => {
  it('comes from the build configuration, and the URL and client id go with it', async () => {
    await caricaKeycloak(OK)
    const opts = createKeycloak.mock.calls[0]![0] as { url: string; clientId: string; resolveRealm: () => string }
    expect(opts.url).toBe('https://kc.example.com')
    expect(opts.clientId).toBe('og-console')
    expect(opts.resolveRealm()).toBe('opengrafo-platform')
  })

  it('is NOT deduced from the hostname: that is the whole point', async () => {
    // Under web and portal the realm is the tenant and is read from the
    // host. Deducing it here would let another name ask for another realm.
    await caricaKeycloak(OK)
    const opts = createKeycloak.mock.calls[0]![0] as { resolveRealm: (host?: string) => string }
    expect(opts.resolveRealm('c-one.localhost')).toBe('opengrafo-platform')
  })

  it('is trimmed: a trailing space in a .env is not part of a realm name', async () => {
    await caricaKeycloak({ ...OK, VITE_PLATFORM_REALM: '  opengrafo-platform  ' })
    expect((createKeycloak.mock.calls[0]![0] as { resolveRealm: () => string }).resolveRealm()).toBe('opengrafo-platform')
  })

  it('missing or blank, it fails with a readable sentence naming the variable', async () => {
    // Without this the browser would land on a Keycloak error page for a
    // realm called "undefined".
    for (const realm of [undefined, '', '   ']) {
      const mod = await caricaKeycloak({ ...OK, VITE_PLATFORM_REALM: realm })
      void mod
      const opts = createKeycloak.mock.calls.at(-1)![0] as { resolveRealm: () => string }
      expect(() => opts.resolveRealm()).toThrow(/VITE_PLATFORM_REALM is not set/)
      expect(() => opts.resolveRealm()).toThrow(/which Keycloak realm its administrators live in/)
    }
  })

  it('the realm is resolved lazily, so importing the module never throws', async () => {
    // A throw at import time takes the whole bundle down before anything can
    // render the message.
    await expect(caricaKeycloak({ ...OK, VITE_PLATFORM_REALM: undefined })).resolves.toBeTruthy()
  })
})

describe('the token refresh', () => {
  async function caricaRefresh() {
    vi.resetModules()
    createKeycloak.mockReturnValue({ initKeycloak: vi.fn(), getKeycloak: vi.fn(), keycloak: { token: 'tok' } })
    createTokenRefresh.mockReturnValue({ refreshToken: vi.fn(), startTokenRefreshLoop: vi.fn() })
    for (const [k, v] of Object.entries(OK)) vi.stubEnv(k, v)
    return import('./tokenRefresh')
  }

  it('uses the shared implementation, with the console logger', async () => {
    // A hand-rolled `updateToken().catch(login)` every thirty seconds would
    // send somebody back to the login on the first network hiccup, in the
    // middle of creating a tenant.
    await caricaRefresh()
    const opts = createTokenRefresh.mock.calls[0]![0] as { logger: unknown; messages: Record<string, (s?: number) => string> }
    expect(opts.logger).toBe(consoleLogger)
    expect(opts.messages['sessionExpired']()).toBe('Session expired — signing in again')
    expect(opts.messages['authServerRestored']()).toBe('Connection to Keycloak restored')
    expect(opts.messages['authServerUnreachable'](8)).toBe('Keycloak unreachable — retrying in 8s')
  })

  it('the warnings go nowhere until the page asks for them, and then to the page', async () => {
    const mod = await caricaRefresh()
    const notify = (createTokenRefresh.mock.calls[0]![0] as { notify: { error: (m: string) => void; success: (m: string) => void } }).notify
    // Before the page mounts: no listener, and no crash either.
    expect(() => { notify.error('Keycloak unreachable') }).not.toThrow()

    const errore = vi.fn()
    const ripresa = vi.fn()
    mod.collegaAvvisi(errore, ripresa)
    notify.error('Keycloak unreachable — retrying in 8s')
    notify.success('Connection to Keycloak restored')
    expect(errore).toHaveBeenCalledWith('Keycloak unreachable — retrying in 8s')
    expect(ripresa).toHaveBeenCalledWith('Connection to Keycloak restored')
  })
})
