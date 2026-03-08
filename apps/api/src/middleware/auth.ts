import type express from 'express'
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

export const authMiddleware: express.RequestHandler = (req, res, next) => {
  try {
    const ctx = buildContext(req)
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
