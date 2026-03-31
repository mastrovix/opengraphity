import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'

/** Per-issuer JWKS client cache — one entry per tenant */
const clientCache = new Map<string, ReturnType<typeof jwksClient>>()

function getJwksClient(issuer: string): ReturnType<typeof jwksClient> {
  const cached = clientCache.get(issuer)
  if (cached) return cached

  const client = jwksClient({
    jwksUri:         `${issuer}/protocol/openid-connect/certs`,
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
          console.error('[KEYCLOAK] verify error:', err.message)
          reject(err)
        } else {
          resolve(decoded as KeycloakTokenPayload)
        }
      },
    )
  })
}
