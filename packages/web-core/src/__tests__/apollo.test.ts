import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApolloClient, ApolloLink, InMemoryCache, from, gql } from '@apollo/client/core'
import { Observable } from '@apollo/client/utilities'
import { CombinedGraphQLErrors } from '@apollo/client/errors'
import { createErrorLink, createAuthLink, createDeduper, type ErrorLinkOptions } from '../apollo.js'
import type { ClientLogger } from '../logger.js'

const QUERY = gql`query Me { me { id } }`

type Step =
  | { kind: 'data' }
  | { kind: 'gqlError'; code?: string; message?: string }
  | { kind: 'networkError'; message?: string }

/** Terminating link driven by a script of responses; records the bearer sent on each attempt. */
function scriptedLink(steps: Step[]) {
  const seenAuth: string[] = []
  let i = 0
  const link = new ApolloLink((operation) =>
    new Observable<ApolloLink.Result>((observer) => {
      const headers = (operation.getContext() as { headers?: Record<string, string> }).headers ?? {}
      seenAuth.push(headers['authorization'] ?? '')
      const step = steps[Math.min(i++, steps.length - 1)]!
      switch (step.kind) {
        case 'data':
          observer.next({ data: { me: { __typename: 'User', id: 'u1' } } })
          observer.complete()
          break
        case 'gqlError':
          observer.next({ errors: [{ message: step.message ?? 'nope', extensions: step.code ? { code: step.code } : {} }] })
          observer.complete()
          break
        case 'networkError':
          observer.error(new Error(step.message ?? 'Failed to fetch'))
      }
    }),
  )
  return { link, seenAuth, calls: () => i }
}

