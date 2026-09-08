/**
 * Apollo client — link chain (auth bearer, UNAUTHORIZED → refresh + replay,
 * deduped error notifications) lives in `@opengraphity/web-core`, shared with
 * apps/portal. Here: endpoint, token source and how errors are shown.
 */
import { toast } from 'sonner'
import { createApolloClient } from '@opengraphity/web-core'
import { keycloak } from './keycloak'
import { clientLogger } from './clientLogger'
import { refreshToken, isSessionInvalid, forceLogin } from './tokenRefresh'

const NETWORK_ERROR_MSG = 'Errore di connessione al server'

export const apolloClient = createApolloClient({
  uri:              (import.meta.env['VITE_API_URL'] as string | undefined) ?? '/graphql',
  getToken:         () => keycloak.token,
  refreshToken:     () => refreshToken(-1),
  isSessionInvalid,
  onSessionInvalid: forceLogin,
  onNetworkError:   () => toast.error(NETWORK_ERROR_MSG),
  onGraphQLError:   (message) => toast.error(message),
  clientLogger,
})
