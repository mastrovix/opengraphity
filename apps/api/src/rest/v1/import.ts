/**
 * REST v1 — historical data importer.
 *
 *   POST /api/v1/import/incidents?dryRun=true|false     (permission: incidents:write)
 *   POST /api/v1/import/kb-articles?dryRun=true|false   (permission: kb:write)
 *
 * Both accept multipart/form-data with a `file` field containing the CSV
 * (max 20MB). The response is the ImportResult JSON at the top level:
 *   { totalRows, created, updated, errors: [{row, externalId, message}], warnings: [...] }
 *
 * Errors: malformed upload/CSV → ValidationError (400) via rest/errorHandler.ts;
 * anything else → 500 with the full error in the log.
 */
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import Busboy from 'busboy'
import { requirePermission } from '../../middleware/apiKeyAuth.js'
import { ValidationError } from '../../lib/errors.js'
import { asyncHandler } from '../errorHandler.js'
import { apiKeyOf } from '../apiContext.js'
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

function makeImportHandler(importer: Importer) {
  return asyncHandler(async (req: Request, res: Response) => {
    const upload = await readCsvUpload(req)
    if (!upload.ok) throw new ValidationError(upload.message)

    let rows: CsvRow[]
    try {
      rows = parseCsv(upload.content)
    } catch (err) {
      throw new ValidationError(`CSV non valido: ${err instanceof Error ? err.message : 'parse error'}`)
    }
    if (rows.length === 0) {
      throw new ValidationError('Il CSV non contiene righe dati (serve una riga di intestazione + almeno una riga)')
    }

    const dryRun = String(req.query['dryRun'] ?? '').toLowerCase() === 'true'
    const key = apiKeyOf(req)
    const ctx: ServiceCtx = { tenantId: key.tenantId, userId: key.keyId }

    // ValidationError from the importer → 400; anything else → 500 (error middleware)
    const result = await importer(rows, ctx, { dryRun })
    res.json(result)
  })
}

// POST /api/v1/import/incidents
router.post('/incidents', requirePermission('incidents:write'), makeImportHandler(importIncidents))

// POST /api/v1/import/kb-articles
router.post('/kb-articles', requirePermission('kb:write'), makeImportHandler(importKBArticles))

export { router as importRouter }
