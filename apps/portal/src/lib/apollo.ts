import { ApolloClient, InMemoryCache, createHttpLink, from } from '@apollo/client/core'
import { setContext } from '@apollo/client/link/context'
import { onError } from '@apollo/client/link/error'
import { keycloak } from './keycloak'
import { notifyError } from './notify'
import i18n from '@/i18n/i18n'

const httpLink = createHttpLink({
  uri: (import.meta.env['VITE_API_URL'] as string | undefined) ?? '/graphql',
})

interface PortalGraphQLError { message: string; extensions?: { code?: string } }

/**
 * Polling: only the ticket list/detail pages opt in (see TicketListPage /
 * TicketDetailPage `pollInterval`). No global default — `me`, KB, catalog
 * and field rules must not re-fetch every 30s in every open tab.
 */
export const TICKET_POLL_INTERVAL_MS = 30_000

const errorLink = onError((errResponse) => {
  const graphQLErrors = (errResponse as { graphQLErrors?: PortalGraphQLError[] }).graphQLErrors
  const networkError  = (errResponse as { networkError?: { message: string } }).networkError
  if (graphQLErrors) {
    for (const err of graphQLErrors) {
      // Only a real auth failure (expired/absent token) re-logins. Matching on
      // the message text also caught "Unauthorized: token/tenant mismatch"
      // (a FORBIDDEN-class error) and looped the user through Keycloak forever.
      if (err.extensions?.code === 'UNAUTHORIZED') {
        void keycloak.login()
      } else {
        // Never swallow: the portal has no per-page error handling, so an
        // ignored error would just render "no tickets / not found".
        console.error('[portal] GraphQL error:', err.extensions?.code ?? '', err.message)
        notifyError(err.message)
      }
    }
  }
  if (networkError) {
    console.error('[portal] Network error:', networkError.message)
    notifyError(i18n.t('errors.network'))
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
      fetchPolicy: 'cache-and-network',
    },
  },
})
