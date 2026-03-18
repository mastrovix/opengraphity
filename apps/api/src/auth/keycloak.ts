import jwt from 'jsonwebtoken'
import jwksClient from 'jwks-rsa'

const client = jwksClient({
  jwksUri: `${process.env['KEYCLOAK_URL']}/realms/${process.env['KEYCLOAK_REALM']}/protocol/openid-connect/certs`,
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 10 * 60 * 1000, // 10 min
})

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback) {
  client.getSigningKey(header.kid!, (err, key) => {
    callback(err, key?.getPublicKey())
  })
}

export interface KeycloakTokenPayload {
  sub: string
  email: string
  preferred_username: string
  realm_access: { roles: string[] }
}

export async function verifyKeycloakToken(token: string): Promise<KeycloakTokenPayload> {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      {
        algorithms: ['RS256'],
        issuer: `${process.env['KEYCLOAK_URL']}/realms/${process.env['KEYCLOAK_REALM']}`,
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
