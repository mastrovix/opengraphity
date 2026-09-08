/**
 * Thin wrapper over `@opengraphity/web-core`: the app only supplies its env
 * (`VITE_KEYCLOAK_URL`, `VITE_KEYCLOAK_CLIENT_ID`, optional `VITE_TENANT_SLUG`).
 * Tenant parsing, PKCE init and the fail-fast errors live in the package,
 * shared with apps/portal — do not re-implement them here.
 */
import { createKeycloak, requireTenantSlug } from '@opengraphity/web-core'

/**
 * Tenant slug of the running app: `VITE_TENANT_SLUG` override first (Tailscale
 * MagicDNS, hosts whose first label is not the tenant), else the hostname
 * (`c-one.localhost:5173` → "c-one"). Throws a readable error otherwise.
 */
export function getTenantSlug(): string {
  return requireTenantSlug({
    hostname: window.location.hostname,
    override: import.meta.env['VITE_TENANT_SLUG'] as string | undefined,
    hint:     'c-one.localhost:5173',
  })
}

const handle = createKeycloak({
  url:          import.meta.env['VITE_KEYCLOAK_URL'] as string | undefined,
  clientId:     import.meta.env['VITE_KEYCLOAK_CLIENT_ID'] as string | undefined,
  resolveRealm: getTenantSlug,
})

export const initKeycloak = handle.initKeycloak
export const getKeycloak  = handle.getKeycloak
/** Proxy to the initialised instance — throws on access before `initKeycloak()`. */
export const keycloak     = handle.keycloak
