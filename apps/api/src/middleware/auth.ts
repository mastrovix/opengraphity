import type express from 'express'
import { GraphQLError } from 'graphql'
import { authLogger } from '../lib/logger.js'
import { resolveAuth } from '../auth/resolveAuth.js'

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

export const authMiddleware: express.RequestHandler = (req, res, next) => {
  void handle(req, res, next)
}

async function handle(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  try {
    // Same resolver as GraphQL: realm-bound user lookup + host/tenant cross-check
    const ctx = await resolveAuth(auth.slice(7), req)
    req.user = {
      tenantId: ctx.tenantId,
      userId:   ctx.userId,
      email:    ctx.userEmail,
      role:     ctx.role,
    }
    next()
  } catch (err) {
    if (err instanceof GraphQLError && err.extensions['code'] === 'UNAUTHORIZED') {
      res.status(401).json({ error: err.message })
      return
    }
    // DB outage / corrupt User node is a server error, not an auth failure — surface it as such.
    authLogger.error({ err }, 'Auth resolution failed')
    res.status(500).json({ error: `Auth lookup failed: ${err instanceof Error ? err.message : String(err)}` })
  }
}
