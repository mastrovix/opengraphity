/**
 * THE APP'S KEYCLOAK: its tenant, its environment, its sign-in.
 *
 * `lib/keycloak` only wires the app's environment into the shared
 * `createKeycloak` (web-core, which has its own tests): the realm is the
 * tenant of the address — or `VITE_TENANT_SLUG` where the address has none —
 * and the server and client come from `VITE_KEYCLOAK_URL` and
 * `VITE_KEYCLOAK_CLIENT_ID`. What must hold: without a tenant the app says
 * how to open it instead of guessing one; sign-in runs with PKCE and a login
 * page when needed; and the instance cannot be used before sign-in.
 * Every other test replaces this module (see test/setup.ts); this one needs
 * the real one, with a recording `keycloak-js`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.unmock('@/lib/keycloak')

const created = vi.hoisted(() => [] as Array<{ config: unknown; init: (o: unknown) => Promise<boolean> }>)
vi.mock('keycloak-js', async () => {
  const { vi: v } = await import('vitest')
  class RecordingKeycloak {
    token = 'kc-token'
    init = v.fn(async () => true)
    constructor(config: unknown) { created.push({ config, init: this.init }) }
  }
  return { default: RecordingKeycloak }
})

/** A fresh copy of the module, read with the environment of the moment. */
const load = async () => { vi.resetModules(); return import('./keycloak') }

afterEach(() => {
  vi.unstubAllEnvs()
  created.length = 0
})

describe('getTenantSlug', () => {
  it('on an address without a tenant (localhost) the configured tenant is used', async () => {
    const { getTenantSlug } = await load()
    expect(window.location.hostname).toBe('localhost')
    expect(getTenantSlug()).toBe('test-tenant')
  })

  it('with no tenant anywhere it says how to open the app, instead of guessing one', async () => {
    vi.stubEnv('VITE_TENANT_SLUG', '')
    const { getTenantSlug } = await load()
    expect(() => getTenantSlug()).toThrow('No tenant in the subdomain ("localhost"). Open the app as: c-one.localhost:5173 — or set VITE_TENANT_SLUG.')
  })
})

describe('initKeycloak', () => {
  it('signs in to the tenant\'s realm on the configured server, with PKCE and a login page when needed', async () => {
    const { initKeycloak } = await load()
    await expect(initKeycloak()).resolves.toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0]!.config).toEqual({ url: 'http://keycloak.test', realm: 'test-tenant', clientId: 'opengrafo-web' })
    expect(created[0]!.init).toHaveBeenCalledWith(expect.objectContaining({ onLoad: 'login-required', pkceMethod: 'S256', checkLoginIframe: false }))
  })

  it('without the Keycloak address in the build it says which variable is missing', async () => {
    vi.stubEnv('VITE_KEYCLOAK_URL', '')
    const { initKeycloak } = await load()
    await expect(initKeycloak()).rejects.toThrow('VITE_KEYCLOAK_URL is not configured')
    expect(created).toHaveLength(0)
  })

  it('without the client id in the build it says which variable is missing', async () => {
    vi.stubEnv('VITE_KEYCLOAK_CLIENT_ID', '')
    const { initKeycloak } = await load()
    await expect(initKeycloak()).rejects.toThrow('VITE_KEYCLOAK_CLIENT_ID is not configured')
  })
})

describe('the instance', () => {
  it('cannot be used before sign-in, and is the signed-in one afterwards', async () => {
    const { initKeycloak, getKeycloak, keycloak } = await load()
    expect(() => keycloak.token).toThrow('Keycloak is not initialized — call initKeycloak() first')
    expect(() => getKeycloak()).toThrow('Keycloak is not initialized')
    await initKeycloak()
    expect(keycloak.token).toBe('kc-token')
    expect(getKeycloak().token).toBe('kc-token')
  })
})
