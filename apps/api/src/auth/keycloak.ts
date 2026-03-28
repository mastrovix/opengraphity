import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'

const KEYCLOAK_URL = process.env['KEYCLOAK_URL']!

/** Per-realm JWKS client cache — one entry per tenant */
const clientCache = new Map<string, ReturnType<typeof jwksClient>>()

function getJwksClient(realm: string): ReturnType<typeof jwksClient> {
  const cached = clientCache.get(realm)
  if (cached) return cached

  const client = jwksClient({
    jwksUri:         `${KEYCLOAK_URL}/realms/${realm}/protocol/openid-connect/certs`,
    cache:           true,
    cacheMaxEntries: 10,
    cacheMaxAge:     10 * 60 * 1000, // 10 min
  })
  clientCache.set(realm, client)
  return client
}

export interface KeycloakTokenPayload {
  sub:                string
  email:              string
  preferred_username: string
  realm_access:       { roles: string[] }
  iss:                string
}

/**
 * Extracts the Keycloak realm from the token issuer claim.
 * "http://keycloak:8080/realms/c-one" → "c-one"
 */
function realmFromIssuer(iss: string): string {
  const match = iss.match(/\/realms\/([^/]+)$/)
  if (!match?.[1]) throw new Error(`Cannot extract realm from issuer: ${iss}`)
  return match[1]
}

export async function verifyKeycloakToken(token: string): Promise<KeycloakTokenPayload> {
  // Decode without verification to read the issuer — safe because we verify below
  const unverified = jwt.decode(token) as { iss?: string } | null
  if (!unverified?.iss) {
    throw new Error('Token missing issuer claim')
  }

  const realm  = realmFromIssuer(unverified.iss)
  const client = getJwksClient(realm)

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
        issuer:     `${KEYCLOAK_URL}/realms/${realm}`,
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
