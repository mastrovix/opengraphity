import { ApolloClient, InMemoryCache, createHttpLink, from } from '@apollo/client/core'
import { setContext } from '@apollo/client/link/context'
import { onError } from '@apollo/client/link/error'
import { keycloak } from './keycloak'

const httpLink = createHttpLink({
  uri: (import.meta.env['VITE_API_URL'] as string | undefined) ?? '/graphql',
})

const errorLink = onError((errResponse) => {
  const graphQLErrors = (errResponse as { graphQLErrors?: Array<{ message: string }> }).graphQLErrors
  if (graphQLErrors) {
    for (const { message } of graphQLErrors) {
      if (message.toLowerCase().includes('unauthorized')) {
        keycloak.login()
      }
    }
  }
})

const authLink = setContext((_, { headers }) => {
  const token = keycloak.token ?? ''
  return {
    headers: {
      ...headers,
      authorization: token ? `Bearer ${token}` : '',
    },
  }
})

export const apolloClient = new ApolloClient({
  link:  from([errorLink, authLink.concat(httpLink)]),
  cache: new InMemoryCache(),
  defaultOptions: {
    watchQuery: {
      pollInterval: 30_000,   // 30s polling — no SSE in portal
      fetchPolicy:  'cache-and-network',
    },
  },
})
