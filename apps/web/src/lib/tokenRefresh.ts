/**
 * Token refresh (E-05) — implementation in `@opengraphity/web-core`; this file
 * only binds it to the web app's keycloak instance, sonner toasts and logger.
 */
import { toast } from 'sonner'
import { createTokenRefresh } from '@opengraphity/web-core'
import { keycloak } from './keycloak'
import { clientLogger } from './clientLogger'
import i18n from '@/i18n/i18n'

const tokenRefresh = createTokenRefresh({
  keycloak,
  logger: clientLogger,
  notify: {
    error:   (message, opts) => { toast.error(message, opts) },
    success: (message, opts) => { toast.success(message, opts) },
  },
  /**
   * I messaggi nella lingua di chi guarda (revisione totale · E-14): il
   * portale li passava e il web no, quindi alla scadenza della sessione l'app
   * mostrava il ripiego del pacchetto — tre frasi in una lingua che il
   * cliente può non avere scelto. Risolti al momento della notifica, non
   * all'import, così valgono per la lingua attiva.
   */
  messages: {
    sessionExpired:        () => i18n.t('errors.sessionExpired'),
    authServerRestored:    () => i18n.t('errors.authRestored'),
    authServerUnreachable: (seconds) => i18n.t('errors.authUnreachable', { seconds }),
  },
})

export const refreshToken          = tokenRefresh.refreshToken
export const isSessionInvalid      = tokenRefresh.isSessionInvalid
export const forceLogin            = tokenRefresh.forceLogin
export const startTokenRefreshLoop = tokenRefresh.startTokenRefreshLoop
