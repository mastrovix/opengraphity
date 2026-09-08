import { ApolloClient, InMemoryCache, createHttpLink, from } from '@apollo/client/core'
import { setContext } from '@apollo/client/link/context'
import { ErrorLink } from '@apollo/client/link/error'
import { CombinedGraphQLErrors } from '@apollo/client/errors'
import { Observable } from '@apollo/client/utilities'
import type { ApolloLink } from '@apollo/client/link'
import { toast } from 'sonner'
import { keycloak } from './keycloak'
import { clientLogger } from './clientLogger'
import { refreshToken, isSessionInvalid, forceLogin } from './tokenRefresh'

const httpLink = createHttpLink({
  uri: import.meta.env['VITE_API_URL'] ?? '/graphql',
})

// Toast dedupe: a page firing N queries that all fail must not stack N toasts.
const recentToasts = new Map<string, number>()
const TOAST_DEDUPE_MS = 5_000

function toastOnce(key: string, message: string): void {
  const now  = Date.now()
  const last = recentToasts.get(key)
  if (last !== undefined && now - last < TOAST_DEDUPE_MS) return
  recentToasts.set(key, now)
  toast.error(message)
}

const NETWORK_ERROR_MSG = 'Errore di connessione al server'

/**
 * UNAUTHORIZED from the API: refresh the token (forced — the API just rejected
 * the one we have) and replay the SAME operation with the new bearer, without
 * any toast. The user only notices when the refresh itself fails:
 *   - session invalid → login redirect;
 *   - Keycloak unreachable → connection toast, the operation errors out and the
 *     page shows its QueryError/retry instead of a bogus "session expired".
 */
function retryAfterRefresh(
  operation: ApolloLink.Operation,
  forward:   ApolloLink.ForwardFunction,
): Observable<ApolloLink.Result> {
  return new Observable<ApolloLink.Result>((observer) => {
    let cancelled = false
    let sub: { unsubscribe(): void } | undefined
    refreshToken(-1).then(
      () => {
        if (cancelled) return
        operation.setContext({ authRetried: true })
        sub = forward(operation).subscribe(observer)
      },
      (err: unknown) => {
        if (cancelled) return
        if (isSessionInvalid()) {
          forceLogin()
        } else {
          clientLogger.error('Token refresh fallito (rete)', { operation: operation.operationName, message: err instanceof Error ? err.message : String(err) })
          toastOnce('network', NETWORK_ERROR_MSG)
        }
        observer.error(err instanceof Error ? err : new Error(String(err)))
      },
    )
    return () => { cancelled = true; sub?.unsubscribe() }
  })
}

const errorLink = new ErrorLink(({ error, operation, forward }) => {
  if (CombinedGraphQLErrors.is(error)) {
    const unauthorized = error.errors.some((e) => e.extensions?.['code'] === 'UNAUTHORIZED')
    if (unauthorized) {
      const ctx = operation.getContext() as { authRetried?: boolean }
      if (ctx.authRetried) {
        // Fresh token, still rejected: the account itself is not accepted by
        // the API. Re-login is the only sane recovery.
        clientLogger.error('UNAUTHORIZED dopo refresh del token', { operation: operation.operationName })
        forceLogin()
        return
      }
      return retryAfterRefresh(operation, forward)
    }
    error.errors.forEach(({ message, path }) => {
      clientLogger.error(`GraphQL error: ${message}`, {
        path:      path as unknown as Record<string, unknown> | undefined,
        operation: operation.operationName,
      })
      toastOnce(`gql:${message}`, message)
    })
    return
  }

  clientLogger.error(`Network error: ${error.message}`, {
    operation: operation.operationName,
  })
  toastOnce('network', NETWORK_ERROR_MSG)
})

const authLink = setContext((_, { headers }) => {
  const token = keycloak.token ?? localStorage.getItem('og_token') ?? ''
  return {
    headers: {
      ...headers,
      authorization: token ? `Bearer ${token}` : '',
    },
  }
})

export const apolloClient = new ApolloClient({
  link: from([errorLink, authLink.concat(httpLink)]),
  cache: new InMemoryCache(),
})
