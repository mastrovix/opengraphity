import { ApolloClient, InMemoryCache, createHttpLink, from } from '@apollo/client/core'
import { setContext } from '@apollo/client/link/context'
import { onError } from '@apollo/client/link/error'
// Legacy auth helpers kept for fallback reference
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { getToken as _getToken, removeToken as _removeToken, isTokenExpired as _isTokenExpired } from './auth'
import { keycloak } from './keycloak'
import { clientLogger } from './clientLogger'

const httpLink = createHttpLink({
  uri: import.meta.env['VITE_API_URL'] ?? '/graphql',
})

const errorLink = onError((errResponse) => {
  const { operation } = errResponse
  const graphQLErrors = (errResponse as { graphQLErrors?: Array<{ message: string; path?: unknown }> }).graphQLErrors
  const networkError  = (errResponse as { networkError?: { message: string } }).networkError

  if (graphQLErrors) {
    graphQLErrors.forEach(({ message, path }) => {
      if (!message.toLowerCase().includes('unauthorized')) {
        clientLogger.error(`GraphQL error: ${message}`, {
          path:      path as Record<string, unknown> | undefined,
          operation: operation.operationName,
        })
      }
    })
  }
  if (networkError) {
    clientLogger.error(`Network error: ${networkError.message}`, {
      operation: operation.operationName,
    })
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
