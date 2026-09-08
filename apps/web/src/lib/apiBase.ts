/**
 * ONE convention for the REST base URL and the bearer header (E-18/E-22).
 *
 * `VITE_API_URL` points at the GraphQL endpoint (e.g. `https://api.host/graphql`);
 * every REST route (`/api/…`) lives on the same origin, so the base is that URL
 * without the `/graphql` suffix. Unset → relative paths (nginx proxies `/api`).
 *
 * The implementation (`createApiBase`) is shared with apps/portal through
 * `@opengraphity/web-core`; this file only wires the app's env and token source.
 *
 * The token comes from Keycloak only — there is no localStorage fallback:
 * the legacy `og_token` path was dead code that "authorised" persisting the
 * token in the browser; it is gone.
 */
import { createApiBase, apiBaseFromGraphqlUri } from '@opengraphity/web-core'
import { keycloak } from './keycloak'

const RAW = import.meta.env['VITE_API_URL'] as string | undefined

export const apiBase = createApiBase({
  baseUrl:  apiBaseFromGraphqlUri(RAW ?? ''),
  getToken: () => keycloak.token,
})

export const API_BASE: string = apiBase.baseUrl

/** Absolute URL for a REST path (`apiUrl('/api/sse')`); throws if `path` does not start with `/`. */
export const apiUrl = apiBase.apiUrl

/** `Authorization: Bearer …` from the live Keycloak token (empty when logged out). */
export const authHeader = apiBase.authHeader
