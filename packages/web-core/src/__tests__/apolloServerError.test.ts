/**
 * GRAPHQL ERRORS INSIDE A NON-2xx RESPONSE (D77, tour of 23 Sep 2026).
 *
 * `HttpLink` reads the body of a non-2xx response only when its media type is
 * `application/graphql-response+json`. With `application/json` — a proxy that
 * rewrites the header, or an older server — it raises a `ServerError` and
 * leaves the body unread. A 400 GRAPHQL_VALIDATION_FAILED arrived that way:
 * the error link treated it as a NETWORK error, deduped it under the single
 * network key and remembered it as "already shown", so the page calling
 * `showError` stayed silent. The user pressed Save and nothing happened.
 *
 * These tests use the REAL `HttpLink` with a fake `fetch`: they pin Apollo's
 * behaviour, not a guess about it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApolloClient, InMemoryCache, from, gql } from '@apollo/client/core'
import { HttpLink } from '@apollo/client/link/http'
import { ServerError } from '@apollo/client/errors'
import {
  createErrorLink, createAuthLink, createApolloClient, wasNotifiedCentrally,
  graphQLErrorsInServerError, errorHasKey, errorFieldName, type ErrorLinkOptions,
} from '../apollo.js'
import type { ClientLogger } from '../logger.js'

const MUTATION = gql`mutation Save { save { id } }`

function options(overrides: Partial<ErrorLinkOptions> = {}) {
  const logger: ClientLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
  const opts: ErrorLinkOptions = {
    refreshToken:     vi.fn(async () => true),
    isSessionInvalid: vi.fn(() => false),
    onSessionInvalid: vi.fn(),
    onNetworkError:   vi.fn(),
    onGraphQLError:   vi.fn(),
    clientLogger:     logger,
    ...overrides,
  }
  return { opts, logger }
}

type Answer = { status: number; body: string; type?: string }

/** A client on the real HttpLink, answering with the scripted responses in order (the last one repeats). */
function client(opts: ErrorLinkOptions, answers: Answer[]) {
  let i = 0
  const fetchFinto = vi.fn(async () => {
    const a = answers[Math.min(i++, answers.length - 1)]!
    return new Response(a.body, { status: a.status, headers: { 'content-type': a.type ?? 'application/json' } })
  })
  const c = new ApolloClient({
    link:  from([createErrorLink(opts), createAuthLink(() => 'tok').concat(new HttpLink({ uri: 'http://x/graphql', fetch: fetchFinto as unknown as typeof fetch }))]),
    cache: new InMemoryCache(),
  })
  return { c, fetchFinto }
}

const body = (...errors: Array<Record<string, unknown>>) => JSON.stringify({ errors })
const validation = body({ message: 'Cannot query field "nope" on type "Mutation".', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } })

async function failure(c: ApolloClient): Promise<unknown> {
  return c.mutate({ mutation: MUTATION }).then(() => { throw new Error('the mutation should have failed') }, (e: unknown) => e)
}

