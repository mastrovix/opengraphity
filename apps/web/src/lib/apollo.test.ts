/**
 * The web app's Apollo client: the link chain lives in web-core, here only
 * the wiring — endpoint, token source, and how failures reach the person.
 *
 * Why it matters: each callback below is a user-visible behaviour. A
 * suspended tenant treated as an expired session sends the app into a
 * refresh/login loop that ends in nginx's "414 Request-URI Too Large"
 * (17 Sep 2026); a network error without a toast leaves a silent page; an
 * error key the bundle does not know must fall back to the server message
 * instead of showing a raw key.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import i18n from '@/i18n/i18n'

const h = vi.hoisted(() => ({
  options: null as null | Record<string, unknown>,
  stop:    vi.fn(),
  toastError: vi.fn(),
  refresh: vi.fn(async () => true),
}))

vi.mock('@opengraphity/web-core', () => ({
  createApolloClient: (opts: Record<string, unknown>) => { h.options = opts; return { fake: true } },
  mostraSchermataDiStop: h.stop,
}))
vi.mock('sonner', () => ({ toast: { error: h.toastError } }))
vi.mock('./tokenRefresh', () => ({ refreshToken: h.refresh, isSessionInvalid: vi.fn(), forceLogin: vi.fn() }))
vi.mock('./clientLogger', () => ({ clientLogger: {} }))

type Opts = {
  uri: string
  getToken: () => string | undefined
  refreshToken: () => Promise<unknown>
  onTenantSuspended: () => void
  onNetworkError: () => void
  onGraphQLError: (m: string) => void
  traduciErrore: (key: string, params?: Record<string, unknown>) => string | null
}

async function load(): Promise<Opts> {
  const mod = await import('./apollo')
  expect(mod.apolloClient).toEqual({ fake: true })
  return h.options as unknown as Opts
}

beforeEach(() => {
  h.stop.mockReset()
  h.toastError.mockReset()
  document.body.innerHTML = ''
})

describe('apolloClient wiring', () => {
  it('talks to /graphql unless the build names another endpoint', async () => {
    const o = await load()
    expect(o.uri).toBe((import.meta.env['VITE_API_URL'] as string | undefined) ?? '/graphql')
  })

  it('reads the token from keycloak and forces a refresh (-1) when asked', async () => {
    const o = await load()
    const { keycloak } = await import('./keycloak')
    expect(o.getToken()).toBe(keycloak.token)
    await o.refreshToken()
    // -1 = refresh now, whatever the remaining validity: the server already said no.
    expect(h.refresh).toHaveBeenCalledWith(-1)
  })

  it('a suspended tenant stops the app with an explanation instead of looping to login', async () => {
    const o = await load()
    const root = document.createElement('div')
    root.id = 'root'
    document.body.appendChild(root)
    o.onTenantSuspended()
    expect(h.stop).toHaveBeenCalledWith({
      root,
      titolo: i18n.t('auth.tenantSuspended.title'),
      dettaglio: i18n.t('auth.tenantSuspended.detail'),
    })
  })

  it('without a #root there is nothing to replace, and it does not throw', async () => {
    const o = await load()
    expect(() => o.onTenantSuspended()).not.toThrow()
    expect(h.stop).not.toHaveBeenCalled()
  })

  it('network and GraphQL errors reach the person as a toast', async () => {
    const o = await load()
    o.onNetworkError()
    expect(h.toastError).toHaveBeenLastCalledWith(i18n.t('errors.network'))
    o.onGraphQLError('Ticket not found')
    expect(h.toastError).toHaveBeenLastCalledWith('Ticket not found')
  })

  it('translates a known error key, and returns null for an unknown one so the server message stays', async () => {
    const o = await load()
    expect(o.traduciErrore('errors.network')).toBe(i18n.t('errors.network'))
    expect(o.traduciErrore('errors.thisKeyDoesNotExist.anywhere')).toBeNull()
  })
})
