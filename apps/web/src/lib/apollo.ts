/**
 * Apollo client — link chain (auth bearer, UNAUTHORIZED → refresh + replay,
 * deduped error notifications) lives in `@opengraphity/web-core`, shared with
 * apps/portal. Here: endpoint, token source and how errors are shown.
 */
import { toast } from 'sonner'
import { createApolloClient } from '@opengraphity/web-core'
import i18n from '@/i18n/i18n'
import { keycloak } from './keycloak'
import { clientLogger } from './clientLogger'
import { refreshToken, isSessionInvalid, forceLogin } from './tokenRefresh'

export const apolloClient = createApolloClient({
  uri:              (import.meta.env['VITE_API_URL'] as string | undefined) ?? '/graphql',
  getToken:         () => keycloak.token,
  refreshToken:     () => refreshToken(-1),
  isSessionInvalid,
  onSessionInvalid: forceLogin,
  onNetworkError:   () => toast.error(i18n.t('errors.network')),
  onGraphQLError:   (message) => toast.error(message),
  clientLogger,
  /*
    La frase di un errore la scrive il client: l'API manda un messaggio inglese
    stabile (log, integrazioni) e, quando serve, una CHIAVE. Una chiave che
    questo bundle non conosce non si nasconde — resta il messaggio del server.
  */
  traduciErrore: (key, params) => (i18n.exists(key, params) ? i18n.t(key, params) : null),
})
