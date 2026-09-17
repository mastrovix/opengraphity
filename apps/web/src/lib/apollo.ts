/**
 * Apollo client — link chain (auth bearer, UNAUTHORIZED → refresh + replay,
 * deduped error notifications) lives in `@opengraphity/web-core`, shared with
 * apps/portal. Here: endpoint, token source and how errors are shown.
 */
import { toast } from 'sonner'
import { createApolloClient, mostraSchermataDiStop } from '@opengraphity/web-core'
import i18n from '@/i18n/i18n'
import { APOLLO_TYPE_POLICIES } from './apolloTypePolicies'
import { APOLLO_DEFAULT_OPTIONS } from './apolloDefaults'
import { keycloak } from './keycloak'
import { clientLogger } from './clientLogger'
import { refreshToken, isSessionInvalid, forceLogin } from './tokenRefresh'

export const apolloClient = createApolloClient({
  uri:              (import.meta.env['VITE_API_URL'] as string | undefined) ?? '/graphql',
  getToken:         () => keycloak.token,
  refreshToken:     () => refreshToken(-1),
  isSessionInvalid,
  onSessionInvalid: forceLogin,
  /*
   * IL TENANT SOSPESO NON È UNA SESSIONE SCADUTA.
   *
   * Qui c'era, per omissione, il ciclo peggiore che il prodotto abbia avuto:
   * il rifiuto arrivava come UNAUTHORIZED, quindi si rinfrescava il token, si
   * riprovava, si concludeva «account non accettato» e si tornava al login —
   * dove Keycloak dice sì, perché il realm e la persona esistono ancora. Poi
   * di nuovo, e di nuovo. Chi guardava vedeva l'app lampeggiare, e alla fine
   * un «414 Request-URI Too Large» di nginx (17 set 2026).
   *
   * Adesso si ferma e lo dice. Riaprire si fa dalla console di piattaforma:
   * non c'è niente che questa pagina possa riprovare.
   */
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
  onNetworkError:   () => toast.error(i18n.t('errors.network')),
  onGraphQLError:   (message) => toast.error(message),
  clientLogger,
  /*
    La frase di un errore la scrive il client: l'API manda un messaggio inglese
    stabile (log, integrazioni) e, quando serve, una CHIAVE. Una chiave che
    questo bundle non conosce non si nasconde — resta il messaggio del server.
  */
  traduciErrore: (key, params) => (i18n.exists(key, params) ? i18n.t(key, params) : null),
  typePolicies: APOLLO_TYPE_POLICIES,
  defaultOptions: APOLLO_DEFAULT_OPTIONS,
})
