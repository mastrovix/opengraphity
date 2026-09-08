/**
 * Outbound URL guard (SSRF protection) — single implementation shared by
 * apps/api, @opengraphity/workflow and @opengraphity/notifications.
 *
 * It lives in @opengraphity/events because that package is the leaf every
 * fetch-capable package already depends on (workflow → events, notifications →
 * events, api → events). It has no GraphQL dependency, so it throws its own
 * `UnsafeUrlError`; apps/api wraps it into `ValidationError` (lib/safeUrl.ts).
 *
 * Rules (fail-loud, no silent fallback):
 *   - only http: / https: (https mandatory unless NODE_ENV=development, or as
 *     overridden via `requireHttps`)
 *   - no credentials in the URL (user:pass@host)
 *   - no `localhost` / `*.localhost`
 *   - no IPv4 literal in a private / loopback / link-local / CGNAT / reserved
 *     range — the WHATWG URL parser already canonicalises decimal, octal, hex
 *     and shorthand notations (2130706433, 0177.0.0.1, 0x7f.1 → 127.0.0.1)
 *   - no IPv6 loopback / unspecified / unique-local / link-local, and no
 *     IPv4-mapped / IPv4-compatible / NAT64 / 6to4 form wrapping a blocked v4
 *   - async variant: the hostname is resolved (`dns.lookup`, all addresses)
 *     and EVERY address must pass the same checks (DNS-rebinding aware
 *     callers should still pin the address, but this closes the obvious hole).
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class UnsafeUrlError extends Error {
  readonly code = 'UNSAFE_URL'
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

export interface ResolvedAddress { address: string; family: number }

export interface SafeUrlOptions {
  /**
   * Require https. Default: `process.env.NODE_ENV !== 'development'` — the
   * single policy point; do not re-derive it at call sites.
   */
  requireHttps?: boolean
  /** DNS resolver override (tests). Defaults to `dns.promises.lookup(host, { all: true })`. */
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>
}

export function httpsRequiredByPolicy(): boolean {
  return process.env['NODE_ENV'] !== 'development'
}

// ── IPv4 ─────────────────────────────────────────────────────────────────────

/** Blocked IPv4 ranges as [network, prefixLength]. */
const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 8],  // 0.0.0.0/8      "this" network (0.0.0.0 binds to all interfaces)
  [0x0a000000, 8],  // 10.0.0.0/8     private
  [0x64400000, 10], // 100.64.0.0/10  CGNAT / shared address space
  [0x7f000000, 8],  // 127.0.0.0/8    loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (cloud metadata lives here)
  [0xac100000, 12], // 172.16.0.0/12  private
  [0xc0000000, 24], // 192.0.0.0/24   IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24   TEST-NET-1
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xc6120000, 15], // 198.18.0.0/15  benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 4],  // 224.0.0.0/4    multicast
  [0xf0000000, 4],  // 240.0.0.0/4    reserved + 255.255.255.255 broadcast
]

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const b = Number(p)
    if (b > 255) return null
    n = (n * 256) + b
  }
  return n
}

