import jwt from 'jsonwebtoken'
import type express from 'express'
import { GraphQLError } from 'graphql'
import { getSession } from '@opengraphity/neo4j'
import { verifyKeycloakToken, type KeycloakTokenPayload } from './keycloak.js'
import { authLogger } from '../lib/logger.js'

/**
 * Single authentication resolver shared by GraphQL (`buildContext`) and the
 * REST `authMiddleware` — A-18. Both paths used to carry their own copy of the
 * user lookup and role mapping, and only GraphQL did the host/tenant
 * cross-check.
 *
 * Tenant binding (A-03 / G-03): the Keycloak realm IS the tenant slug. The
 * realm is read from the verified `iss` claim and the User node is matched on
 * `(email, tenant_id = realm)`, so an identical email created in another realm
 * can never resolve to this tenant's user.
 */

const _jwtSecret = process.env['JWT_SECRET']
if (!_jwtSecret) {
  throw new Error(
    'JWT_SECRET environment variable is required. ' +
    'Set it in your .env file or deployment configuration.',
  )
}
const JWT_SECRET: string = _jwtSecret

export const ROLES = ['admin', 'operator', 'viewer', 'end_user'] as const
export type Role = (typeof ROLES)[number]

export interface GraphQLContext {
  tenantId:  string
  userId:    string
  userEmail: string
  role:      Role
}

interface LegacyJWTPayload {
  tenant_id: string
  user_id:   string
  email:     string
  role:      Role
}

function unauthorized(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'UNAUTHORIZED' } })
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/**
 * Keycloak issuer → realm slug. `http://kc:8080/realms/c-one` → `c-one`.
 * Fails loudly when the issuer carries no realm: the realm is the tenant key,
 * a token without it must never be resolved against the DB.
 */
export function extractRealmFromIssuer(iss: string): string {
  const match = /\/realms\/([^/?#]+)\/?$/.exec(iss)
  if (!match?.[1]) {
    throw unauthorized(`Token issuer carries no Keycloak realm: ${iss}`)
  }
  return decodeURIComponent(match[1])
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/
// Bracketed IPv6 literal as it appears in a Host header: "[::1]", "[::1]:4000",
// "[fe80::1%25en0]" (zone id) — anything in brackets is an address, never a slug
const IPV6_RE = /^\[[^\]]+\](?::\d+)?$/

/**
 * Tenant slug from a Host / X-Forwarded-Host header value (A-25).
 * "c-one.opengrafo.com"        → "c-one"
 * "c-one.localhost:4000"       → "c-one"
 * "portal.c-one.localhost"     → "c-one"   (portal prefix skipped)
 * "localhost", "127.0.0.1:80",
 * "192.168.1.5", "[::1]:4000"  → null      (no subdomain → no cross-check)
 * A slug like "10x-labs" or "192corp" is a real tenant, not an IP.
 */
export function extractTenantFromHost(hostHeader: string): string | null {
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

function hostHeaderOf(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-host']
  const value = forwarded ?? req.headers['host'] ?? ''
  return Array.isArray(value) ? (value[0] ?? '') : value
}

// ── DB lookup ────────────────────────────────────────────────────────────────

interface UserRecord { id: string; role: unknown }

async function findUserInTenant(email: string, tenantId: string): Promise<UserRecord | null> {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (u:User {email: $email, tenant_id: $tenantId}) RETURN u.id AS id, u.role AS role`,
        { email, tenantId },
      ),
    )
    if (result.records.length === 0) return null
    if (result.records.length > 1) {
      // The (tenant_id, email) uniqueness constraint makes this impossible;
      // if it happens the schema was not initialised — never pick one at random.
      throw new Error(`Multiple User nodes for ${email} in tenant ${tenantId}: uniqueness constraint missing`)
    }
    const r = result.records[0]!
    return { id: r.get('id') as string, role: r.get('role') }
  } finally {
    await session.close()
  }
}

function assertRole(role: unknown, userId: string, tenantId: string): Role {
  if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
    // Data integrity error, not an auth failure: never fall back to a default role.
    throw new GraphQLError(
      `User ${userId} in tenant ${tenantId} has no valid role (got ${JSON.stringify(role ?? null)})`,
      { extensions: { code: 'INTERNAL_SERVER_ERROR' } },
    )
  }
  return role as Role
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Resolves a bearer token to the request context.
 * Throws GraphQLError with `extensions.code = 'UNAUTHORIZED'` for every auth
 * rejection; any other error (DB outage, corrupt User node) propagates as-is so
 * callers can report it as a server error rather than a bad credential.
 */
export async function resolveAuth(token: string, req: express.Request): Promise<GraphQLContext> {
  // Only the signature/format verification may fall back to the legacy JWT
  // path: once the token IS a valid Keycloak token, every later failure (user
  // not found, tenant mismatch, DB error) is a real rejection that must
  // propagate — not be masked as "Invalid token".
  let decoded: KeycloakTokenPayload | null = null
  try {
    decoded = await verifyKeycloakToken(token)
  } catch (err) {
    authLogger.warn(
      { reason: err instanceof Error ? err.message : String(err) },
      'Keycloak token verification failed',
    )
  }

  if (decoded) return resolveKeycloak(decoded, req)

  // Legacy dev JWT — trusts tenant_id/role straight from the payload with no
  // DB lookup or host/tenant cross-check. Only for local dev, never production:
  // gated behind an explicit opt-in so a leaked JWT_SECRET can't impersonate.
  if (process.env['ALLOW_LEGACY_JWT'] !== 'true') {
    throw unauthorized('Invalid token')
  }
  let payload: LegacyJWTPayload
  try {
    payload = jwt.verify(token, JWT_SECRET) as LegacyJWTPayload
  } catch (err) {
    authLogger.warn({ reason: err instanceof Error ? err.message : String(err) }, 'Legacy JWT rejected')
    throw unauthorized('Invalid token')
  }
  return {
    tenantId:  payload.tenant_id,
    userId:    payload.user_id,
    userEmail: payload.email,
    role:      payload.role,
  }
}

async function resolveKeycloak(decoded: KeycloakTokenPayload, req: express.Request): Promise<GraphQLContext> {
  const realm = extractRealmFromIssuer(decoded.iss)

  if (!decoded.email) {
    throw unauthorized('Unauthorized: token has no email claim')
  }

  // Cross-check: the realm the token was issued by must match the subdomain
  // the request arrived on. Applies to REST and GraphQL alike; nginx forces
  // X-Forwarded-Host so a client cannot pick the tenant by header.
  const tenantFromHost = extractTenantFromHost(hostHeaderOf(req))
  if (tenantFromHost && tenantFromHost !== realm) {
    authLogger.warn({ realm, hostTenant: tenantFromHost }, 'Tenant/host mismatch — token rejected')
    throw unauthorized('Unauthorized: token/tenant mismatch')
  }

  const user = await findUserInTenant(decoded.email, realm)
  if (!user) {
    throw unauthorized('Unauthorized: user not found')
  }

  return {
    tenantId:  realm,
    userId:    user.id,
    userEmail: decoded.email,
    role:      assertRole(user.role, user.id, realm),
  }
}
