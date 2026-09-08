/**
 * Token refresh (E-05) — implementation in `@opengraphity/web-core`; this file
 * only binds it to the web app's keycloak instance, sonner toasts and logger.
 */
import { toast } from 'sonner'
import { createTokenRefresh } from '@opengraphity/web-core'
import { keycloak } from './keycloak'
import { clientLogger } from './clientLogger'

const tokenRefresh = createTokenRefresh({
  keycloak,
  logger: clientLogger,
  notify: {
    error:   (message, opts) => { toast.error(message, opts) },
    success: (message, opts) => { toast.success(message, opts) },
  },
})

export const refreshToken          = tokenRefresh.refreshToken
export const isSessionInvalid      = tokenRefresh.isSessionInvalid
export const forceLogin            = tokenRefresh.forceLogin
export const startTokenRefreshLoop = tokenRefresh.startTokenRefreshLoop
