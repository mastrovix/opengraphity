/**
 * STARTING KEYCLOAK, AND FAILING READABLY WHEN IT CANNOT START.
 *
 * Everything here happens BEFORE the app exists: there is no tenant, so no
 * language, and no translations loaded. That is why the messages are English
 * with no i18n — a customer with Keycloak down used to read "Impossibile
 * connettersi a Keycloak (…)" whatever language they had chosen (H-34).
 *
 * And the validation happens inside `initKeycloak()`, not at module load, so
 * the app's `.catch()` can render the message instead of a blank page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const kcInit = vi.hoisted(() => vi.fn(async () => true))
const built = vi.hoisted(() => [] as Array<{ url: string; realm: string; clientId: string }>)
vi.mock('keycloak-js', () => ({
  default: class {
    init = kcInit
    token = 'tok'
    constructor(cfg: { url: string; realm: string; clientId: string }) { built.push(cfg) }
  },
}))

const { createKeycloak } = await import('../keycloak.js')

const OK = { url: 'https://kc.example.com', clientId: 'og-web', resolveRealm: () => 'c-one' }

beforeEach(() => {
  built.length = 0
  kcInit.mockReset()
  kcInit.mockResolvedValue(true)
  window.history.replaceState({}, '', '/incidents')
})
afterEach(() => { window.history.replaceState({}, '', '/') })

describe('initKeycloak', () => {
  it('builds the client with the url, the tenant realm and the client id, and returns authenticated', async () => {
    expect(await createKeycloak(OK).initKeycloak()).toBe(true)
    expect(built[0]).toEqual({ url: 'https://kc.example.com', realm: 'c-one', clientId: 'og-web' })
  })

  it('asks for login, PKCE S256, and no login iframe', async () => {
    // The token is kept in memory only; the iframe is off because it breaks
    // behind the proxies customers put in front of the product.
    await createKeycloak(OK).initKeycloak()
    expect(kcInit.mock.calls[0]![0]).toMatchObject({
      onLoad: 'login-required', checkLoginIframe: false, pkceMethod: 'S256',
    })
  })

  it('the redirect URI is the CLEANED page address, not window.location.href', async () => {
    // `redirectUri: window.location.href` produced an eight-thousand
    // character URL and a 414 from nginx: each login appended its own answer
    // to an address that already carried the previous one.
    window.history.replaceState({}, '', '/incidents#state=A&code=A')
    await createKeycloak(OK).initKeycloak()
    const { redirectUri } = kcInit.mock.calls[0]![0] as { redirectUri: string }
    expect(redirectUri).not.toContain('state=')
    expect(redirectUri).toContain('/incidents')
  })

  it('a missing url or client id is named, with the variable to set', async () => {
    // These are build-time variables: saying which one is missing is the
    // difference between a two-minute fix and an afternoon.
    await expect(createKeycloak({ ...OK, url: undefined }).initKeycloak())
      .rejects.toThrow('VITE_KEYCLOAK_URL is not configured — set it in the build environment (.env.local)')
    await expect(createKeycloak({ ...OK, clientId: undefined }).initKeycloak())
      .rejects.toThrow('VITE_KEYCLOAK_CLIENT_ID is not configured')
    await expect(createKeycloak({ ...OK, url: '' }).initKeycloak()).rejects.toThrow(/VITE_KEYCLOAK_URL/)
  })

  it('an app with its own variable names gets those names in the message', async () => {
    // The console app reads different variables; reporting the web's would
    // send whoever reads it to edit the wrong file.
    await expect(createKeycloak({ ...OK, url: undefined, envNames: { url: 'VITE_CONSOLE_KC_URL', clientId: 'VITE_CONSOLE_KC_CLIENT' } }).initKeycloak())
      .rejects.toThrow('VITE_CONSOLE_KC_URL is not configured')
  })

  it('a tenant that cannot be resolved surfaces its own error, before anything is built', async () => {
    const boom = new Error('No tenant in the hostname')
    await expect(createKeycloak({ ...OK, resolveRealm: () => { throw boom } }).initKeycloak()).rejects.toThrow(boom)
    expect(built).toHaveLength(0)
  })

  it('Keycloak not answering becomes a message naming the url and the realm, keeping the cause', async () => {
    kcInit.mockRejectedValueOnce(new Error('Failed to fetch'))
    const err = await createKeycloak(OK).initKeycloak().then(() => null, (e: Error) => e)
    expect(err?.message).toContain('Cannot reach Keycloak (https://kc.example.com) for realm "c-one": Failed to fetch')
    expect(err?.message).toContain('Check that the realm exists')
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error)
  })

  it('an OIDC refusal is read from its own shape, not stringified as [object Object]', async () => {
    // keycloak-js rejects with `{ error, error_description }`: String() on
    // that is what the customer used to see.
    kcInit.mockRejectedValueOnce({ error: 'invalid_request', error_description: 'realm does not exist' })
    await expect(createKeycloak(OK).initKeycloak()).rejects.toThrow('invalid_request: realm does not exist')

    kcInit.mockRejectedValueOnce({ error: 'access_denied' })
    await expect(createKeycloak(OK).initKeycloak()).rejects.toThrow('access_denied')
  })

  it('a rejection with nothing readable in it is still stringified rather than lost', async () => {
    kcInit.mockRejectedValueOnce({ unexpected: true })
    await expect(createKeycloak(OK).initKeycloak()).rejects.toThrow(/\[object Object\]/)
    kcInit.mockRejectedValueOnce('plain string')
    await expect(createKeycloak(OK).initKeycloak()).rejects.toThrow('plain string')
  })

  it('returns whatever Keycloak says about being authenticated', async () => {
    kcInit.mockResolvedValueOnce(false)
    expect(await createKeycloak(OK).initKeycloak()).toBe(false)
  })
})

describe('getKeycloak and the proxy', () => {
  it('using the instance before init fails loudly, saying what to call', async () => {
    const h = createKeycloak(OK)
    expect(() => h.getKeycloak()).toThrow('Keycloak is not initialized — call initKeycloak() first')
    expect(() => h.keycloak.token).toThrow('Keycloak is not initialized')
  })

  it('after init the proxy reads through to the instance', async () => {
    const h = createKeycloak(OK)
    await h.initKeycloak()
    expect(h.keycloak.token).toBe('tok')
    expect(h.getKeycloak()).toBeTruthy()
  })

  it('a method read through the proxy stays bound to the instance', async () => {
    // Unbound, `kc.updateToken()` would run with `this` as the proxy and
    // silently fail to refresh.
    const h = createKeycloak(OK)
    await h.initKeycloak()
    const init = h.keycloak.init as unknown as () => unknown
    expect(typeof init).toBe('function')
    expect(() => init()).not.toThrow()
  })

  it('writing through the proxy writes onto the instance', async () => {
    const h = createKeycloak(OK)
    await h.initKeycloak()
    h.keycloak.token = 'nuovo'
    expect(h.getKeycloak().token).toBe('nuovo')
  })

  it('a failed init leaves the handle unusable rather than half-built', async () => {
    kcInit.mockRejectedValueOnce(new Error('down'))
    const h = createKeycloak(OK)
    await expect(h.initKeycloak()).rejects.toThrow()
    expect(() => h.getKeycloak()).toThrow('Keycloak is not initialized')
  })
})
