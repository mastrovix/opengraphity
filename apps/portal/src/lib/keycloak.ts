/**
 * Thin wrapper over `@opengraphity/web-core` — same implementation as
 * apps/web/src/lib/keycloak.ts. The portal supplies only its env
 * (`VITE_KEYCLOAK_URL`, `VITE_KEYCLOAK_CLIENT_ID`, optional `VITE_TENANT_SLUG`).
 *
 * No defaults: a missing `VITE_KEYCLOAK_URL` used to fall back to
 * `window.location.origin` and a missing client id to "opengrafo-portal",
 * which hid a misconfigured build behind a Keycloak error page. Both now fail
 * with a readable message at `initKeycloak()`.
 */
import { createKeycloak, requireTenantSlug } from '@opengraphity/web-core'

/**
 * `VITE_TENANT_SLUG` override first (plain `localhost:5174` in dev), else the
 * hostname (`portal.c-one.localhost` → "c-one", `c-one.localhost` → "c-one").
 */
export function getTenantSlug(): string {
  return requireTenantSlug({
    hostname: window.location.hostname,
    override: import.meta.env['VITE_TENANT_SLUG'] as string | undefined,
    hint:     'portal.c-one.localhost',
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
