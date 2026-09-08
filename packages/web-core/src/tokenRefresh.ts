/**
 * Keycloak token refresh shared by the Apollo error link and the background
 * refresh loop (E-05).
 *
 * Two failure modes must NOT be confused:
 *   - session invalid (refresh token expired/revoked): keycloak-js gets HTTP 400
 *     and clears the token → the only fix is a new login;
 *   - transport error (Keycloak unreachable, network blip): the token is still
 *     there → retry with backoff, tell the user, never redirect (a redirect
 *     would lose every open form for a problem that fixes itself).
 */
import type { ClientLogger } from './logger.js'

/** The subset of keycloak-js this module needs (mockable in tests). */
export interface KeycloakLike {
  token?: string | undefined
  updateToken(minValidity?: number): Promise<boolean>
  login(): Promise<void>
  onTokenExpired?: (() => void) | undefined
}

/** App-side notifications (sonner toasts in web, banner in portal). */
export interface RefreshNotifier {
  error(message: string, opts?: { id?: string; duration?: number }): void
  success(message: string, opts?: { id?: string }): void
}

/** Resolved at notification time (not at module load) so i18n-backed apps pick up the current language. */
export interface TokenRefreshMessages {
  sessionExpired: () => string
  authServerRestored: () => string
  authServerUnreachable: (retryInSeconds: number) => string
}

export const DEFAULT_TOKEN_REFRESH_MESSAGES: TokenRefreshMessages = {
  sessionExpired:        () => 'Sessione scaduta — nuovo accesso necessario',
  authServerRestored:    () => 'Connessione al server di autenticazione ripristinata',
  authServerUnreachable: (s) => `Server di autenticazione non raggiungibile — nuovo tentativo tra ${s}s`,
}

export const DEFAULT_BACKOFF_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 60_000]

export interface CreateTokenRefreshOptions {
  keycloak: KeycloakLike
  notify:   RefreshNotifier
  logger:   ClientLogger
  messages?: Partial<TokenRefreshMessages>
  /** Retry delays after a transport error; the last value repeats. */
  backoffMs?: readonly number[]
  /** Safety-interval period of the background loop. */
  intervalMs?: number
}

export interface TokenRefresh {
  /**
   * Refresh the access token; concurrent callers share one round-trip.
   * `minValidity = -1` forces the refresh even if the token looks valid (used
   * when the API rejected it).
   */
  refreshToken(minValidity: number): Promise<boolean>
  /**
   * True when keycloak-js dropped the session after a failed refresh (HTTP 400
   * from the token endpoint → `clearToken()`). Anything else that made
   * `updateToken` reject is a transport problem.
   */
  isSessionInvalid(): boolean
  /** Redirect to login once; N concurrent failures must not trigger N redirects. */
  forceLogin(): void
  /**
   * Keeps the access token fresh for the whole session:
   *   - `keycloak.onTokenExpired` → immediate forced refresh;
   *   - a safety interval refreshes when < 60s of validity remain (covers
   *     the token obtained before the handler was installed).
   * Returns a stop function (used by tests; apps run it for the page lifetime).
   */
  startTokenRefreshLoop(): () => void
}

const RETRY_TOAST_ID = 'keycloak-refresh'

export function createTokenRefresh(opts: CreateTokenRefreshOptions): TokenRefresh {
  const { keycloak, notify, logger } = opts
  const messages: TokenRefreshMessages = { ...DEFAULT_TOKEN_REFRESH_MESSAGES, ...opts.messages }
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS
  const intervalMs = opts.intervalMs ?? 30_000
  if (backoff.length === 0) throw new Error('createTokenRefresh: backoffMs non può essere vuoto')

  let inFlight: Promise<boolean> | null = null

  function refreshToken(minValidity: number): Promise<boolean> {
    if (!inFlight) {
      inFlight = keycloak.updateToken(minValidity).finally(() => { inFlight = null })
    }
    return inFlight
  }

  function isSessionInvalid(): boolean {
    return !keycloak.token
  }

  let loginInFlight = false
  let attempt = 0
  let retryHandle: ReturnType<typeof setTimeout> | null = null
  let intervalHandle: ReturnType<typeof setInterval> | null = null

  function stopLoop(): void {
    if (intervalHandle !== null) { clearInterval(intervalHandle); intervalHandle = null }
    if (retryHandle !== null) { clearTimeout(retryHandle); retryHandle = null }
  }

  function forceLogin(): void {
    if (loginInFlight) return
    loginInFlight = true
    // The redirect is on its way: no further refresh attempts make sense.
    stopLoop()
    notify.error(messages.sessionExpired())
    logger.warn('Sessione non valida: redirect al login')
    void keycloak.login()
  }

  // ── Background refresh loop ────────────────────────────────────────────────

  async function refreshOrRecover(minValidity: number): Promise<void> {
    if (retryHandle !== null) { clearTimeout(retryHandle); retryHandle = null }
    try {
      await refreshToken(minValidity)
      if (attempt > 0) {
        attempt = 0
        notify.success(messages.authServerRestored(), { id: RETRY_TOAST_ID })
      }
    } catch (err) {
      if (isSessionInvalid()) { forceLogin(); return }
      const delay = backoff[Math.min(attempt, backoff.length - 1)]!
      attempt++
      const message = err instanceof Error ? err.message : String(err)
      logger.warn('Refresh token fallito (rete), nuovo tentativo', { attempt, delayMs: delay, message })
      notify.error(messages.authServerUnreachable(delay / 1000), { id: RETRY_TOAST_ID, duration: delay })
      retryHandle = setTimeout(() => void refreshOrRecover(-1), delay)
    }
  }

  function startTokenRefreshLoop(): () => void {
    if (intervalHandle !== null) throw new Error('startTokenRefreshLoop già avviato')
    keycloak.onTokenExpired = () => { void refreshOrRecover(-1) }
    intervalHandle = setInterval(() => {
      if (retryHandle === null) void refreshOrRecover(60)
    }, intervalMs)
    return () => {
      stopLoop()
      keycloak.onTokenExpired = undefined
    }
  }

  return { refreshToken, isSessionInvalid, forceLogin, startTokenRefreshLoop }
}
