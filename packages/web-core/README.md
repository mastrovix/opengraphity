# @opengraphity/web-core

Browser-side foundation shared by `apps/web` (agent UI) and `apps/portal`
(end-user portal): Keycloak bootstrap, tenant resolution, Apollo client link
chain, token refresh, REST helpers, field-rule hooks.

## The rule

**One implementation of auth / tenant / Apollo for web and portal.**
The apps keep only thin wrappers (`apps/*/src/lib/{keycloak,apollo,tokenRefresh}.ts`,
`hooks/useFormFieldRules.ts`) that bind the package to app-specific things:
env variables, the notification surface (sonner toasts vs. portal banners),
i18n strings, the logger. Any fix to session handling, tenant parsing or error
routing goes here, once — never in an app copy. If you find yourself adding
auth logic to an app `lib/`, stop and move it into this package.

## Contents

| Module | Exports | Notes |
|---|---|---|
| `tenantSlug.ts` | `getTenantSlug(host)`, `requireTenantSlug({ hostname, override, hint })` | Pure mirror of `extractTenantFromHost` in `apps/api/src/auth/resolveAuth.ts`. **The two must stay aligned** (same test table in `__tests__/tenantSlug.test.ts` and `apps/api/src/auth/__tests__/resolveAuth.test.ts`): the API cross-checks the token realm against the request host with the same rules. Full IPv4/IPv6 match, no `startsWith('10')`. |
| `keycloak.ts` | `createKeycloak({ url, clientId, resolveRealm })` → `{ initKeycloak, getKeycloak, keycloak }` | PKCE S256, `login-required`, no login iframe, token in memory only. Missing env, unresolvable tenant or unreachable Keycloak → readable `Error` with `cause`, thrown from `initKeycloak()` (not at import) so the app can render it. |
| `tokenRefresh.ts` | `createTokenRefresh({ keycloak, notify, logger, messages?, backoffMs?, intervalMs? })` → `{ refreshToken, isSessionInvalid, forceLogin, startTokenRefreshLoop }` | E-05: shared in-flight refresh; transport errors retry with backoff and a notification, only a dropped session (HTTP 400 → token cleared) redirects to login; `forceLogin` is idempotent and stops the loop. |
| `apollo.ts` | `createApolloClient({ uri, getToken, refreshToken, isSessionInvalid, onSessionInvalid, onNetworkError, onGraphQLError, clientLogger?, defaultOptions?, dedupeMs? })`, `createErrorLink`, `createAuthLink`, `createDeduper` | Apollo Client 4 `ErrorLink`: `UNAUTHORIZED` (matched on `extensions.code`, never on message text) → forced refresh and replay of the same operation with the new bearer; a replay still rejected → `onSessionInvalid`. Other errors are logged (always) and notified (deduped per message / per 5 s). |
| `apiBase.ts` | `createApiBase({ baseUrl, getToken })` → `{ apiUrl(path), authHeader() }`, `apiBaseFromGraphqlUri(uri)` | One convention for REST URLs (`VITE_API_URL` minus `/graphql`) and the bearer header. |
| `attachments.ts` | `createAttachments(api)` → `{ uploadAttachment, downloadAttachment }` | REST `/api/attachments` (bearer header, multipart field order, blob download). |
| `clientLogger.ts` / `logger.ts` | `createClientLogger(api)`, `consoleLogger`, `ClientLogger` | Ships to `POST /api/logs/client`; delivery failures go to `console.warn`, never silently dropped. |
| `useFormFieldRules.ts` / `fieldRules.graphql.ts` | `useFormFieldRules`, `useFieldVisibility`, `useFieldRequirements`, `validateFormFields`, pure `evalVisibility` / `evalRequirements` / `mergeFieldRules`, `GET_FIELD_VISIBILITY_RULES`, `GET_FIELD_REQUIREMENT_RULES` | Same documents and evaluation for both apps; a hidden field is never required. |

Not here on purpose: notifications (`sonner` in web, `notify.ts` banner in
portal) and i18n — the package takes callbacks/messages and stays free of UI
dependencies.

## Wiring (what an app wrapper looks like)

```ts
// lib/keycloak.ts
const handle = createKeycloak({
  url:          import.meta.env['VITE_KEYCLOAK_URL'],
  clientId:     import.meta.env['VITE_KEYCLOAK_CLIENT_ID'],
  resolveRealm: () => requireTenantSlug({ hostname: location.hostname, override: import.meta.env['VITE_TENANT_SLUG'], hint: 'c-one.localhost:5173' }),
})
export const { initKeycloak, getKeycloak, keycloak } = handle

// lib/tokenRefresh.ts
const tr = createTokenRefresh({ keycloak, notify: { error: toast.error, success: toast.success }, logger: clientLogger })

// lib/apollo.ts
export const apolloClient = createApolloClient({
  uri: import.meta.env['VITE_API_URL'] ?? '/graphql',
  getToken: () => keycloak.token,
  refreshToken: () => tr.refreshToken(-1),
  isSessionInvalid: tr.isSessionInvalid,
  onSessionInvalid: tr.forceLogin,
  onNetworkError: () => toast.error('Errore di connessione al server'),
  onGraphQLError: (message) => toast.error(message),
  clientLogger,
})
```

Required env (no defaults, fail-fast at `initKeycloak()`): `VITE_KEYCLOAK_URL`,
`VITE_KEYCLOAK_CLIENT_ID`; optional `VITE_TENANT_SLUG` (override when the host's
first label is not the tenant). `VITE_API_URL` defaults to `/graphql`.

## Build / test

```
pnpm --filter @opengraphity/web-core build   # tsc → dist/ (consumed via package.json "exports")
pnpm --filter @opengraphity/web-core test    # vitest: tenantSlug, apollo error link (mock links), tokenRefresh
```

The apps resolve the package from `dist/`, so build it before `tsc --noEmit`
or `vite build` in `apps/web` / `apps/portal` (`pnpm -r build` orders it
automatically). `apps/portal/Dockerfile` builds the package in the container;
`apps/web` is built locally and its `dist/` copied into the image.

`react`, `@apollo/client`, `graphql`, `keycloak-js` are peer dependencies: the
package must share the app's single instance of each.
