import Keycloak from 'keycloak-js'

/**
 * Extracts the tenant slug from the current hostname.
 * c-one.localhost:5173  → "c-one"
 * c-one.opengrafo.com   → "c-one"
 * acme.opengrafo.com    → "acme"
 *
 * Throws if the hostname has no subdomain (localhost, 192.168.x.x, etc.)
 * to prevent silent misconfiguration.
 */
export function getTenantSlug(): string {
  const hostname = window.location.hostname  // "c-one.localhost" | "c-one.opengrafo.com"
  const first    = hostname.split('.')[0]!

  // Bare hostnames with no tenant prefix
  if (
    first === 'localhost' ||
    first === '127'       ||
    first.startsWith('192') ||
    first.startsWith('10')  ||
    first === ''
  ) {
    throw new Error(
      `Nessun tenant nel sottodominio. Accedi tramite: c-one.localhost:5173`,
    )
  }

  return first
}

let _keycloak: Keycloak | null = null

export function getKeycloak(): Keycloak {
  if (!_keycloak) {
    throw new Error('Keycloak non inizializzato — chiama initKeycloak() prima')
  }
  return _keycloak
}

export async function initKeycloak(): Promise<boolean> {
  const slug = getTenantSlug()

  const keycloakUrl = import.meta.env['VITE_KEYCLOAK_URL'] || window.location.origin

  _keycloak = new Keycloak({
    url:      keycloakUrl,
    realm:    slug,
    clientId: import.meta.env['VITE_KEYCLOAK_CLIENT_ID'] as string,
  })

  try {
    const authenticated = await _keycloak.init({
      onLoad:           'login-required',
      checkLoginIframe: false,
      pkceMethod:       'S256',
      redirectUri:      window.location.href,
    })

    return authenticated
  } catch {
    throw new Error(
      `Impossibile connettersi a Keycloak per il realm "${slug}". ` +
      `Verifica che il realm esista e che Keycloak sia raggiungibile.`,
    )
  }
}

/** Convenience re-export — alias per getKeycloak() usato dai componenti */
export const keycloak = new Proxy({} as Keycloak, {
  get(_target, prop) {
    return getKeycloak()[prop as keyof Keycloak]
  },
  set(_target, prop, value) {
    (getKeycloak() as unknown as Record<string, unknown>)[prop as string] = value
    return true
  },
})
