import { ApolloClient, InMemoryCache, createHttpLink } from '@apollo/client/core'
import { setContext } from '@apollo/client/link/context'
import { getToken, removeToken, isTokenExpired } from './auth'

const httpLink = createHttpLink({
  uri: import.meta.env['VITE_API_URL'] ?? '/graphql',
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
  link: authLink.concat(httpLink),
  cache: new InMemoryCache(),
})
