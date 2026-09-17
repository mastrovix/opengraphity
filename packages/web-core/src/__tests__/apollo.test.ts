import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ApolloClient, ApolloLink, InMemoryCache, from, gql } from '@apollo/client/core'
import { Observable } from '@apollo/client/utilities'
import { CombinedGraphQLErrors } from '@apollo/client/errors'
import { createErrorLink, createAuthLink, createDeduper, errorFieldName, type ErrorLinkOptions } from '../apollo.js'
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
    expect(logger.error).toHaveBeenCalledWith('UNAUTHORIZED after token refresh', expect.objectContaining({ operation: 'Me' }))
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

/**
 * IL CODICE HTTP DI «NON AUTORIZZATO», con il web davanti.
 *
 * `respondAuthError` in apps/api/src/server.ts rispondeva **500** a un errore
 * di autenticazione, e il suo commento lo diceva: «il 500 su non autorizzato è
 * un difetto suo, da correggere a parte e con il web davanti». Il pezzo che
 * mancava per correggerlo era questa prova: la catena di link riconosce
 * UNAUTHORIZED dal CORPO GraphQL, non dallo stato HTTP, e `HttpLink` tratta
 * 401 e 500 nello stesso modo quando il corpo è un errore GraphQL valido —
 * entrambi diventano `CombinedGraphQLErrors`, quindi il rinfresco del token e
 * il replay continuano a funzionare identici.
 *
 * Questo test usa `HttpLink` VERO con `fetch` finto: è l'unico modo di pinnare
 * il comportamento di Apollo invece di ragionarci sopra.
 */