describe('a GraphQL error that arrives with a non-2xx status is a GraphQL error, not a network one', () => {
  it('400 GRAPHQL_VALIDATION_FAILED: onGraphQLError with the server message and code, no network notice', async () => {
    const { opts, logger } = options()
    const { c } = client(opts, [{ status: 400, body: validation }])
    const e = await failure(c)

    // Apollo still hands the page a ServerError: what changes is how the link reports it.
    expect(ServerError.is(e)).toBe(true)
    expect(opts.onGraphQLError).toHaveBeenCalledTimes(1)
    expect(opts.onGraphQLError).toHaveBeenCalledWith('Cannot query field "nope" on type "Mutation".',
      expect.objectContaining({ code: 'GRAPHQL_VALIDATION_FAILED', operation: 'Save' }))
    expect(opts.onNetworkError).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith('GraphQL error: Cannot query field "nope" on type "Mutation".', expect.objectContaining({ code: 'GRAPHQL_VALIDATION_FAILED' }))
  })

  it('the page that asks «already shown?» hears yes: the link showed it, one toast and not two', async () => {
    const { opts } = options()
    const { c } = client(opts, [{ status: 400, body: validation }])
    expect(wasNotifiedCentrally(await failure(c))).toBe(true)
  })

  it('is NOT swallowed by an earlier network error: the two dedupe keys are different', async () => {
    // The defect: a network error a moment earlier closed the single network
    // key, the validation error went into the same key, and nothing showed.
    const { opts } = options()
    const { c } = client(opts, [{ status: 502, body: '<html>Bad gateway</html>', type: 'text/html' }, { status: 400, body: validation }])
    await failure(c)
    expect(opts.onNetworkError).toHaveBeenCalledTimes(1)
    await failure(c)
    expect(opts.onGraphQLError).toHaveBeenCalledTimes(1)
  })

  it('every error in the body is reported', async () => {
    const { opts } = options()
    const { c } = client(opts, [{ status: 400, body: body({ message: 'first' }, { message: 'second' }) }])
    await failure(c)
    expect(opts.onGraphQLError).toHaveBeenCalledTimes(2)
    expect(opts.onGraphQLError).toHaveBeenNthCalledWith(1, 'first', expect.anything())
    expect(opts.onGraphQLError).toHaveBeenNthCalledWith(2, 'second', expect.anything())
  })

  it('the same message twice inside the window is one toast, like any GraphQL error', async () => {
    const { opts, logger } = options()
    const { c } = client(opts, [{ status: 400, body: validation }])
    await failure(c)
    await failure(c)
    expect(opts.onGraphQLError).toHaveBeenCalledTimes(1)
    // Logging is never deduped.
    expect(logger.error).toHaveBeenCalledTimes(2)
  })

  it('a key in extensions.i18n becomes the sentence, with its parameters', async () => {
    const traduciErrore = vi.fn((key: string, params?: Record<string, string | number>) =>
      key === 'errors.formField.required' ? `Il campo «${String(params?.['field'])}» è obbligatorio.` : null)
    const { opts } = options({ traduciErrore })
    const { c } = client(opts, [{ status: 400, body: body({ message: 'field required', extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.formField.required', params: { field: 'Costo' } } } }) }])
    await failure(c)
    expect(opts.onGraphQLError).toHaveBeenCalledWith('Il campo «Costo» è obbligatorio.', expect.objectContaining({ code: 'BAD_USER_INPUT' }))
  })

  it('a key the bundle does not know leaves the server message, as for every other error', async () => {
    const { opts } = options({ traduciErrore: () => null })
    const { c } = client(opts, [{ status: 400, body: body({ message: 'Server-side English', extensions: { i18n: { key: 'errors.fromTheFuture' } } }) }])
    await failure(c)
    expect(opts.onGraphQLError).toHaveBeenCalledWith('Server-side English', expect.anything())
  })

  it('UNAUTHORIZED inside the body refreshes the token and replays, whatever the status', async () => {
    const { opts } = options()
    const { c, fetchFinto } = client(opts, [
      { status: 500, body: body({ message: 'Unauthorized', extensions: { code: 'UNAUTHORIZED' } }) },
      { status: 200, body: JSON.stringify({ data: { save: { __typename: 'Thing', id: 't1' } } }) },
    ])
    const res = await c.mutate({ mutation: MUTATION })
    expect(res.data).toEqual({ save: { __typename: 'Thing', id: 't1' } })
    expect(opts.refreshToken).toHaveBeenCalledTimes(1)
    expect(fetchFinto).toHaveBeenCalledTimes(2)
    expect(opts.onGraphQLError).not.toHaveBeenCalled()
  })
})

describe('a non-2xx response WITHOUT GraphQL errors stays a network error', () => {
  it.each([
    ['an HTML page from a proxy', { status: 502, body: '<html>Bad gateway</html>', type: 'text/html' }],
    ['an empty body', { status: 503, body: '' }],
    ['JSON that is not a GraphQL response', { status: 500, body: JSON.stringify({ detail: 'boom' }) }],
    ['an empty error list', { status: 500, body: JSON.stringify({ errors: [] }) }],
    ['errors without a message', { status: 500, body: JSON.stringify({ errors: [{ code: 1 }] }) }],
  ])('%s → onNetworkError, not onGraphQLError', async (_label, answer) => {
    const { opts } = options()
    const { c } = client(opts, [answer])
    const e = await failure(c)
    expect(opts.onNetworkError).toHaveBeenCalledTimes(1)
    expect(opts.onGraphQLError).not.toHaveBeenCalled()
    expect(graphQLErrorsInServerError(e)).toBeNull()
  })
})

describe('createApolloClient passes the translator to the error link too', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('the sentence reaches onGraphQLError when the error arrives as a ServerError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      body({ message: 'duplicate', extensions: { i18n: { key: 'errors.duplicate' } } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )))
    const onGraphQLError = vi.fn()
    const c = createApolloClient({
      uri: 'http://x/graphql', getToken: () => 'tok',
      refreshToken: async () => true, isSessionInvalid: () => false, onSessionInvalid: vi.fn(),
      onNetworkError: vi.fn(), onGraphQLError,
      clientLogger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
      traduciErrore: (key) => (key === 'errors.duplicate' ? 'Esiste già' : null),
    })
    await failure(c)
    expect(onGraphQLError).toHaveBeenCalledWith('Esiste già', expect.anything())
  })
})

describe('graphQLErrorsInServerError, errorHasKey and errorFieldName read the body of a ServerError', () => {
  const serverError = (text: string) => new ServerError('Response not successful: Received status code 400', {
    response: new Response(text, { status: 400 }), bodyText: text,
  })

  it('returns the errors with their extensions', () => {
    const errors = graphQLErrorsInServerError(serverError(validation))
    expect(errors).toEqual([{ message: 'Cannot query field "nope" on type "Mutation".', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }])
  })

  it('anything that is not a ServerError is not read', () => {
    for (const v of [null, undefined, new Error('x'), { errors: [{ message: 'y' }] }, 'text']) {
      expect(graphQLErrorsInServerError(v)).toBeNull()
    }
  })

  it('a page that reacts to a KEY still finds it when the rejection arrived as a ServerError', () => {
    // CreateServiceRequestPage and the portal react to the catalog form's
    // «revision changed» key: behind a proxy that rewrites the media type,
    // the key must still be there.
    const e = serverError(body({ message: 'changed', extensions: { i18n: { key: 'errors.catalogForm.revisionChanged' } } }))
    expect(errorHasKey(e, 'errors.catalogForm.revisionChanged')).toBe(true)
    expect(errorHasKey(e, 'errors.other')).toBe(false)
  })

  it('the offending field name is read from the body too', () => {
    const e = serverError(body({ message: 'required', extensions: { i18n: { key: 'errors.formField.required', params: { name: 'costo' } } } }))
    expect(errorFieldName(e)).toBe('costo')
  })
})
