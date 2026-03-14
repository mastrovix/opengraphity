import { ApolloClient, InMemoryCache, createHttpLink, from } from '@apollo/client/core'
import { setContext } from '@apollo/client/link/context'
import { onError } from '@apollo/client/link/error'
import { getToken, removeToken, isTokenExpired } from './auth'

const httpLink = createHttpLink({
  uri: import.meta.env['VITE_API_URL'] ?? '/graphql',
})

const errorLink = onError(({ error, operation }) => {
  console.error('[Apollo error] operation:', operation.operationName, '| error:', error)
})

const authLink = setContext((_, prevContext: Record<string, unknown>) => {
  const headers = (prevContext['headers'] as Record<string, string>) ?? {}
  const token = getToken()

  if (token && isTokenExpired()) {
    removeToken()
    return { headers }
  }

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