function makeOptions(overrides: Partial<ErrorLinkOptions> = {}) {
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

function makeClient(opts: ErrorLinkOptions, terminating: ApolloLink, getToken: () => string | undefined) {
  return new ApolloClient({
    link:  from([createErrorLink(opts), createAuthLink(getToken).concat(terminating)]),
    cache: new InMemoryCache(),
    // identical concurrent queries must each reach the link (dedupe test)
    queryDeduplication: false,
  })
}

describe('errorLink — UNAUTHORIZED', () => {
  it('refreshes the token and replays the same operation with the new bearer, without notifying', async () => {
    let token = 'old'
    const { opts } = makeOptions({ refreshToken: vi.fn(async () => { token = 'new'; return true }) })
    const script = scriptedLink([{ kind: 'gqlError', code: 'UNAUTHORIZED' }, { kind: 'data' }])
    const client = makeClient(opts, script.link, () => token)

    const result = await client.query({ query: QUERY, fetchPolicy: 'no-cache' })

    expect(result.data).toEqual({ me: { __typename: 'User', id: 'u1' } })
    expect(opts.refreshToken).toHaveBeenCalledTimes(1)
    expect(script.calls()).toBe(2)
    expect(script.seenAuth).toEqual(['Bearer old', 'Bearer new'])
    expect(opts.onGraphQLError).not.toHaveBeenCalled()
    expect(opts.onNetworkError).not.toHaveBeenCalled()
    expect(opts.onSessionInvalid).not.toHaveBeenCalled()
  })

  it('fresh token still rejected → onSessionInvalid, no infinite replay (replayed result is inspected, not re-handled)', async () => {
    const { opts, logger } = makeOptions()
    const script = scriptedLink([{ kind: 'gqlError', code: 'UNAUTHORIZED' }])
    const client = makeClient(opts, script.link, () => 'tok')

    await expect(client.query({ query: QUERY, fetchPolicy: 'no-cache' })).rejects.toBeInstanceOf(CombinedGraphQLErrors)
    expect(opts.refreshToken).toHaveBeenCalledTimes(1)
    expect(script.calls()).toBe(2)
    expect(opts.onSessionInvalid).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith('UNAUTHORIZED dopo refresh del token', expect.objectContaining({ operation: 'Me' }))
    expect(opts.onGraphQLError).not.toHaveBeenCalled()
  })

  it('refresh fails because the session is invalid → onSessionInvalid, operation errors out', async () => {
    const { opts } = makeOptions({
      refreshToken:     vi.fn(async () => { throw new Error('Failed to refresh token') }),
      isSessionInvalid: vi.fn(() => true),
    })
    const script = scriptedLink([{ kind: 'gqlError', code: 'UNAUTHORIZED' }])
    const client = makeClient(opts, script.link, () => 'tok')

    await expect(client.query({ query: QUERY, fetchPolicy: 'no-cache' })).rejects.toThrow('Failed to refresh token')
    expect(opts.onSessionInvalid).toHaveBeenCalledTimes(1)
    expect(opts.onNetworkError).not.toHaveBeenCalled()
    expect(script.calls()).toBe(1)
  })

  it('refresh fails for a transport error (token still there) → onNetworkError, NO login redirect', async () => {
    const { opts } = makeOptions({
      refreshToken:     vi.fn(async () => { throw new Error('ECONNREFUSED') }),
      isSessionInvalid: vi.fn(() => false),
    })
    const script = scriptedLink([{ kind: 'gqlError', code: 'UNAUTHORIZED' }])
    const client = makeClient(opts, script.link, () => 'tok')

    await expect(client.query({ query: QUERY, fetchPolicy: 'no-cache' })).rejects.toThrow('ECONNREFUSED')
    expect(opts.onSessionInvalid).not.toHaveBeenCalled()
    expect(opts.onNetworkError).toHaveBeenCalledTimes(1)
    expect(opts.onNetworkError).toHaveBeenCalledWith(expect.any(Error), { operation: 'Me' })
  })

  it('matches on extensions.code only — an "Unauthorized: token/tenant mismatch" FORBIDDEN error is a normal error', async () => {
    const { opts } = makeOptions()
    const script = scriptedLink([{ kind: 'gqlError', code: 'FORBIDDEN', message: 'Unauthorized: token/tenant mismatch' }])
    const client = makeClient(opts, script.link, () => 'tok')

    await expect(client.query({ query: QUERY, fetchPolicy: 'no-cache' })).rejects.toBeInstanceOf(CombinedGraphQLErrors)
    expect(opts.refreshToken).not.toHaveBeenCalled()
    expect(opts.onSessionInvalid).not.toHaveBeenCalled()
    expect(opts.onGraphQLError).toHaveBeenCalledWith('Unauthorized: token/tenant mismatch', { code: 'FORBIDDEN', path: undefined, operation: 'Me' })
  })
})

describe('errorLink — other errors', () => {
  it('GraphQL error → logged + onGraphQLError with code/operation', async () => {
    const { opts, logger } = makeOptions()
    const script = scriptedLink([{ kind: 'gqlError', code: 'BAD_USER_INPUT', message: 'title required' }])
    const client = makeClient(opts, script.link, () => 'tok')

    await expect(client.query({ query: QUERY, fetchPolicy: 'no-cache' })).rejects.toBeInstanceOf(CombinedGraphQLErrors)
    expect(opts.onGraphQLError).toHaveBeenCalledTimes(1)
    expect(opts.onGraphQLError).toHaveBeenCalledWith('title required', expect.objectContaining({ code: 'BAD_USER_INPUT', operation: 'Me' }))
    expect(logger.error).toHaveBeenCalledWith('GraphQL error: title required', expect.objectContaining({ code: 'BAD_USER_INPUT' }))
  })

  it('network error → logged + onNetworkError', async () => {
    const { opts, logger } = makeOptions()
    const script = scriptedLink([{ kind: 'networkError', message: 'Failed to fetch' }])
    const client = makeClient(opts, script.link, () => 'tok')

    await expect(client.query({ query: QUERY, fetchPolicy: 'no-cache' })).rejects.toThrow('Failed to fetch')
    expect(opts.onNetworkError).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith('Network error: Failed to fetch', { operation: 'Me' })
  })

  it('dedupes notifications: N failing queries in the window → 1 callback (logging is never deduped)', async () => {
    const { opts, logger } = makeOptions()
    const script = scriptedLink([{ kind: 'networkError' }])
    const client = makeClient(opts, script.link, () => 'tok')

    await Promise.allSettled([1, 2, 3].map(() => client.query({ query: QUERY, fetchPolicy: 'no-cache' })))
    expect(opts.onNetworkError).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledTimes(3)
  })
})

describe('authLink', () => {
  it('sends the current bearer, empty when there is no token', async () => {
    let token: string | undefined = 'abc'
    const script = scriptedLink([{ kind: 'data' }])
    const client = makeClient(makeOptions().opts, script.link, () => token)
    await client.query({ query: QUERY, fetchPolicy: 'no-cache' })
    token = undefined
    await client.query({ query: QUERY, fetchPolicy: 'no-cache' })
    expect(script.seenAuth).toEqual(['Bearer abc', ''])
  })
})

describe('createDeduper', () => {
  beforeEach(() => { vi.useRealTimers() })
  it('collapses repeats inside the window and lets them through after it', () => {
    vi.useFakeTimers()
    const once = createDeduper(1_000)
    expect(once('a')).toBe(true)
    expect(once('a')).toBe(false)
    expect(once('b')).toBe(true)
    vi.advanceTimersByTime(1_000)
    expect(once('a')).toBe(true)
    vi.useRealTimers()
  })
})
