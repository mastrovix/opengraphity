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
   * Explicit override (`VITE_TENANT_SLUG`). Serve quando l'app e servita su un
   * host la cui prima etichetta NON e il tenant (Tailscale MagicDNS, dove
   * `getTenantSlug` restituirebbe `macbook-pro-di-vittorio`; `localhost:5174`
   * in sviluppo). Stringa vuota = non impostato.
   *
   * PRECEDENZA (terza revisione): vince sull'hostname **tranne** sugli host
   * `*.localhost`, dove decide l'hostname.
   *
   * Prima vinceva sempre, e la conseguenza era che un'installazione locale
   * multi-tenant poteva raggiungerne UNO SOLO: il bundle e costruito una volta
   * con lo slug dentro, quindi `c-two.localhost` finiva sul realm `c-one` e
   * Keycloak rifiutava il `redirect_uri`. In produzione gli host sono
   * `<tenant>.opengrafo.com` e non cambia niente — l'override, se impostato,
   * continua a vincere — mentre in locale ogni sottodominio apre il suo
   * tenant, che e il motivo per cui nginx li instrada.
   */
  override?: string | undefined
  /** Example host shown in the error, e.g. `c-one.localhost:5173`. */
  hint: string
}

/**
 * Tenant slug for the running app, or a readable error. Never returns a
 * made-up default: without a tenant the Keycloak realm cannot be chosen.
 */
/** Host di sviluppo locale: `*.localhost`, dove la prima etichetta e il tenant. */
function isLocalhostSubdomain(hostname: string): boolean {
  const host = hostname.split(',')[0]!.trim().split(':')[0]!
  return host.endsWith('.localhost')
}

export function requireTenantSlug(opts: RequireTenantSlugOptions): string {
  const slug = getTenantSlug(opts.hostname)
  // Su `*.localhost` l'hostname ha la precedenza: e l'unico modo di aprire piu
  // di un tenant da un bundle costruito una volta sola (vedi `override`).
  if (slug && isLocalhostSubdomain(opts.hostname)) return slug
  if (opts.override) return opts.override
  if (slug) return slug
  throw new Error(
    `Nessun tenant nel sottodominio ("${opts.hostname}"). ` +
    `Accedi tramite: ${opts.hint} oppure imposta VITE_TENANT_SLUG.`,
  )
}
