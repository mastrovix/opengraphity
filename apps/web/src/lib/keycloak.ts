import Keycloak from 'keycloak-js'

export const keycloak = new Keycloak({
  url:      import.meta.env['VITE_KEYCLOAK_URL']      as string,
  realm:    import.meta.env['VITE_KEYCLOAK_REALM']    as string,
  clientId: import.meta.env['VITE_KEYCLOAK_CLIENT_ID'] as string,
})

export async function initKeycloak(): Promise<boolean> {
  const redirectUri = window.location.href

  const authenticated = await keycloak.init({
    onLoad:           'login-required',
    checkLoginIframe: false,
    pkceMethod:       'S256',
    redirectUri,
  })

  return authenticated
}
