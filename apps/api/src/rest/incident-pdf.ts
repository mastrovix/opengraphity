import { Router, type Router as ExpressRouter } from 'express'
import { getSession } from '@opengraphity/neo4j'
import { authMiddleware } from '../middleware/auth.js'
import { logger } from '../lib/logger.js'
import { audit } from '../lib/audit.js'
import { NotFoundError } from '../lib/errors.js'
import { buildIncidentPdf, loadIncidentDossier } from '../lib/incidentPdf.js'
import type { GraphQLContext } from '../context.js'

const router: ExpressRouter = Router()

// ── GET /api/incidents/:id/pdf ────────────────────────────────────────────────
// Generates the full incident audit dossier as PDF (Bearer user auth).

router.get('/incidents/:id/pdf', authMiddleware, (req, res) => {
  void (async () => {
    const { tenantId, userId, email, role } = req.user!
    const { id } = req.params

    const session = getSession(undefined, 'READ')
    try {
      const dossier = await loadIncidentDossier(session, id, tenantId)
      const pdf = await buildIncidentPdf(dossier, {
        generatedAt: new Date().toISOString(),
        generatedBy: email,
        tenantId,
      })

      const filename = `${dossier.incident.number || dossier.incident.id}.pdf`
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      res.send(pdf)

      const ctx: GraphQLContext = { tenantId, userId, userEmail: email, role: role as GraphQLContext['role'] }
      void audit(ctx, 'incident.pdf_exported', 'Incident', id)
      logger.info({ id, tenantId, sizeBytes: pdf.length }, '[incident-pdf] exported')
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.status(404).json({ error: 'Incident not found' })
        return
      }
      logger.error({ err, id, tenantId }, '[incident-pdf] generation failed')
      res.status(500).json({ error: 'Failed to generate PDF' })
    } finally {
      await session.close()
    }
  })()
})

export { router as incidentPdfRouter }
