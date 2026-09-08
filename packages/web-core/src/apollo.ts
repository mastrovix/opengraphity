import { ApolloClient, InMemoryCache, HttpLink, from } from '@apollo/client/core'
import { setContext } from '@apollo/client/link/context'
import { ErrorLink } from '@apollo/client/link/error'
import { CombinedGraphQLErrors } from '@apollo/client/errors'
import { Observable } from '@apollo/client/utilities'
import type { ApolloLink } from '@apollo/client/link'
import type { ClientLogger } from './logger.js'
import { consoleLogger } from './logger.js'

export interface GraphQLErrorInfo {
  code?: string | undefined
  path?: readonly (string | number)[] | undefined
  operation?: string | undefined
}

export interface ErrorLinkOptions {
  /** Forced refresh (`refreshToken(-1)`): the API just rejected the token we have. */
  refreshToken: () => Promise<unknown>
  /** After a failed refresh: true when keycloak-js dropped the session (→ login), false on transport errors. */
  isSessionInvalid: () => boolean
  /** Session invalid or fresh token still rejected: redirect to login (`forceLogin`). */
  onSessionInvalid: () => void
  /** Transport failure (API or Keycloak unreachable). Already deduped: one call per `dedupeMs`. */
  onNetworkError: (error: Error, info: { operation?: string | undefined }) => void
  /** Any other GraphQL error. Deduped per message. */
  onGraphQLError: (message: string, info: GraphQLErrorInfo) => void
  clientLogger?: ClientLogger
  /** Window in which repeated identical notifications are collapsed (N failing queries → 1 toast). */
  dedupeMs?: number
}

export interface CreateApolloClientOptions extends ErrorLinkOptions {
  uri: string
  getToken: () => string | undefined
  defaultOptions?: ApolloClient.DefaultOptions
}

export const DEFAULT_DEDUPE_MS = 5_000

/** `once(key)` → true the first time within the window, false while it is still open. */
export function createDeduper(windowMs: number): (key: string) => boolean {
  const recent = new Map<string, number>()
  return (key) => {
    const now  = Date.now()
    const last = recent.get(key)
    if (last !== undefined && now - last < windowMs) return false
    recent.set(key, now)
    return true
  }
}

export const NETWORK_DEDUPE_KEY = 'network'

function hasUnauthorized(result: ApolloLink.Result): boolean {
  const errors = (result as { errors?: readonly { extensions?: Record<string, unknown> }[] }).errors
  return Array.isArray(errors) && errors.some((e) => e.extensions?.['code'] === 'UNAUTHORIZED')
}

/**
 * UNAUTHORIZED from the API: refresh the token (forced — the API just rejected
 * the one we have) and replay the SAME operation with the new bearer, without
 * any notification. The user only notices when the refresh itself fails:
 *   - session invalid → login redirect;
 *   - Keycloak unreachable → connection notification, the operation errors out
 *     and the page shows its QueryError/retry instead of a bogus "session expired".
 *
 * The replayed result is inspected HERE: Apollo's ErrorLink pipes a retried
 * observable straight to the caller and never runs the error handler on it
 * again, so a context flag ("authRetried") checked in the handler would never
 * fire. A fresh token that is still rejected means the account itself is not
 * accepted by the API → re-login is the only sane recovery.
 */
function retryAfterRefresh(
  o:         ErrorLinkOptions,
  once:      (key: string) => boolean,
  logger:    ClientLogger,
  operation: ApolloLink.Operation,
  forward:   ApolloLink.ForwardFunction,
): Observable<ApolloLink.Result> {
  return new Observable<ApolloLink.Result>((observer) => {
    let cancelled = false
    let sub: { unsubscribe(): void } | undefined
    o.refreshToken().then(
      () => {
        if (cancelled) return
        sub = forward(operation).subscribe({
          next: (result) => {
            if (hasUnauthorized(result)) {
              logger.error('UNAUTHORIZED dopo refresh del token', { operation: operation.operationName })
              o.onSessionInvalid()
            }
            observer.next(result)
          },
          error:    (err: unknown) => observer.error(err),
          complete: () => observer.complete(),
        })
      },
      (err: unknown) => {
        if (cancelled) return
        const error = err instanceof Error ? err : new Error(String(err))
        if (o.isSessionInvalid()) {
          o.onSessionInvalid()
        } else {
          logger.error('Token refresh fallito (rete)', { operation: operation.operationName, message: error.message })
          if (once(NETWORK_DEDUPE_KEY)) o.onNetworkError(error, { operation: operation.operationName })
        }
        observer.error(error)
      },
    )
    return () => { cancelled = true; sub?.unsubscribe() }
  })
}

export function createErrorLink(o: ErrorLinkOptions): ErrorLink {
  const logger = o.clientLogger ?? consoleLogger
  const once   = createDeduper(o.dedupeMs ?? DEFAULT_DEDUPE_MS)

  return new ErrorLink(({ error, operation, forward }) => {
    if (CombinedGraphQLErrors.is(error)) {
      const unauthorized = error.errors.some((e) => e.extensions?.['code'] === 'UNAUTHORIZED')
      if (unauthorized) {
        return retryAfterRefresh(o, once, logger, operation, forward)
      }
      error.errors.forEach(({ message, path, extensions }) => {
        const code = typeof extensions?.['code'] === 'string' ? extensions['code'] : undefined
        logger.error(`GraphQL error: ${message}`, {
          code,
          path:      path as unknown as Record<string, unknown> | undefined,
          operation: operation.operationName,
        })
        if (once(`gql:${message}`)) o.onGraphQLError(message, { code, path, operation: operation.operationName })
      })
      return
    }

    logger.error(`Network error: ${error.message}`, { operation: operation.operationName })
    if (once(NETWORK_DEDUPE_KEY)) o.onNetworkError(error, { operation: operation.operationName })
  })
}

/** Bearer from `getToken()` on every request — the token lives in memory only (keycloak-js), never in storage. */
export function createAuthLink(getToken: () => string | undefined): ApolloLink {
  return setContext((_, { headers }) => {
    const token = getToken()
    return {
      headers: {
        ...(headers as Record<string, string> | undefined),
        authorization: token ? `Bearer ${token}` : '',
      },
    }
  })
}

export function createApolloClient(opts: CreateApolloClientOptions): ApolloClient {
  const { uri, getToken, defaultOptions, ...linkOptions } = opts
  if (!uri) throw new Error('createApolloClient: "uri" mancante (VITE_API_URL)')
  const httpLink = new HttpLink({ uri })
  return new ApolloClient({
    link:  from([createErrorLink(linkOptions), createAuthLink(getToken).concat(httpLink)]),
    cache: new InMemoryCache(),
    ...(defaultOptions ? { defaultOptions } : {}),
  })
}
