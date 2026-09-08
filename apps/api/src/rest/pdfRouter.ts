/**
 * Factory for the `GET /api/<entity>/:id/pdf` audit-dossier routes. The
 * incident/change/problem routers were three identical copies differing only
 * in entity name (A-23); each is now one `makePdfRouter` call.
 */
import { Router, type Router as ExpressRouter } from 'express'
import { getSession, type Queryable } from '@opengraphity/neo4j'
import { authMiddleware } from '../middleware/auth.js'
import { logger } from '../lib/logger.js'
import { audit } from '../lib/audit.js'
import { NotFoundError } from '../lib/errors.js'
import type { PdfMeta } from '../lib/pdf/common.js'
import type { GraphQLContext } from '../context.js'

export interface PdfRouteSpec<D> {
  /** Express path, e.g. `/incidents/:id/pdf`. */
  path:     string
  /** Audit entity label (`Incident`); also drives the audit action and log prefix. */
  entity:   'Incident' | 'Change' | 'Problem'
  loader:   (session: Queryable, id: string, tenantId: string) => Promise<D>
  builder:  (dossier: D, meta: PdfMeta) => Promise<Buffer>
  /** Download filename without extension (number/code, falling back to id). */
  filename: (dossier: D) => string
}

export function makePdfRouter<D>(spec: PdfRouteSpec<D>): ExpressRouter {
  const router: ExpressRouter = Router()
  const kind = spec.entity.toLowerCase()   // incident | change | problem
  const logTag = `[${kind}-pdf]`

  // Generates the full audit dossier as PDF (Bearer user auth).
  router.get(spec.path, authMiddleware, (req, res) => {
    void (async () => {
      const { tenantId, userId, email, role } = req.user!
      const { id } = req.params

      const session = getSession(undefined, 'READ')
      try {
        const dossier = await spec.loader(session, id, tenantId)
        const pdf = await spec.builder(dossier, {
          generatedAt: new Date().toISOString(),
          generatedBy: email,
          tenantId,
        })

        const filename = `${spec.filename(dossier)}.pdf`
        res.setHeader('Content-Type', 'application/pdf')
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
        res.send(pdf)

        const ctx: GraphQLContext = { tenantId, userId, userEmail: email, role: role as GraphQLContext['role'] }
        void audit(ctx, `${kind}.pdf_exported`, spec.entity, id)
        logger.info({ id, tenantId, sizeBytes: pdf.length }, `${logTag} exported`)
      } catch (err) {
        if (err instanceof NotFoundError) {
          res.status(404).json({ error: `${spec.entity} not found` })
          return
        }
        logger.error({ err, id, tenantId }, `${logTag} generation failed`)
        res.status(500).json({ error: 'Failed to generate PDF' })
      } finally {
        await session.close()
      }
    })()
  })

  return router
}
