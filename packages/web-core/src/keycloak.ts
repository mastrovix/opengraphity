import Keycloak from 'keycloak-js'

export interface CreateKeycloakOptions {
  /** `VITE_KEYCLOAK_URL` — may be undefined at call time; validated in `initKeycloak()`. */
  url: string | undefined
  /** `VITE_KEYCLOAK_CLIENT_ID` — idem. */
  clientId: string | undefined
  /** Realm = tenant slug. Called once, inside `initKeycloak()`, so its errors surface there. */
  resolveRealm: () => string
  /**
   * Names of the variables reported in the error when `url` / `clientId` are
   * missing. Defaults to the VITE_* names both apps use.
   */
  envNames?: { url: string; clientId: string }
}

export interface KeycloakHandle {
  /**
   * Creates the keycloak-js instance and runs `init` (login-required, PKCE
   * S256, no login iframe, token kept in memory only). Resolves with the
   * `authenticated` flag. Throws a readable Error — with `cause` — when the
   * env is missing, the tenant cannot be resolved, or Keycloak does not
   * answer. Validation happens here, not at module load, so the app's
   * `initKeycloak().catch(...)` can render the message instead of a blank page.
   */
  initKeycloak(): Promise<boolean>
  /** The initialised instance; throws if `initKeycloak()` has not run. */
  getKeycloak(): Keycloak
  /** Proxy to the initialised instance — same fail-fast as `getKeycloak()` on every access. */
  keycloak: Keycloak
}

const DEFAULT_ENV_NAMES = { url: 'VITE_KEYCLOAK_URL', clientId: 'VITE_KEYCLOAK_CLIENT_ID' }

function describeCause(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    // keycloak-js rejects init with `{ error, error_description }` on OIDC errors
    const o = err as { error?: unknown; error_description?: unknown }
    const parts = [o.error, o.error_description].filter((p) => typeof p === 'string' && p !== '')
    if (parts.length > 0) return parts.join(': ')
  }
  return String(err)
}

export function createKeycloak(opts: CreateKeycloakOptions): KeycloakHandle {
  const envNames = opts.envNames ?? DEFAULT_ENV_NAMES
  let instance: Keycloak | null = null

  function getKeycloak(): Keycloak {
    if (!instance) {
      throw new Error('Keycloak non inizializzato — chiama initKeycloak() prima')
    }
    return instance
  }

  async function initKeycloak(): Promise<boolean> {
    const realm = opts.resolveRealm()

    if (!opts.url) {
      throw new Error(`${envNames.url} non configurata — imposta la variabile nell'ambiente di build (.env.local)`)
    }
    if (!opts.clientId) {
      throw new Error(`${envNames.clientId} non configurata — imposta la variabile nell'ambiente di build (.env.local)`)
    }

    const kc = new Keycloak({ url: opts.url, realm, clientId: opts.clientId })
    try {
      const authenticated = await kc.init({
        onLoad:           'login-required',
        checkLoginIframe: false,
        pkceMethod:       'S256',
        redirectUri:      window.location.href,
      })
      instance = kc
      return authenticated
    } catch (err) {
      throw new Error(
        `Impossibile connettersi a Keycloak (${opts.url}) per il realm "${realm}": ${describeCause(err)}. ` +
        `Verifica che il realm esista e che Keycloak sia raggiungibile.`,
        { cause: err },
      )
    }
  }

  const keycloak = new Proxy({} as Keycloak, {
    get(_target, prop) {
      const kc = getKeycloak()
      const value = (kc as unknown as Record<PropertyKey, unknown>)[prop]
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(kc) : value
    },
    set(_target, prop, value) {
      (getKeycloak() as unknown as Record<PropertyKey, unknown>)[prop] = value
      return true
    },
  })

  return { initKeycloak, getKeycloak, keycloak }
}
