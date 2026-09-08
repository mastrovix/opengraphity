/**
 * Tenant slug from a hostname.
 *
 * MUST STAY ALIGNED with `extractTenantFromHost` in
 * `apps/api/src/auth/resolveAuth.ts` (and its test cases in
 * `apps/api/src/auth/__tests__/resolveAuth.test.ts`): the API derives the
 * tenant from the `Host` / `X-Forwarded-Host` header with the same rules and
 * rejects a token whose realm differs from it. If the two functions diverge,
 * the browser picks realm A while the API expects tenant B and every request
 * fails with "Unauthorized: token/tenant mismatch".
 *
 * The API package is Node-only (Neo4j, Express) and cannot be imported from
 * the browser, hence the copy. The test file next to this module carries the
 * same table as the API test.
 */

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
// Bracketed IPv6 literal as it appears in a Host header or in
// `location.hostname`: "[::1]", "[::1]:4000", "[fe80::1%25en0]" (zone id) —
// anything in brackets is an address, never a slug
const IPV6_RE = /^\[[^\]]+\](?::\d+)?$/

/**
 * "c-one.opengrafo.com"        → "c-one"
 * "c-one.localhost:4000"       → "c-one"
 * "portal.c-one.localhost"     → "c-one"   (portal prefix skipped)
 * "localhost", "127.0.0.1:80",
 * "192.168.1.5", "[::1]:4000"  → null      (no subdomain → no tenant)
 * A slug like "10x-labs" or "192corp" is a real tenant, not an IP: the IP
 * check is a full IPv4 match, never a `startsWith('10')`.
 */
export function getTenantSlug(hostHeader: string): string | null {
  // A chain of proxies may append values: keep the first (the client-facing host)
  const raw = hostHeader.split(',')[0]!.trim()
  if (raw === '' || IPV6_RE.test(raw)) return null

  const host = raw.split(':')[0]!        // strip port
  if (host === 'localhost' || IPV4_RE.test(host)) return null

  const parts = host.split('.')
  const first = parts[0]!
  if (first === '') return null

  // portal.c-one.localhost → tenant is the second segment, not "portal"
  if (first === 'portal' && parts.length >= 3) return parts[1]!

  return first
}

export interface RequireTenantSlugOptions {
  /** Usually `window.location.hostname`. */
  hostname: string
  /**
   * Explicit override (`VITE_TENANT_SLUG`): wins over the hostname. Used when
   * the app is served on a host whose first label is not the tenant (Tailscale
   * MagicDNS, plain `localhost:5174` in dev). Empty string counts as unset.
   */
  override?: string | undefined
  /** Example host shown in the error, e.g. `c-one.localhost:5173`. */
  hint: string
}

/**
 * Tenant slug for the running app, or a readable error. Never returns a
 * made-up default: without a tenant the Keycloak realm cannot be chosen.
 */
export function requireTenantSlug(opts: RequireTenantSlugOptions): string {
  if (opts.override) return opts.override
  const slug = getTenantSlug(opts.hostname)
  if (slug) return slug
  throw new Error(
    `Nessun tenant nel sottodominio ("${opts.hostname}"). ` +
    `Accedi tramite: ${opts.hint} oppure imposta VITE_TENANT_SLUG.`,
  )
}
