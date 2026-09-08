import { keycloak } from '../lib/keycloak'

/**
 * Session actions. Authentication itself is owned by Keycloak (`initKeycloak`
 * with `login-required`): there is no app-level `login(token)` and nothing is
 * persisted in localStorage (E-18).
 */
export function useAuth() {
  const logout = () => {
    keycloak.logout({ redirectUri: window.location.origin + '/' })
  }

  return { logout }
}
