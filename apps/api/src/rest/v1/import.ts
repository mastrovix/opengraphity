/**
 * REST v1 — historical data importer.
 *
 *   POST /api/v1/import/incidents?dryRun=true|false     (permission: incidents:write)
 *   POST /api/v1/import/kb-articles?dryRun=true|false   (permission: kb:write)
 *
 * Both accept multipart/form-data with a `file` field containing the CSV
 * (max 20MB). The response is the ImportResult JSON at the top level:
 *   { totalRows, created, updated, errors: [{row, externalId, message}], warnings: [...] }
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import Busboy from 'busboy'
import { GraphQLError } from 'graphql'
import { requirePermission } from '../../middleware/apiKeyAuth.js'
import { logger } from '../../lib/logger.js'
import {
  parseCsv,
  importIncidents,
  importKBArticles,
  type CsvRow,
  type ImportResult,
  type ServiceCtx,
} from '../../services/ticketImportService.js'

const router: ExpressRouter = Router()

const MAX_SIZE_BYTES = 20 * 1024 * 1024 // 20 MB

// ── Multipart helper ──────────────────────────────────────────────────────────

interface UploadOk    { ok: true;  content: string }
interface UploadError { ok: false; status: number; message: string }

function readCsvUpload(req: Request): Promise<UploadOk | UploadError> {
  return new Promise((resolve) => {
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.includes('multipart/form-data')) {
      resolve({ ok: false, status: 400, message: 'Expected multipart/form-data with a "file" field' })
      return
    }

    let busboy: Busboy.Busboy
    try {
      busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_SIZE_BYTES, files: 1 } })
    } catch (err) {
      resolve({ ok: false, status: 400, message: err instanceof Error ? err.message : 'Malformed multipart request' })
      return
    }

    const chunks: Buffer[] = []
    let fileReceived = false
    let sizeLimitHit = false
    let settled      = false

    const settle = (value: UploadOk | UploadError) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    busboy.on('file', (fieldname: string, fileStream: NodeJS.ReadableStream) => {
      if (fieldname !== 'file') { fileStream.resume(); return }
      fileReceived = true
      fileStream.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      fileStream.on('limit', () => {
        sizeLimitHit = true
        fileStream.resume()
      })
    })

    busboy.on('error', (err: unknown) => {
      settle({ ok: false, status: 400, message: err instanceof Error ? err.message : 'Malformed multipart request' })
    })

    busboy.on('finish', () => {
      if (sizeLimitHit) {
        settle({ ok: false, status: 400, message: `File exceeds maximum size of ${MAX_SIZE_BYTES / 1024 / 1024}MB` })
        return
      }
      if (!fileReceived) {
        settle({ ok: false, status: 400, message: 'No file uploaded — expected a "file" multipart field' })
        return
      }
      settle({ ok: true, content: Buffer.concat(chunks).toString('utf-8') })
    })

    req.pipe(busboy)
  })
}

// ── Shared handler ────────────────────────────────────────────────────────────

type Importer = (rows: CsvRow[], ctx: ServiceCtx, opts: { dryRun: boolean }) => Promise<ImportResult>

function makeImportHandler(label: string, importer: Importer) {
  return (req: Request, res: Response) => {
    void (async () => {
      const upload = await readCsvUpload(req)
      if (!upload.ok) {
        res.status(upload.status).json({ error: { code: 'VALIDATION_ERROR', message: upload.message } })
        return
      }

      let rows: CsvRow[]
      try {
        rows = parseCsv(upload.content)
      } catch (err) {
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: `CSV non valido: ${err instanceof Error ? err.message : 'parse error'}` } })
        return
      }
      if (rows.length === 0) {
        res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Il CSV non contiene righe dati (serve una riga di intestazione + almeno una riga)' } })
        return
      }

      const dryRun = String(req.query['dryRun'] ?? '').toLowerCase() === 'true'
      const ctx: ServiceCtx = { tenantId: req.apiKey!.tenantId, userId: req.apiKey!.keyId }

      try {
        const result = await importer(rows, ctx, { dryRun })
        res.json(result)
      } catch (err) {
        // ValidationError (lib/errors.js) → 400 with detail; anything else → 500
        if (err instanceof GraphQLError && err.extensions?.['code'] === 'BAD_USER_INPUT') {
          res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.message } })
          return
        }
        logger.error({ err: err instanceof Error ? err.message : err, label }, '[import] import failed')
        if (!res.headersSent) {
          res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'Error' } })
        }
      }
    })()
  }
}

// POST /api/v1/import/incidents
router.post('/incidents', requirePermission('incidents:write'), makeImportHandler('incidents', importIncidents))

// POST /api/v1/import/kb-articles
router.post('/kb-articles', requirePermission('kb:write'), makeImportHandler('kb-articles', importKBArticles))

export { router as importRouter }
