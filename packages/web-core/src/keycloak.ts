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

/**
 * I parametri con cui Keycloak RISPONDE tornando dal login. Sono la sua
 * risposta, non l'indirizzo della pagina.
 */
const RISPOSTA_DEL_LOGIN = [
  'state', 'session_state', 'code', 'iss',
  'error', 'error_description', 'error_uri',
  'kc_action_status',
] as const

/**
 * L'INDIRIZZO A CUI TORNARE DOPO IL LOGIN — e perché non è
 * `window.location.href` (17 set 2026).
 *
 * `redirectUri: window.location.href` sembra la cosa ovvia, e ha prodotto un
 * URL da ottomila caratteri e un **414 Request-URI Too Large** da nginx.
 * Il meccanismo, che si autoalimenta:
 *
 *  1. si va al login; Keycloak riporta a `/pagina#state=A&code=A`;
 *  2. `init` legge `window.location.href` — che ORA porta quel frammento — e
 *     lo tiene come `redirectUri` per i login successivi;
 *  3. al login dopo, Keycloak accoda la SUA risposta a un indirizzo che un
 *     frammento ce l'ha già: `/pagina#state=A&code=A&state=B&code=B`;
 *  4. con `state` due volte il callback non si riconosce più, quindi si
 *     rifà il login — e ogni giro aggiunge trecento caratteri.
 *
 * Nessuno di questi passi è sbagliato da solo: sbagliato è chiamare
 * «indirizzo della pagina» una stringa che contiene la risposta a una domanda
 * precedente. Qui la risposta si toglie.
 *
 * Il frammento si butta solo quando È una risposta di login: un'ancora vera
 * (`#sezione`) è di chi legge, e resta.
 */
export function redirectUriPulito(href: string): string {
  const u = new URL(href)

  const frammento = u.hash.startsWith('#') ? u.hash.slice(1) : u.hash
  if (frammento !== '') {
    const p = new URLSearchParams(frammento)
    // Una risposta di login porta sempre `state` (o un `error`): è quella la
    // firma, non la presenza di un frammento qualsiasi.
    if (RISPOSTA_DEL_LOGIN.some((k) => p.has(k))) u.hash = ''
  }

  // `responseMode: 'query'` mette gli stessi parametri nella query string.
  for (const k of RISPOSTA_DEL_LOGIN) u.searchParams.delete(k)

  return u.toString()
}

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

/**
 * I messaggi di questo file sono in INGLESE (revisione totale · H-34).
 *
 * Erano in italiano fisso e finiscono a schermo (`main.tsx`): un cliente
 * inglese con Keycloak giu leggeva «Impossibile connettersi a Keycloak (…)».
 * Non possono passare da i18n: succedono PRIMA che l'app esista — non c'e un
 * tenant, quindi non c'e la sua lingua, e nemmeno le traduzioni sono caricate.
 * La lingua del prodotto e l'inglese, e questo e il caso in cui vale senza
 * eccezioni.
 */
export function createKeycloak(opts: CreateKeycloakOptions): KeycloakHandle {
  const envNames = opts.envNames ?? DEFAULT_ENV_NAMES
  let instance: Keycloak | null = null

  function getKeycloak(): Keycloak {
    if (!instance) {
      throw new Error('Keycloak is not initialized — call initKeycloak() first')
    }
    return instance
  }

  async function initKeycloak(): Promise<boolean> {
    const realm = opts.resolveRealm()

    if (!opts.url) {
      throw new Error(`${envNames.url} is not configured — set it in the build environment (.env.local)`)
    }
    if (!opts.clientId) {
      throw new Error(`${envNames.clientId} is not configured — set it in the build environment (.env.local)`)
    }

    const kc = new Keycloak({ url: opts.url, realm, clientId: opts.clientId })
    try {
      const authenticated = await kc.init({
        onLoad:           'login-required',
        checkLoginIframe: false,
        pkceMethod:       'S256',
        // NON `window.location.href`: porterebbe la risposta del login
        // precedente, e ogni giro la accoderebbe di nuovo (vedi sopra).
        redirectUri:      redirectUriPulito(window.location.href),
      })
      instance = kc
      return authenticated
    } catch (err) {
      throw new Error(
        `Cannot reach Keycloak (${opts.url}) for realm "${realm}": ${describeCause(err)}. ` +
        `Check that the realm exists and that Keycloak is reachable.`,
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
