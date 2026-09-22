import type express from 'express'
import type { Permission } from '@opengraphity/types'
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
        permissions: ReadonlySet<Permission>
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
      permissions: ctx.permissions,
    }
  } catch (err) {
    const code = err instanceof GraphQLError ? err.extensions['code'] : null
    if (code === 'UNAUTHORIZED' || code === 'TENANT_SUSPENDED') {
      // Il codice viaggia nel corpo: un tenant sospeso non è un token da
      // rinfrescare, e chi chiama deve poterli distinguere senza leggere la frase.
      res.status(401).json({ error: (err as GraphQLError).message, code })
      return
    }
    // DB outage / corrupt User node is a server error, not an auth failure — surface it as such.
    authLogger.error({ err }, 'Auth resolution failed')
    res.status(500).json({ error: `Auth lookup failed: ${err instanceof Error ? err.message : String(err)}` })
    return
  }
  /*
   * `next()` FUORI DAL try (revisione del 22 set 2026).
   *
   * Stava dentro, e `next()` chiama il middleware successivo in modo
   * sincrono: un'eccezione sincrona lanciata PIÙ AVANTI nella catena
   * risaliva fin qui e finiva in questo `catch`, che la raccontava come
   * «Auth lookup failed» — una frase falsa su un errore che con
   * l'autenticazione non c'entra niente. E se quel middleware aveva già
   * risposto, il `res.status(500)` qui sopra aggiungeva un «Cannot set
   * headers after they are sent» sopra al problema vero.
   *
   * Qui dentro ci sta solo ciò che riguarda l'autenticazione.
   */
  next()
}
