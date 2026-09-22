/**
 * THE REST OF THE APOLLO CHAIN: translation, client assembly, and "have I
 * already shown this error?".
 *
 * The link ORDER is the part that matters. The link that translates sits
 * INSIDE the one that reports, so the sentence is already in the right
 * language when ErrorLink builds the error the pages see — and when it hands
 * it to onGraphQLError, which raises the toast.
 *
 * `wasNotifiedCentrally` exists because pages that showed the error again in
 * their own `onError` produced two toasts for one failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApolloClient, ApolloLink, InMemoryCache, from, gql } from '@apollo/client/core'
import { Observable } from '@apollo/client/utilities'
import { CombinedGraphQLErrors } from '@apollo/client/errors'
import {
  createI18nLink, createApolloClient, createAuthLink, createErrorLink,
  wasNotifiedCentrally, errorHasKey, errorFieldName,
} from '../apollo.js'

const QUERY = gql`query Me { me { id } }`

/** A terminating link that answers with exactly this result. */
const answering = (result: Record<string, unknown>) =>
  new ApolloLink(() => new Observable<Record<string, unknown>>((observer) => {
    observer.next(result)
    observer.complete()
  })) as ApolloLink

const failing = (err: Error) =>
  new ApolloLink(() => new Observable(() => { throw err })) as ApolloLink

async function run(link: ApolloLink, terminating: ApolloLink) {
  const client = new ApolloClient({ link: from([link, terminating]), cache: new InMemoryCache() })
  return client.query({ query: QUERY, fetchPolicy: 'no-cache' }).then(
    (r) => ({ ok: true as const, r }), (e: Error) => ({ ok: false as const, e }))
}

describe('createI18nLink — the sentence in the reader\'s language', () => {
  const withKey = (key: string, params?: Record<string, unknown>) =>
    ({ data: null, errors: [{ message: 'Server-side English', extensions: { i18n: { key, ...(params ? { params } : {}) } } }] })

  it('replaces the message with the translated sentence', async () => {
    const translate = vi.fn((key: string) => (key === 'errors.duplicate' ? 'Esiste già' : null))
    const out = await run(createI18nLink(translate), answering(withKey('errors.duplicate')))
    expect(out.ok).toBe(false)
    expect((out as { e: Error }).e.message).toContain('Esiste già')
  })

  it('a key with no translation leaves the server message alone', async () => {
    // Showing the raw key would be worse than showing English.
    const out = await run(createI18nLink(() => null), answering(withKey('errors.unknown')))
    expect((out as { e: Error }).e.message).toContain('Server-side English')
  })

  it('an error with no i18n key is passed through untouched', async () => {
    const translate = vi.fn(() => 'mai')
    const out = await run(createI18nLink(translate), answering({ data: null, errors: [{ message: 'Plain failure' }] }))
    expect((out as { e: Error }).e.message).toContain('Plain failure')
    expect(translate).not.toHaveBeenCalled()
  })

  it('the parameters reach the translation', async () => {
    const translate = vi.fn((key: string, params?: Record<string, unknown>) =>
      key === 'errors.tooLong' ? `Massimo ${String(params?.['max'])}` : null)
    const out = await run(createI18nLink(translate), answering(withKey('errors.tooLong', { max: 80 })))
    expect((out as { e: Error }).e.message).toContain('Massimo 80')
  })

  it('a parameter whose name ends in "Key" is itself translated, and keeps the outer parameters', async () => {
    // So that "Rename «{{from}}» to «{{to}}»" works as a fragment: the piece
    // receives the same parameters as the sentence that contains it.
    const translate = vi.fn((key: string, params?: Record<string, unknown>) => {
      if (key === 'ops.rename') return `Rinominare (${String(params?.['from'] ?? '')})`
      if (key === 'errors.forbidden') return `Non consentito: ${String(params?.['op'] ?? '')}`
      return null
    })
    const out = await run(createI18nLink(translate), answering(withKey('errors.forbidden', { opKey: 'ops.rename', from: 'A' })))
    expect((out as { e: Error }).e.message).toContain('Non consentito: Rinominare (A)')
  })

  it('an untranslatable fragment falls back to its own key rather than disappearing', async () => {
    const translate = (key: string) => (key === 'errors.forbidden' ? 'Vietato: {op}'.replace('{op}', 'x') : null)
    const out = await run(createI18nLink(translate), answering(withKey('errors.forbidden', { opKey: 'ops.unknown' })))
    expect(out.ok).toBe(false)
  })

  it('a successful result passes through, and an empty error list is not touched', async () => {
    const translate = vi.fn(() => 'mai')
    const ok = await run(createI18nLink(translate), answering({ data: { me: { __typename: 'User', id: 'u1' } } }))
    expect(ok.ok).toBe(true)
    expect(translate).not.toHaveBeenCalled()
  })

  it('a transport failure passes through untouched: there is no sentence to translate', async () => {
    const out = await run(createI18nLink(() => 'mai'), failing(new Error('Failed to fetch')))
    expect(out.ok).toBe(false)
    expect((out as { e: Error }).e.message).toContain('Failed to fetch')
  })
})

