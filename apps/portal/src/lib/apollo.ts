import { ApolloClient, InMemoryCache, createHttpLink, from } from '@apollo/client/core'
import { setContext } from '@apollo/client/link/context'
import { onError } from '@apollo/client/link/error'
import { keycloak } from './keycloak'
import { notifyError } from './notify'

const httpLink = createHttpLink({
  uri: (import.meta.env['VITE_API_URL'] as string | undefined) ?? '/graphql',
})

const errorLink = onError((errResponse) => {
  const graphQLErrors = (errResponse as { graphQLErrors?: Array<{ message: string }> }).graphQLErrors
  const networkError  = (errResponse as { networkError?: { message: string } }).networkError
  if (graphQLErrors) {
    for (const { message } of graphQLErrors) {
      if (message.toLowerCase().includes('unauthorized')) {
        keycloak.login()
      } else {
        // Never swallow: the portal has no per-page error handling, so an
        // ignored error would just render "no tickets / not found".
        console.error('[portal] GraphQL error:', message)
        notifyError(message)
      }
    }
  }
  if (networkError) {
    console.error('[portal] Network error:', networkError.message)
    notifyError('Errore di connessione al server')
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
