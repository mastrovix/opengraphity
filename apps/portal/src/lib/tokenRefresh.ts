/**
 * Token refresh — implementation in `@opengraphity/web-core` (same as
 * apps/web): shared in-flight refresh, backoff on transport errors, login
 * redirect only when the session is really invalid. The portal used to run
 * `updateToken(60).catch(() => keycloak.login())` every 30s, so any network
 * blip towards Keycloak redirected the user and lost the form being filled.
 */
import { createTokenRefresh } from '@opengraphity/web-core'
import i18n from '@/i18n/i18n'
import { keycloak } from './keycloak'
import { clientLogger } from './api'
import { notifyError, notifyInfo } from './notify'

const tokenRefresh = createTokenRefresh({
  keycloak,
  logger: clientLogger,
  notify: {
    error:   (message) => notifyError(message),
    success: (message) => notifyInfo(message),
  },
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
