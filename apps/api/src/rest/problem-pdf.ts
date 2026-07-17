import { Router, type Router as ExpressRouter } from 'express'
import { getSession } from '@opengraphity/neo4j'
import { authMiddleware } from '../middleware/auth.js'
import { logger } from '../lib/logger.js'
import { audit } from '../lib/audit.js'
import { NotFoundError } from '../lib/errors.js'
import { buildProblemPdf, loadProblemDossier } from '../lib/problemPdf.js'
import type { GraphQLContext } from '../context.js'

const router: ExpressRouter = Router()

// ── GET /api/problems/:id/pdf ─────────────────────────────────────────────────
// Generates the full problem audit dossier as PDF (Bearer user auth).

router.get('/problems/:id/pdf', authMiddleware, (req, res) => {
  void (async () => {
    const { tenantId, userId, email, role } = req.user!
    const { id } = req.params

    const session = getSession(undefined, 'READ')
    try {
      const dossier = await loadProblemDossier(session, id, tenantId)
      const pdf = await buildProblemPdf(dossier, {
        generatedAt: new Date().toISOString(),
        generatedBy: email,
        tenantId,
      })

      const filename = `${dossier.problem.number || dossier.problem.id}.pdf`
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      res.send(pdf)

      const ctx: GraphQLContext = { tenantId, userId, userEmail: email, role: role as GraphQLContext['role'] }
      void audit(ctx, 'problem.pdf_exported', 'Problem', id)
      logger.info({ id, tenantId, sizeBytes: pdf.length }, '[problem-pdf] exported')
    } catch (err) {
      if (err instanceof NotFoundError) {
        res.status(404).json({ error: 'Problem not found' })
        return
      }
      logger.error({ err, id, tenantId }, '[problem-pdf] generation failed')
      res.status(500).json({ error: 'Failed to generate PDF' })
    } finally {
      await session.close()
    }
  })()
})

export { router as problemPdfRouter }
