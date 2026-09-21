/**
 * Apollo client — link chain (auth bearer, UNAUTHORIZED → refresh + replay,
 * deduped error notifications, match on `extensions.code` only) lives in
 * `@opengraphity/web-core`, shared with apps/web. Here: endpoint, token
 * source, how errors are shown and the portal's default fetch policy.
 */
import { createApolloClient, mostraSchermataDiStop } from '@opengraphity/web-core'
import i18n from '@/i18n/i18n'
import { keycloak } from './keycloak'
import { GRAPHQL_URI, clientLogger } from './api'
import { notifyError } from './notify'
import { refreshToken, isSessionInvalid, forceLogin } from './tokenRefresh'

/**
 * Polling: only the ticket list/detail pages opt in (see TicketListPage /
 * TicketDetailPage `pollInterval`). No global default — `me`, KB, catalog
 * and field rules must not re-fetch every 30s in every open tab.
 */
export const TICKET_POLL_INTERVAL_MS = 30_000

export const apolloClient = createApolloClient({
  uri:              GRAPHQL_URI,
  getToken:         () => keycloak.token,
  refreshToken:     () => refreshToken(-1),
  isSessionInvalid,
  onSessionInvalid: forceLogin,
  // Come nel web: un tenant sospeso è definitivo, quindi si ferma e lo dice
  // invece di rimbalzare fra portale e Keycloak (17 set 2026).
  onTenantSuspended: () => {
    const root = document.getElementById('root')
    if (root) {
      mostraSchermataDiStop({
        root,
        titolo:    i18n.t('auth.tenantSuspended.title'),
        dettaglio: i18n.t('auth.tenantSuspended.detail'),
      })
    }
  },
  onNetworkError:   () => notifyError(i18n.t('errors.network')),
  // Never swallow: the portal has no per-page error handling, so an ignored
  // error would just render "no tickets / not found".
  onGraphQLError:   (message) => notifyError(message),
  // Come nel web: la chiave la risolve chi ha una lingua.
  traduciErrore:    (key, params) => (i18n.exists(key, params) ? i18n.t(key, params) : null),
  clientLogger,
  defaultOptions: {
    watchQuery: { fetchPolicy: 'cache-and-network' },
  },
})