function isBlockedV4Int(n: number): boolean {
  return BLOCKED_V4.some(([net, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
    return ((n & mask) >>> 0) === net
  })
}

// ── IPv6 ─────────────────────────────────────────────────────────────────────

/** Expands an IPv6 literal into 8 16-bit groups. Returns null if malformed. */
function expandV6(ip: string): number[] | null {
  let s = ip
  // Embedded IPv4 tail (::ffff:127.0.0.1) → convert to two hex groups.
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = v4ToInt(tail)
    if (v4 === null) return null
    s = `${s.slice(0, lastColon + 1)}${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 1 && missing !== 0) return null
  if (halves.length === 2 && missing < 1) return null
  const groups = [...head, ...(halves.length === 2 ? new Array<string>(missing).fill('0') : []), ...rest]
  if (groups.length !== 8) return null
  const out: number[] = []
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    out.push(parseInt(g, 16))
  }
  return out
}

function isBlockedV6(ip: string): boolean {
  const g = expandV6(ip)
  if (!g) return true // unparsable literal → refuse rather than guess
  const allZeroUpTo = (n: number) => g.slice(0, n).every((x) => x === 0)
  const v4FromTail = () => ((g[6]! << 16) | g[7]!) >>> 0

  if (allZeroUpTo(8)) return true                                   // :: unspecified
  if (allZeroUpTo(7) && g[7] === 1) return true                     // ::1 loopback
  if ((g[0]! & 0xfe00) === 0xfc00) return true                      // fc00::/7 unique-local
  if ((g[0]! & 0xffc0) === 0xfe80) return true                      // fe80::/10 link-local
  if ((g[0]! & 0xff00) === 0xff00) return true                      // ff00::/8 multicast
  if (allZeroUpTo(5) && g[5] === 0xffff) return isBlockedV4Int(v4FromTail()) // ::ffff:a.b.c.d mapped
  if (allZeroUpTo(6)) return isBlockedV4Int(v4FromTail())           // ::a.b.c.d compatible (deprecated)
  if (g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return isBlockedV4Int(v4FromTail())                             // 64:ff9b::/96 NAT64
  }
  if (g[0] === 0x2002) return isBlockedV4Int(((g[1]! << 16) | g[2]!) >>> 0) // 2002::/16 6to4
  return false
}

// ── Public API ───────────────────────────────────────────────────────────────

/** True when the literal IP (v4 or v6, no brackets) must not be contacted. */
export function isBlockedIpAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const n = v4ToInt(address)
    return n === null ? true : isBlockedV4Int(n)
  }
  if (family === 6) return isBlockedV6(address)
  return true // not an IP literal at all
}

function describe(u: URL): string {
  return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}`
}

/**
 * Synchronous checks (scheme, credentials, literal host). Does NOT resolve
 * DNS — use `assertSafeOutboundUrl` before actually fetching.
 */
export function assertSafeOutboundUrlSync(raw: string, opts: SafeUrlOptions = {}): URL {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new UnsafeUrlError('Outbound URL is empty')
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new UnsafeUrlError(`Outbound URL is not a valid absolute URL: ${raw}`)
  }

  const requireHttps = opts.requireHttps ?? httpsRequiredByPolicy()
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UnsafeUrlError(`Outbound URL scheme "${parsed.protocol}" is not allowed (only http/https): ${describe(parsed)}`)
  }
  if (requireHttps && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError(`Outbound URL must use https (NODE_ENV=${process.env['NODE_ENV'] ?? 'unset'}): ${describe(parsed)}`)
  }
  if (parsed.username || parsed.password) {
    throw new UnsafeUrlError(`Outbound URL must not embed credentials: ${describe(parsed)}`)
  }

  const host = parsed.hostname.toLowerCase()
  if (host === '') throw new UnsafeUrlError(`Outbound URL has no host: ${raw}`)
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new UnsafeUrlError(`Outbound URL host "${host}" is not allowed (loopback)`)
  }

  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (isIP(literal) !== 0 && isBlockedIpAddress(literal)) {
    throw new UnsafeUrlError(`Outbound URL host ${host} is a private/loopback/link-local address — blocked (SSRF)`)
  }
  return parsed
}

/**
 * Full check: sync rules + DNS resolution of the hostname. Every resolved
 * address must be public; a hostname that does not resolve is an error too
 * (a fetch to it would fail anyway — fail here with a clear message).
 */
export async function assertSafeOutboundUrl(raw: string, opts: SafeUrlOptions = {}): Promise<URL> {
  const parsed = assertSafeOutboundUrlSync(raw, opts)
  const host = parsed.hostname.toLowerCase()
  const literal = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
  if (isIP(literal) !== 0) return parsed // literal already validated

  const lookup = opts.lookup ?? defaultLookup
  let addresses: ResolvedAddress[]
  try {
    addresses = await lookup(host)
  } catch (err) {
    throw new UnsafeUrlError(`Outbound URL host "${host}" does not resolve: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (addresses.length === 0) {
    throw new UnsafeUrlError(`Outbound URL host "${host}" resolved to no addresses`)
  }
  for (const a of addresses) {
    if (isBlockedIpAddress(a.address)) {
      throw new UnsafeUrlError(`Outbound URL host "${host}" resolves to ${a.address}, a private/loopback/link-local address — blocked (SSRF)`)
    }
  }
  return parsed
}

async function defaultLookup(hostname: string): Promise<ResolvedAddress[]> {
  const res = await dnsLookup(hostname, { all: true })
  return res.map((r) => ({ address: r.address, family: r.family }))
}

/** `host[:port]` only — safe to log (Slack/Teams URLs carry tokens in the path). */
export function loggableUrl(raw: string): string {
  try { return new URL(raw).host } catch { return '<invalid-url>' }
}
