import { ApolloClient, InMemoryCache, createHttpLink, from } from '@apollo/client/core'
import { setContext } from '@apollo/client/link/context'
import { onError } from '@apollo/client/link/error'
// Legacy auth helpers kept for fallback reference
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { getToken as _getToken, removeToken as _removeToken, isTokenExpired as _isTokenExpired } from './auth'
import { keycloak } from './keycloak'

const httpLink = createHttpLink({
  uri: import.meta.env['VITE_API_URL'] ?? '/graphql',
})

const errorLink = onError(({ error, operation }) => {
  console.error('[Apollo error] operation:', operation.operationName, '| error:', error)
})

const authLink = setContext((_, { headers }) => {
  const token = keycloak.token ?? localStorage.getItem('og_token') ?? ''
  console.log('[APOLLO] token presente:', !!token, token?.slice(0, 30))
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
