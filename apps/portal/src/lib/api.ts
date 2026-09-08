/**
 * REST base URL + bearer header + remote client logger for the portal.
 * `VITE_API_URL` is the GraphQL endpoint; REST routes (`/api/...`) share its
 * origin. Same convention as apps/web (`lib/apiBase.ts`, `lib/clientLogger.ts`).
 */
import { apiBaseFromGraphqlUri, createApiBase, createClientLogger } from '@opengraphity/web-core'
import { keycloak } from './keycloak'

export const GRAPHQL_URI: string = (import.meta.env['VITE_API_URL'] as string | undefined) ?? '/graphql'

export const api = createApiBase({
  baseUrl:  apiBaseFromGraphqlUri(GRAPHQL_URI),
  getToken: () => keycloak.token,
})

export const apiUrl     = api.apiUrl
export const authHeader = api.authHeader

/** Ships error/warn/info to `POST /api/logs/client` (tenant Logs page), like the web app. */
export const clientLogger = createClientLogger(api)
