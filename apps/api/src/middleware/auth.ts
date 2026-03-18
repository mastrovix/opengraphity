import type express from 'express'
import jwt from 'jsonwebtoken'
import { getSession } from '@opengraphity/neo4j'
import { verifyKeycloakToken } from '../auth/keycloak.js'
import { buildContext } from '../context.js'

// Augment Express Request to carry the resolved auth context
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: {
        tenantId: string
        userId:   string
        email:    string
        role:     string
      }
    }
  }
}

const ITSM_ROLES = ['admin', 'operator', 'viewer'] as const

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

export const authMiddleware: express.RequestHandler = (req, res, next) => {
  void resolveAuth(req, res, next)
}

async function resolveAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const token = req.headers.authorization?.replace('Bearer ', '')

  if (!token) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  // Try Keycloak token first
  try {
    const decoded = await verifyKeycloakToken(token)
    const user = await getUserByEmail(decoded.email)

    const kcRole = decoded.realm_access?.roles?.find((r) =>
      (ITSM_ROLES as readonly string[]).includes(r),
    ) ?? 'viewer'

    req.user = {
      userId:   user?.id       ?? decoded.sub,
      tenantId: user?.tenantId ?? 'tenant-demo',
      email:    decoded.email  ?? decoded.preferred_username,
      role:     user?.role     ?? kcRole,
    }
    next()
    return
  } catch {
    // Not a Keycloak token — fall through to legacy JWT
  }

  // Fallback: legacy dev JWT
  try {
    const ctx = await buildContext(req)
    req.user = {
      tenantId: ctx.tenantId,
      userId:   ctx.userId,
      email:    ctx.userEmail,
      role:     ctx.role,
    }
    next()
  } catch {
    res.status(401).json({ error: 'Unauthorized' })
  }
}
