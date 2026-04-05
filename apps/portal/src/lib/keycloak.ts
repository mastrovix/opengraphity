import Keycloak from 'keycloak-js'

export function getTenantSlug(): string {
  const hostname = window.location.hostname
  const first    = hostname.split('.')[0]!

  if (
    first === 'localhost' ||
    first === '127'       ||
    first === 'portal'   ||
    first.startsWith('192') ||
    first.startsWith('10')  ||
    first === ''
  ) {
    // In dev on localhost:5174, read slug from env or default
    const envSlug = import.meta.env['VITE_TENANT_SLUG'] as string | undefined
    if (envSlug) return envSlug
    throw new Error('Nessun tenant nel sottodominio. Accedi tramite: portal.c-one.localhost o imposta VITE_TENANT_SLUG.')
  }

  // portal.c-one.localhost → second segment is the tenant slug
  const parts = hostname.split('.')
  // "portal.c-one.localhost" → ["portal","c-one","localhost"]
  if (parts[0] === 'portal' && parts.length >= 3) return parts[1]!

  return first
}

let _keycloak: Keycloak | null = null

export function getKeycloak(): Keycloak {
  if (!_keycloak) throw new Error('Keycloak non inizializzato — chiama initKeycloak() prima')
  return _keycloak
}

export async function initKeycloak(): Promise<boolean> {
  const slug         = getTenantSlug()
  const keycloakUrl  = import.meta.env['VITE_KEYCLOAK_URL'] as string | undefined
                     ?? window.location.origin

  _keycloak = new Keycloak({
    url:      keycloakUrl,
    realm:    slug,
    clientId: (import.meta.env['VITE_KEYCLOAK_CLIENT_ID'] as string | undefined) ?? 'opengrafo-portal',
  })

  const authenticated = await _keycloak.init({
    onLoad:           'login-required',
    checkLoginIframe: false,
    pkceMethod:       'S256',
    redirectUri:      window.location.href,
  })

  return authenticated
}

export const keycloak = new Proxy({} as Keycloak, {
  get(_target, prop) {
    return getKeycloak()[prop as keyof Keycloak]
  },
  set(_target, prop, value) {
    (getKeycloak() as unknown as Record<string, unknown>)[prop as string] = value
    return true
  },
})
