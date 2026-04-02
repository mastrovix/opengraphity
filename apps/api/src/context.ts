import jwt from 'jsonwebtoken'
import type express from 'express'
import { GraphQLError } from 'graphql'
import { getSession } from '@opengraphity/neo4j'
import { verifyKeycloakToken } from './auth/keycloak.js'
import { authLogger } from './lib/logger.js'

const _jwtSecret = process.env['JWT_SECRET']
if (!_jwtSecret) {
  throw new Error(
    'JWT_SECRET environment variable is required. ' +
    'Set it in your .env file or deployment configuration.',
  )
}
const JWT_SECRET: string = _jwtSecret

export interface GraphQLContext {
  tenantId:  string
  userId:    string
  userEmail: string
  role:      'admin' | 'operator' | 'viewer'
}

interface JWTPayload {
  tenant_id: string
  user_id:   string
  email:     string
  role:      'admin' | 'operator' | 'viewer'
}

const ITSM_ROLES = ['admin', 'operator', 'viewer'] as const

/**
 * Extracts the tenant slug from the Host or X-Forwarded-Host header.
 * "c-one.opengrafo.com"  → "c-one"
 * "c-one.localhost:4000" → "c-one"
 * Returns null if there is no subdomain (bare localhost, IP, etc.)
 */
function extractTenantFromHost(req: express.Request): string | null {
  const raw = (req.headers['x-forwarded-host'] ?? req.headers['host'] ?? '') as string
  const host = raw.split(':')[0]!        // strip port
  const first = host.split('.')[0]!

  if (
    first === 'localhost' ||
    first === '127'       ||
    first.startsWith('192') ||
    first.startsWith('10')  ||
    first === ''
  ) {
    return null
  }

  return first
}

async function getUserByEmail(email: string): Promise<{ id: string; tenantId: string; role: string } | null> {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        `MATCH (u:User {email: $email}) RETURN u.id AS id, u.tenant_id AS tenantId, u.role AS role LIMIT 1`,
        { email },
      ),
    )
    if (!result.records.length) return null
    const r = result.records[0]
    return {
      id:       r.get('id')       as string,
      tenantId: r.get('tenantId') as string,
      role:     r.get('role')     as string,
    }
  } finally {
    await session.close()
  }
}

export async function buildContext(req: express.Request): Promise<GraphQLContext> {
  const auth = req.headers.authorization

  if (!auth?.startsWith('Bearer ')) {
    // Allow unauthenticated access for the login mutation
    const body = req.body as { query?: string; operationName?: string }
    const isLogin =
      body?.operationName === 'Login' ||
      (typeof body?.query === 'string' && /\blogin\s*\(/.test(body.query))
    if (isLogin) {
      return { tenantId: '', userId: '', userEmail: '', role: 'viewer' }
    }
    throw new GraphQLError('Unauthorized', { extensions: { code: 'UNAUTHORIZED' } })
  }

  const token = auth.slice(7)

  // Try Keycloak token first
  try {
    const decoded = await verifyKeycloakToken(token)
    const user = await getUserByEmail(decoded.email)

    if (!user) {
      throw new GraphQLError('Unauthorized: user not found', { extensions: { code: 'UNAUTHORIZED' } })
    }

    // Cross-check: token tenant must match the subdomain the request arrived on
    const tenantFromHost = extractTenantFromHost(req)
    if (tenantFromHost && user.tenantId !== tenantFromHost) {
      authLogger.warn(
        { userTenant: user.tenantId, hostTenant: tenantFromHost },
        'Tenant/host mismatch — token rejected',
      )
      throw new GraphQLError('Unauthorized: token/tenant mismatch', { extensions: { code: 'UNAUTHORIZED' } })
    }

    const kcRole = decoded.realm_access?.roles?.find((r) =>
      (ITSM_ROLES as readonly string[]).includes(r),
    ) ?? 'viewer'

    return {
      tenantId:  user.tenantId,
      userId:    user.id,
      userEmail: decoded.email ?? decoded.preferred_username,
      role:      (user.role ?? kcRole) as GraphQLContext['role'],
    }
  } catch (err) {
    authLogger.warn({ err }, 'Keycloak token invalid, trying JWT fallback')
  }

  // Fallback: legacy dev JWT
  try {
    const payload = jwt.verify(token, JWT_SECRET) as JWTPayload
    return {
      tenantId:  payload.tenant_id,
      userId:    payload.user_id,
      userEmail: payload.email,
      role:      payload.role,
    }
  } catch {
    throw new GraphQLError('Invalid token', { extensions: { code: 'UNAUTHORIZED' } })
  }
}
