import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'
import { authLogger as logger } from '../lib/logger.js'

/**
 * Internal Keycloak URL used for server-to-server calls (JWKS fetch).
 * Inside Docker this is http://keycloak:8080; in local dev it equals the public URL.
 */
const KEYCLOAK_INTERNAL_URL = process.env['KEYCLOAK_URL']        ?? 'http://localhost:8080'

/**
 * Public Keycloak URL that browsers use.  Tokens issued to browsers carry this
 * as their `iss` claim.  We must NOT use it for server-side JWKS fetch inside
 * Docker because `localhost` inside a container resolves to the container itself.
 */
const KEYCLOAK_PUBLIC_URL   = process.env['KEYCLOAK_PUBLIC_URL'] ?? KEYCLOAK_INTERNAL_URL

/** Per-issuer JWKS client cache — one entry per tenant */
const clientCache = new Map<string, ReturnType<typeof jwksClient>>()

/**
 * Returns a JWKS client for the given token issuer.
 *
 * The issuer in the token is the PUBLIC URL (browser-visible).  To fetch JWKS
 * inside Docker we replace the public origin with the internal one so the HTTP
 * request stays inside the Docker network.
 */
function getJwksClient(issuer: string): ReturnType<typeof jwksClient> {
  const cached = clientCache.get(issuer)
  if (cached) return cached

  // Swap public origin → internal origin for the JWKS HTTP request.
  // e.g. "http://localhost:8080/realms/c-one" → "http://keycloak:8080/realms/c-one"
  const fetchBase = issuer.replace(KEYCLOAK_PUBLIC_URL, KEYCLOAK_INTERNAL_URL)

  const client = jwksClient({
    jwksUri:         `${fetchBase}/protocol/openid-connect/certs`,
    cache:           true,
    cacheMaxEntries: 10,
    cacheMaxAge:     10 * 60 * 1000, // 10 min
  })
  clientCache.set(issuer, client)
  return client
}

/**
 * Validates that the issuer looks like a Keycloak realm URL.
 * Prevents tokens with arbitrary issuers from being accepted.
 */
function validateIssuer(iss: string): void {
  if (!iss.includes('/realms/')) {
    throw new Error(`Invalid issuer — not a Keycloak realm URL: ${iss}`)
  }
  try {
    new URL(iss)
  } catch {
    throw new Error(`Invalid issuer — not a valid URL: ${iss}`)
  }
}

export interface KeycloakTokenPayload {
  sub:                string
  email:              string
  preferred_username: string
  realm_access:       { roles: string[] }
  iss:                string
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
          resolve(decoded as KeycloakTokenPayload)
        }
      },
    )
  })
}
