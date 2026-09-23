/**
 * AT START-UP: WHICH LANGUAGE THIS PERSON READS.
 *
 * The order is the whole point: the PERSON's own choice (kept on their user,
 * so the portal sees it too), then the ORGANIZATION's default, then the
 * product's first language — never the browser's. And a choice made before
 * it was kept on the person, when it lived only in this browser, is carried
 * over to the person once, and only once.
 *
 * What must not regress: nothing is decided while the person is still
 * loading (the organization's default would flash in and then be replaced);
 * the organization's default must not override a person's choice; a browser
 * choice must not be pushed to the server at every start; and a browser that
 * blocks storage must not break any of it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import i18n from '@/i18n/i18n'
import { apolloFinto } from '@/test/apolloFinto'
import { useTenantLanguage } from './useTenantLanguage'

// The shared fake answers at once: a query named in `held` stays in flight.
const held = vi.hoisted(() => new Set<string>())
vi.mock('@apollo/client/react', async () => {
  const { nomeOperazione, moduloApollo } = await import('@/test/apolloFinto')
  const m = moduloApollo()
  type Doc = Parameters<typeof m.useQuery>[0]
  type Opts = Parameters<typeof m.useQuery>[1]
  return {
    ...m,
    useQuery: (doc: Doc, opts?: Opts) => {
      const r = m.useQuery(doc, opts)
      return held.has(nomeOperazione(doc)) ? { ...r, data: undefined, loading: true } : r
    },
  }
})

const CHOSEN = 'og.language.chosen'
const SYNCED = 'og.language.synced'

const me = (language: string | null) => ({ me: {
  id: 'u1', name: 'Anna', email: 'anna@acme.com', role: 'operator', roleName: null, permissions: [],
  slackId: null, emailNotifications: true, language, teams: [],
} })
const organization = (defaultLanguage: string | null) =>
  ({ tenantLanguageSettings: { available: ['en', 'it'], defaultLanguage, fallback: 'en' } })

beforeEach(async () => {
  apolloFinto.reset()
  held.clear()
  window.localStorage.removeItem(CHOSEN)
  window.localStorage.removeItem(SYNCED)
  await i18n.changeLanguage('en')
  apolloFinto.risposte['GetTenantLanguageSettings'] = organization('it')
  apolloFinto.risposte['GetMe'] = me(null)
})

afterEach(async () => {
  vi.restoreAllMocks()
  window.localStorage.removeItem(CHOSEN)
  window.localStorage.removeItem(SYNCED)
  await i18n.changeLanguage('en')
})

describe('useTenantLanguage', () => {
  it('asks the organization\'s languages once, from the cache when it has them', () => {
    renderHook(() => useTenantLanguage())
    expect(apolloFinto.chiamate['GetTenantLanguageSettings']).toHaveLength(1)
  })

  it('decides nothing while the person is still loading', async () => {
    held.add('GetMe')
    renderHook(() => useTenantLanguage())
    await Promise.resolve()
    expect(i18n.language).toBe('en')
    expect(apolloFinto.chiamata('SetMyLanguage')).toBeUndefined()
  })

  it('nobody chose: the organization\'s default applies', async () => {
    renderHook(() => useTenantLanguage())
    await waitFor(() => expect(i18n.language).toBe('it'))
    expect(window.localStorage.getItem(CHOSEN)).toBeNull()
  })

  it('the person\'s own choice wins over the organization\'s, and is remembered as theirs', async () => {
    apolloFinto.risposte['GetTenantLanguageSettings'] = organization('en')
    apolloFinto.risposte['GetMe'] = me('it')
    renderHook(() => useTenantLanguage())
    await waitFor(() => expect(i18n.language).toBe('it'))
    expect(window.localStorage.getItem(CHOSEN)).toBe('true')
    expect(window.localStorage.getItem(SYNCED)).toBe('true')
    expect(apolloFinto.chiamata('SetMyLanguage')).toBeUndefined()
  })

  it('an organization with no default leaves the language as it is (the diagnostics say to configure it)', async () => {
    apolloFinto.risposte['GetTenantLanguageSettings'] = organization(null)
    await i18n.changeLanguage('it')
    renderHook(() => useTenantLanguage())
    await Promise.resolve()
    expect(i18n.language).toBe('it')
  })

  it('a choice that lived only in this browser is carried over to the person, once', async () => {
    window.localStorage.setItem(CHOSEN, 'true')
    await i18n.changeLanguage('it')
    renderHook(() => useTenantLanguage())
    await waitFor(() => expect(apolloFinto.chiamata('SetMyLanguage')).toEqual({ language: 'it' }))
    expect(window.localStorage.getItem(SYNCED)).toBe('true')
    // Carried over, not replaced by the organization's language.
    expect(i18n.language).toBe('it')

    // The next start does not send it again.
    apolloFinto.chiamate['SetMyLanguage'] = []
    renderHook(() => useTenantLanguage())
    await Promise.resolve()
    expect(apolloFinto.chiamate['SetMyLanguage']).toEqual([])
  })

  it('a choice already carried over and then removed elsewhere is forgotten here, and the organization\'s applies', async () => {
    window.localStorage.setItem(CHOSEN, 'true')
    window.localStorage.setItem(SYNCED, 'true')
    await i18n.changeLanguage('en')
    renderHook(() => useTenantLanguage())
    await waitFor(() => expect(i18n.language).toBe('it'))
    expect(window.localStorage.getItem(CHOSEN)).toBeNull()
    expect(apolloFinto.chiamata('SetMyLanguage')).toBeUndefined()
  })

  it('with storage refusing the writes, the person\'s choice still applies', async () => {
    // The product's own keys are refused (i18next finds out about a blocked storage at start-up by itself).
    const realSet = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.startsWith('og.language.')) throw new Error('storage disabled')
      return realSet.call(this, key, value)
    })
    apolloFinto.risposte['GetMe'] = me('it')
    renderHook(() => useTenantLanguage())
    await waitFor(() => expect(i18n.language).toBe('it'))
  })

  it('when it cannot read whether the choice was carried over, it does not send it again', async () => {
    const realGet = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === SYNCED) throw new Error('storage disabled')
      return realGet.call(this, key)
    })
    window.localStorage.setItem(CHOSEN, 'true')
    renderHook(() => useTenantLanguage())
    await waitFor(() => expect(i18n.language).toBe('it'))
    expect(apolloFinto.chiamata('SetMyLanguage')).toBeUndefined()
  })
})