describe('lo stato HTTP di un errore di autenticazione (401 o 500) non cambia la catena', () => {
  const corpoNonAutorizzato = JSON.stringify({
    errors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHORIZED' } }],
  })

  async function chiedi(status: number, tipo = 'application/graphql-response+json') {
    const { HttpLink } = await import('@apollo/client/link/http')
    let chiamate = 0
    const fetchFinto = vi.fn(async () => {
      chiamate += 1
      // Primo tentativo: non autorizzato con lo stato in prova. Secondo: dati.
      return chiamate === 1
        ? new Response(corpoNonAutorizzato, { status, headers: { 'content-type': tipo } })
        : new Response(JSON.stringify({ data: { me: { __typename: 'User', id: 'u1' } } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const { opts } = makeOptions()
    const client = new ApolloClient({
      link:  from([createErrorLink(opts), createAuthLink(() => 'tok').concat(new HttpLink({ uri: 'http://x/graphql', fetch: fetchFinto as unknown as typeof fetch }))]),
      cache: new InMemoryCache(),
    })
    const res = await client.query({ query: QUERY, fetchPolicy: 'no-cache' })
    return { res, tentativi: chiamate, opts }
  }

  it('401: il token si rinfresca e l\'operazione si ripete, come col 500', async () => {
    const { res, tentativi, opts } = await chiedi(401)
    expect(opts.refreshToken).toHaveBeenCalled()
    expect(tentativi).toBe(2)
    expect(res.data).toEqual({ me: { __typename: 'User', id: 'u1' } })
    // Nessun avviso all'utente: il rinfresco è silenzioso.
    expect(opts.onGraphQLError).not.toHaveBeenCalled()
    expect(opts.onNetworkError).not.toHaveBeenCalled()
  })

  it('500: identico — è il comportamento che c\'era, e resta il riferimento', async () => {
    const { res, tentativi, opts } = await chiedi(500)
    expect(opts.refreshToken).toHaveBeenCalled()
    expect(tentativi).toBe(2)
    expect(res.data).toEqual({ me: { __typename: 'User', id: 'u1' } })
  })

  /**
   * Il caso che il prodotto aveva davvero, e che nessun test copriva: media
   * type `application/json`. `HttpLink` non guarda il corpo e solleva
   * `ServerError`; senza `isUnauthorizedServerError` la catena lo trattava
   * come errore di rete, mostrava «Errore di connessione al server» e non
   * rinfrescava niente.
   */
  it('401 con media type application/json: si rinfresca comunque, non è un errore di rete', async () => {
    const { res, tentativi, opts } = await chiedi(401, 'application/json')
    expect(opts.refreshToken).toHaveBeenCalled()
    expect(tentativi).toBe(2)
    expect(res.data).toEqual({ me: { __typename: 'User', id: 'u1' } })
    expect(opts.onNetworkError).not.toHaveBeenCalled()
  })

  it('un 401 che NON è un UNAUTHORIZED GraphQL resta un errore, non un ciclo di rinfreschi', async () => {
    const { HttpLink } = await import('@apollo/client/link/http')
    const fetchFinto = vi.fn(async () => new Response('<html>nginx</html>', { status: 401, headers: { 'content-type': 'text/html' } }))
    const { opts } = makeOptions()
    const client = new ApolloClient({
      link:  from([createErrorLink(opts), createAuthLink(() => 'tok').concat(new HttpLink({ uri: 'http://x/graphql', fetch: fetchFinto as unknown as typeof fetch }))]),
      cache: new InMemoryCache(),
    })
    await expect(client.query({ query: QUERY, fetchPolicy: 'no-cache' })).rejects.toThrow()
    expect(opts.refreshToken).not.toHaveBeenCalled()
    expect(opts.onNetworkError).toHaveBeenCalled()
  })
})

/**
 * IL CAMPO CHE UN RIFIUTO ACCUSA (revisione del 17 set 2026).
 *
 * I rifiuti dei moduli portano nei `params` l'etichetta (`field`, che entra
 * nella frase) e il nome interno (`name`, che serve a trovare la casella). Il
 * secondo è nato perché il messaggio arrivava solo come avviso all'angolo:
 * spariva dopo pochi secondi e nessun campo veniva marcato.
 */
describe('errorFieldName', () => {
  const conParams = (params: Record<string, unknown>) =>
    ({ errors: [{ extensions: { i18n: { key: 'errors.formField.required', params } } }] })

  it('legge il nome interno del campo', () => {
    expect(errorFieldName(conParams({ field: 'Costo stimato (EUR)', name: 'costo_stimato' }))).toBe('costo_stimato')
  })

  it('un rifiuto che non riguarda un campo non ne inventa uno', () => {
    expect(errorFieldName(conParams({ item: 'Nuovo portatile', filled: '5', current: '6' }))).toBeNull()
    expect(errorFieldName(null)).toBeNull()
    expect(errorFieldName({ message: 'boom' })).toBeNull()
  })

  it('l\'etichetta da sola non basta: senza `name` non si accende nessun campo', () => {
    expect(errorFieldName(conParams({ field: 'Costo stimato (EUR)' }))).toBeNull()
  })

  it('con più errori prende il primo che nomina un campo', () => {
    const errore = { errors: [
      { extensions: { i18n: { key: 'errors.x', params: { a: 1 } } } },
      { extensions: { i18n: { key: 'errors.formField.required', params: { name: 'preventivo' } } } },
    ] }
    expect(errorFieldName(errore)).toBe('preventivo')
  })
})

/**
 * IL TENANT SOSPESO: si ferma, non gira (17 set 2026).
 *
 * Sospendendo `c-one` dalla console di piattaforma, l'app di quel tenant è
 * finita in un ciclo: 401 → rinfresca → 401 → «account non accettato» →
 * login → Keycloak dice sì → app → 401. Ogni giro passava da Keycloak e
 * allungava l'URL, finché nginx ha risposto **414**.
 *
 * Quello che si pinna qui è soprattutto ciò che NON deve accadere: nessun
 * rinfresco, nessun ritorno al login. Il codice `TENANT_SUSPENDED` è
 * definitivo per costruzione — non c'è niente da riprovare.
 */
describe('errorLink — TENANT_SUSPENDED', () => {
  it('non rinfresca il token e non torna al login: chiama il ramo del tenant sospeso', async () => {
    const onTenantSuspended = vi.fn()
    const { opts } = makeOptions({ onTenantSuspended })
    const script = scriptedLink([{ kind: 'gqlError', code: 'TENANT_SUSPENDED', message: 'Unauthorized: tenant suspended' }])
    const client = makeClient(opts, script.link, () => 'tok')

    await expect(client.query({ query: QUERY, fetchPolicy: 'no-cache' })).rejects.toThrow()

    expect(onTenantSuspended).toHaveBeenCalledTimes(1)
    expect(opts.refreshToken).not.toHaveBeenCalled()
    expect(opts.onSessionInvalid).not.toHaveBeenCalled()
    // Una sola richiesta: nessun replay, quindi nessun giro.
    expect(script.calls()).toBe(1)
  })

  it('non lo mostra come un errore qualunque: la frase la dà la pagina', async () => {
    const onTenantSuspended = vi.fn()
    const { opts } = makeOptions({ onTenantSuspended })
    const script = scriptedLink([{ kind: 'gqlError', code: 'TENANT_SUSPENDED' }])
    const client = makeClient(opts, script.link, () => 'tok')
    await expect(client.query({ query: QUERY, fetchPolicy: 'no-cache' })).rejects.toThrow()
    expect(opts.onGraphQLError).not.toHaveBeenCalled()
  })

  it('anche quando arriva come `ServerError` (media type non GraphQL)', async () => {
    // La forma che il prodotto produce davvero dietro un proxy che riscrive il
    // Content-Type: mancarla rimetterebbe il ciclo esattamente com'era.
    const { HttpLink } = await import('@apollo/client/link/http')
    const corpo = JSON.stringify({ errors: [{ message: 'Unauthorized: tenant suspended', extensions: { code: 'TENANT_SUSPENDED' } }] })
    const fetchFinto = vi.fn(async () => new Response(corpo, { status: 401, headers: { 'content-type': 'application/json' } }))
    const onTenantSuspended = vi.fn()
    const { opts } = makeOptions({ onTenantSuspended })
    const client = new ApolloClient({
      link:  from([createErrorLink(opts), createAuthLink(() => 'tok').concat(new HttpLink({ uri: 'http://x/graphql', fetch: fetchFinto as unknown as typeof fetch }))]),
      cache: new InMemoryCache(),
    })
    await expect(client.query({ query: QUERY, fetchPolicy: 'no-cache' })).rejects.toThrow()
    expect(onTenantSuspended).toHaveBeenCalled()
    expect(opts.refreshToken).not.toHaveBeenCalled()
    expect(fetchFinto).toHaveBeenCalledTimes(1)
  })

  it('sospeso DOPO un rinfresco riuscito: non diventa un ritorno al login', async () => {
    // Il caso di chi era già dentro quando la sospensione è arrivata: il primo
    // rifiuto è un UNAUTHORIZED vero, il secondo dice che il tenant è chiuso.
    const onTenantSuspended = vi.fn()
    const { opts } = makeOptions({ onTenantSuspended })
    const script = scriptedLink([
      { kind: 'gqlError', code: 'UNAUTHORIZED' },
      { kind: 'gqlError', code: 'TENANT_SUSPENDED' },
    ])
    const client = makeClient(opts, script.link, () => 'tok')
    await expect(client.query({ query: QUERY, fetchPolicy: 'no-cache' })).rejects.toThrow()
    expect(opts.refreshToken).toHaveBeenCalled()
    expect(onTenantSuspended).toHaveBeenCalled()
    expect(opts.onSessionInvalid).not.toHaveBeenCalled()
  })

  it('senza il ramo collegato il rifiuto non si perde: resta un errore, non un ciclo', async () => {
    const { opts } = makeOptions()   // nessun onTenantSuspended
    const script = scriptedLink([{ kind: 'gqlError', code: 'TENANT_SUSPENDED' }])
    const client = makeClient(opts, script.link, () => 'tok')
    await expect(client.query({ query: QUERY, fetchPolicy: 'no-cache' })).rejects.toThrow()
    expect(opts.refreshToken).not.toHaveBeenCalled()
    expect(opts.onSessionInvalid).not.toHaveBeenCalled()
  })
})
