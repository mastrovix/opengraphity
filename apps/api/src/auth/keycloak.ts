import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'
import { authLogger as logger } from '../lib/logger.js'
import { config } from '../lib/config.js'

/**
 * Internal Keycloak URL used for server-to-server calls (JWKS fetch).
 * Inside Docker this is http://keycloak:8080; in local dev it equals the public URL.
 * (config.keycloakUrl — required in production, no localhost default there.)
 */
const KEYCLOAK_INTERNAL_URL = config.keycloakUrl

/**
 * Public Keycloak URL(s) that browsers use.  Tokens issued to browsers carry the
 * matching origin as their `iss` claim.  Supports a comma-separated list so the
 * same API can serve multiple front-door hosts (e.g. http://localhost:8080 for
 * `c-one.localhost` AND the Tailscale HTTPS host for remote/iPad access).
 * We must NOT use these for server-side JWKS fetch inside Docker because
 * `localhost` inside a container resolves to the container itself.
 */
const KEYCLOAK_PUBLIC_URLS = config.keycloakPublicUrls

/**
 * Per-issuer JWKS client cache — one entry per tenant. Bounded (revisione
 * totale · A-14): the key comes from a token that is not verified yet, so an
 * unbounded map grew with every forged `iss`. The oldest entry goes first.
 */
const clientCache = new Map<string, ReturnType<typeof jwksClient>>()
export const JWKS_CLIENT_CACHE_MAX = 500

/**
 * Returns a JWKS client for the given token issuer.
 *
 * The issuer in the token is a PUBLIC URL (browser-visible).  To fetch JWKS
 * inside Docker we rebuild the URL on the internal origin so the HTTP request
 * stays inside the Docker network, keeping the realm path from the issuer.
 */
function getJwksClient(issuer: string): ReturnType<typeof jwksClient> {
  const cached = clientCache.get(issuer)
  if (cached) return cached

  // Rebuild on internal origin, keep realm path from the issuer.
  // e.g. "http://localhost:8080/realms/c-one" → "http://keycloak:8080/realms/c-one"
  const fetchBase = `${KEYCLOAK_INTERNAL_URL.replace(/\/$/, '')}${new URL(issuer).pathname}`

  const client = jwksClient({
    jwksUri:         `${fetchBase}/protocol/openid-connect/certs`,
    cache:           true,
    cacheMaxEntries: 10,
    cacheMaxAge:     10 * 60 * 1000, // 10 min
  })
  if (clientCache.size >= JWKS_CLIENT_CACHE_MAX) {
    const oldest = clientCache.keys().next().value
    if (oldest !== undefined) clientCache.delete(oldest)
  }
  clientCache.set(issuer, client)
  return client
}

/**
 * Validates that the issuer looks like a Keycloak realm URL.
 * Prevents tokens with arbitrary issuers from being accepted.
 */
// Only these origins may issue tokens. Without this anchor an attacker could
// set `iss` to their own domain, host a matching JWKS, and have the server
// fetch it and accept a forged token (account takeover + SSRF).
const ALLOWED_ISSUER_ORIGINS = new Set(
  [...KEYCLOAK_PUBLIC_URLS, KEYCLOAK_INTERNAL_URL].map((u) => new URL(u).origin),
)

/** Il nome di un realm è lo slug di un'organizzazione: nient'altro arriva al fetch delle chiavi. */
const REALM_PATH_RE = /^\/realms\/[a-z0-9][a-z0-9-]{0,62}\/?$/

function validateIssuer(iss: string): void {
  if (!iss.includes('/realms/')) {
    throw new Error(`Invalid issuer — not a Keycloak realm URL: ${iss}`)
  }
  let origin: string
  try {
    origin = new URL(iss).origin
  } catch {
    throw new Error(`Invalid issuer — not a valid URL: ${iss}`)
  }
  if (!ALLOWED_ISSUER_ORIGINS.has(origin)) {
    throw new Error(`Untrusted token issuer origin: ${origin}`)
  }
  if (!REALM_PATH_RE.test(new URL(iss).pathname)) {
    throw new Error(`Invalid issuer — realm is not an organization slug: ${iss}`)
  }
}

let appClientIds: ReadonlySet<string> | null = null
function allowedClientIds(): ReadonlySet<string> {
  appClientIds ??= new Set(config.keycloakAppClientIds)
  return appClientIds
}

export interface KeycloakTokenPayload {
  sub:                string
  email:              string
  preferred_username: string
  realm_access:       { roles: string[] }
  iss:                string
  /** Il client per cui il token è stato emesso. */
  azp?:               string
}

export async function verifyKeycloakToken(token: string): Promise<KeycloakTokenPayload> {
  // Decode without verification to read the issuer — safe because we verify below
  const unverified = jwt.decode(token) as { iss?: string } | null
  if (!unverified?.iss) {
    throw new Error('Token missing issuer claim')
  }

  const iss = unverified.iss
  validateIssuer(iss)

  const client = getJwksClient(iss)

  function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
    client.getSigningKey(header.kid!, (err, key) => {
      callback(err, key?.getPublicKey())
    })
  }

  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      {
        algorithms: ['RS256'],
        issuer:     iss,
      },
      (err, decoded) => {
        if (err) {
          logger.error({ err: err.message }, 'verify error')
          reject(err)
        } else {
          const payload = decoded as KeycloakTokenPayload
          const allowed = allowedClientIds()
          if (!payload.azp || !allowed.has(payload.azp)) {
            reject(new Error(`Token issued for client ${JSON.stringify(payload.azp ?? null)}, not for an OpenGrafo app (${[...allowed].join(', ')})`))
            return
          }
          resolve(payload)
        }
      },
    )
  })
}