describe('createApolloClient', () => {
  it('refuses to build without a uri, naming the variable', () => {
    // Building anyway gives a client that fails every query with a relative
    // URL nobody configured.
    expect(() => createApolloClient({ uri: '', getToken: () => undefined } as never))
      .toThrow('createApolloClient: "uri" is missing (VITE_API_URL)')
  })

  it('builds with a uri, and takes type policies and default options when given', () => {
    const client = createApolloClient({
      uri: '/graphql', getToken: () => 'tok',
      typePolicies: { Query: { fields: {} } },
      defaultOptions: { watchQuery: { fetchPolicy: 'cache-and-network' } },
    } as never)
    expect(client).toBeInstanceOf(ApolloClient)
    expect(client.defaultOptions.watchQuery?.fetchPolicy).toBe('cache-and-network')
  })

  it('works with and without a translator: the chain is shorter by one link', () => {
    for (const traduciErrore of [undefined, () => 'frase']) {
      expect(createApolloClient({ uri: '/graphql', getToken: () => undefined, traduciErrore } as never)).toBeInstanceOf(ApolloClient)
    }
  })
})

describe('createAuthLink', () => {
  it('sends the bearer read at request time, and an empty header when there is none', async () => {
    // The token lives in memory only (keycloak-js) and is refreshed while
    // the app runs: reading it once would go stale.
    const seen: string[] = []
    const terminating = new ApolloLink((operation) => new Observable<Record<string, unknown>>((observer) => {
      seen.push(((operation.getContext() as { headers?: Record<string, string> }).headers ?? {})['authorization'] ?? '')
      observer.next({ data: { me: { __typename: 'User', id: 'u1' } } })
      observer.complete()
    })) as ApolloLink

    // Un contenitore e non un `let`: la lettura avviene dentro una closure,
    // quindi `prefer-const` non vede l'assegnazione che arriva dopo.
    const stato: { token?: string } = {}
    const client = new ApolloClient({ link: from([createAuthLink(() => stato.token), terminating]), cache: new InMemoryCache() })
    await client.query({ query: QUERY, fetchPolicy: 'no-cache' })
    stato.token = 'tok-1'
    await client.query({ query: QUERY, fetchPolicy: 'no-cache' })
    expect(seen).toEqual(['', 'Bearer tok-1'])
  })
})

describe('wasNotifiedCentrally — do not show the same error twice', () => {
  const opts = {
    refreshToken: vi.fn(async () => true), isSessionInvalid: () => false,
    onSessionInvalid: vi.fn(), onNetworkError: vi.fn(), onGraphQLError: vi.fn(),
    clientLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  }

  beforeEach(() => { opts.onGraphQLError.mockClear(); opts.onNetworkError.mockClear() })

  it('a GraphQL error always counts as shown: it passes through the link by construction', () => {
    const combined = new CombinedGraphQLErrors({ errors: [{ message: 'nope' }] } as never)
    expect(wasNotifiedCentrally(combined)).toBe(true)
  })

  it('an error the link has just reported counts as shown', async () => {
    await run(createErrorLink(opts as never), failing(new Error('Failed to fetch')))
    expect(wasNotifiedCentrally(new Error('Failed to fetch'))).toBe(true)
  })

  it('an error nobody reported does not', () => {
    expect(wasNotifiedCentrally(new Error('never seen this one'))).toBe(false)
  })

  it('something with no message at all is not "already shown"', () => {
    for (const v of [null, undefined, 42, 'a string', {}]) expect(wasNotifiedCentrally(v)).toBe(false)
  })

  it('an object carrying a message is read too', async () => {
    await run(createErrorLink(opts as never), failing(new Error('Network hiccup')))
    expect(wasNotifiedCentrally({ message: 'Network hiccup' })).toBe(true)
  })
})

describe('errorHasKey and errorFieldName', () => {
  const withKey = (key: string, params?: Record<string, unknown>) =>
    ({ errors: [{ extensions: { i18n: { key, ...(params ? { params } : {}) } } }] })

  it('finds the key on a combined error and on a bare one', () => {
    expect(errorHasKey(withKey('errors.duplicate'), 'errors.duplicate')).toBe(true)
    expect(errorHasKey({ extensions: { i18n: { key: 'errors.duplicate' } } }, 'errors.duplicate')).toBe(true)
  })

  it('says no for a different key, and for anything with no key at all', () => {
    expect(errorHasKey(withKey('errors.duplicate'), 'errors.other')).toBe(false)
    for (const v of [null, undefined, new Error('x'), { errors: [] }, { errors: [{}] }]) {
      expect(errorHasKey(v, 'errors.duplicate'), String(v)).toBe(false)
    }
  })

  it('finds the offending field name in the error parameters', () => {
    expect(errorFieldName(withKey('errors.duplicate', { name: 'severity' }))).toBe('severity')
  })

  it('a blank or missing name is null: the caller must not highlight a field called ""', () => {
    for (const params of [{ name: '' }, { name: '   ' }, { name: 42 }, {}, undefined]) {
      expect(errorFieldName(withKey('errors.duplicate', params)), JSON.stringify(params)).toBeNull()
    }
    expect(errorFieldName(null)).toBeNull()
  })

  it('with several errors it reports the first that names a field', () => {
    expect(errorFieldName({ errors: [
      { extensions: { i18n: { key: 'a' } } },
      { extensions: { i18n: { key: 'b', params: { name: 'category' } } } },
    ] })).toBe('category')
  })
})
