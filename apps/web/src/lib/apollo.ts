import { ApolloClient, InMemoryCache, createHttpLink, from } from '@apollo/client/core'
import { setContext } from '@apollo/client/link/context'
import { onError } from '@apollo/client/link/error'
import { toast } from 'sonner'
// Legacy auth helpers kept for fallback reference
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { getToken as _getToken, removeToken as _removeToken, isTokenExpired as _isTokenExpired } from './auth'
import { keycloak } from './keycloak'
import { clientLogger } from './clientLogger'

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

// Debounce: N failing queries must trigger ONE re-login, not N.
let reauthInFlight = false

function forceReauth(): void {
  if (reauthInFlight) return
  reauthInFlight = true
  toastOnce('unauthorized', 'Sessione scaduta — nuovo accesso necessario')
  // Try a silent token refresh first; if that fails, full login redirect.
  void keycloak.updateToken(30).then(
    () => { reauthInFlight = false },
    () => void keycloak.login(),
  )
}

const errorLink = onError((errResponse) => {
  const { operation } = errResponse
  const graphQLErrors = (errResponse as { graphQLErrors?: Array<{ message: string; path?: unknown }> }).graphQLErrors
  const networkError  = (errResponse as { networkError?: { message: string } }).networkError

  if (graphQLErrors) {
    graphQLErrors.forEach(({ message, path }) => {
      if (message.toLowerCase().includes('unauthorized')) {
        // Expired/invalid session: NEVER swallow silently — the app would keep
        // rendering empty lists and "not found" pages. Surface + re-auth.
        clientLogger.error(`Unauthorized: ${message}`, { operation: operation.operationName })
        forceReauth()
      } else {
        clientLogger.error(`GraphQL error: ${message}`, {
          path:      path as Record<string, unknown> | undefined,
          operation: operation.operationName,
        })
        toastOnce(`gql:${message}`, message)
      }
    })
  }
  if (networkError) {
    clientLogger.error(`Network error: ${networkError.message}`, {
      operation: operation.operationName,
    })
    toastOnce('network', 'Errore di connessione al server')
  }
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
