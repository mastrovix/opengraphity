import path from 'path'
import fs from 'fs'
import { Router, type Router as ExpressRouter } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { REPORT_PATH_SEGMENT_RE, tenantReportDir } from '../graphql/resolvers/reportExport.js'
import { logger } from '../lib/logger.js'

const router: ExpressRouter = Router()

/**
 * Resolves the on-disk path of an exported report for the caller's tenant.
 * Returns null when the filename is not a plain `<uuid>.<pdf|xlsx>` segment
 * or the resolved path escapes the tenant directory.
 */
export function resolveTenantReportFile(tenantId: string, filename: string): string | null {
  if (!REPORT_PATH_SEGMENT_RE.test(filename) || filename.includes('..')) return null
  if (!/^[0-9a-f-]+\.(pdf|xlsx)$/i.test(filename)) return null
  const dir      = tenantReportDir(tenantId)
  const filePath = path.resolve(dir, filename)
  if (path.dirname(filePath) !== path.resolve(dir)) return null
  return filePath
}

// ── GET /api/reports/:filename ────────────────────────────────────────────────

router.get('/reports/:filename', authMiddleware, (req, res) => {
  const { filename } = req.params
  const { tenantId } = req.user!

  // Files are served ONLY from the caller's own tenant directory.
  const filePath = resolveTenantReportFile(tenantId, filename)
  if (!filePath) {
    res.status(400).json({ error: 'Invalid filename' })
    return
  }
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'File not found' })
    return
  }

  const isPDF  = filename.toLowerCase().endsWith('.pdf')
  const mime   = isPDF ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  const dlName = isPDF ? 'report.pdf' : 'report.xlsx'

  res.setHeader('Content-Type', mime)
  res.setHeader('Content-Disposition', `attachment; filename="${dlName}"`)
  logger.info({ filename, tenantId }, '[report-download] serving file')
  fs.createReadStream(filePath).pipe(res)
})

export { router as reportsRouter }
