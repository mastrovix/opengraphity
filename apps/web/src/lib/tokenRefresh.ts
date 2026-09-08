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
import { toast } from 'sonner'
import { keycloak } from './keycloak'
import { clientLogger } from './clientLogger'

let inFlight: Promise<boolean> | null = null

/**
 * Refresh the access token; concurrent callers share one round-trip.
 * `minValidity = -1` forces the refresh even if the token looks valid (used
 * when the API rejected it).
 */
export function refreshToken(minValidity: number): Promise<boolean> {
  if (!inFlight) {
    inFlight = keycloak.updateToken(minValidity).finally(() => { inFlight = null })
  }
  return inFlight
}

/**
 * True when keycloak-js dropped the session after a failed refresh (HTTP 400
 * from the token endpoint → `clearToken()`). Anything else that made
 * `updateToken` reject is a transport problem.
 */
export function isSessionInvalid(): boolean {
  return !keycloak.token
}

const SESSION_EXPIRED_MSG = 'Sessione scaduta — nuovo accesso necessario'
const RETRY_TOAST_ID = 'keycloak-refresh'

let loginInFlight = false

/** Redirect to login once; N concurrent failures must not trigger N redirects. */
export function forceLogin(): void {
  if (loginInFlight) return
  loginInFlight = true
  toast.error(SESSION_EXPIRED_MSG)
  clientLogger.warn('Sessione non valida: redirect al login')
  void keycloak.login()
}

// ── Background refresh loop ──────────────────────────────────────────────────

const BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const

let attempt = 0
let retryHandle: number | null = null

async function refreshOrRecover(minValidity: number): Promise<void> {
  if (retryHandle !== null) { window.clearTimeout(retryHandle); retryHandle = null }
  try {
    await refreshToken(minValidity)
    if (attempt > 0) {
      attempt = 0
      toast.success('Connessione al server di autenticazione ripristinata', { id: RETRY_TOAST_ID })
    }
  } catch (err) {
    if (isSessionInvalid()) { forceLogin(); return }
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!
    attempt++
    const message = err instanceof Error ? err.message : String(err)
    clientLogger.warn('Refresh token fallito (rete), nuovo tentativo', { attempt, delayMs: delay, message })
    toast.error(`Server di autenticazione non raggiungibile — nuovo tentativo tra ${delay / 1000}s`, { id: RETRY_TOAST_ID, duration: delay })
    retryHandle = window.setTimeout(() => void refreshOrRecover(-1), delay)
  }
}

/**
 * Keeps the access token fresh for the whole session:
 *   - `keycloak.onTokenExpired` → immediate forced refresh;
 *   - a 30s safety interval refreshes when < 60s of validity remain (covers
 *     the token obtained before the handler was installed).
 */
export function startTokenRefreshLoop(): void {
  keycloak.onTokenExpired = () => { void refreshOrRecover(-1) }
  window.setInterval(() => {
    if (retryHandle === null) void refreshOrRecover(60)
  }, 30_000)
}
