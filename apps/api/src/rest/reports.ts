import path from 'path'
import fs from 'fs'
import { Router, type Router as ExpressRouter } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { REPORT_DIR } from '../graphql/resolvers/reportExport.js'
import { logger } from '../lib/logger.js'

const router: ExpressRouter = Router()

// ── GET /api/reports/:filename ────────────────────────────────────────────────

router.get('/reports/:filename', authMiddleware, (req, res) => {
  const { filename } = req.params

  // Sanitize: only allow UUID-based filenames (no path traversal)
  if (!/^[0-9a-f-]+\.(pdf|xlsx)$/i.test(filename)) {
    res.status(400).json({ error: 'Invalid filename' })
    return
  }

  const filePath = path.join(REPORT_DIR, filename)
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'File not found' })
    return
  }

  const isPDF  = filename.endsWith('.pdf')
  const mime   = isPDF ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  const dlName = isPDF ? 'report.pdf' : 'report.xlsx'

  res.setHeader('Content-Type', mime)
  res.setHeader('Content-Disposition', `attachment; filename="${dlName}"`)
  logger.info({ filename }, '[report-download] serving file')
  fs.createReadStream(filePath).pipe(res)
})

export { router as reportsRouter }
