import fs from 'fs'
import { createWriteStream, existsSync, mkdirSync } from 'fs'
import type { Readable } from 'stream'
import { Router, type Response, type Router as ExpressRouter } from 'express'
import { v4 as uuidv4 } from 'uuid'
import Busboy from 'busboy'
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { authMiddleware } from '../middleware/auth.js'
import { logger } from '../lib/logger.js'
import { config } from '../lib/config.js'
import { ValidationError } from '../lib/errors.js'
import {
  UPLOAD_ROLES,
  entityExistsCypher,
  resolveAttachmentPath,
  safeStoredFilename,
  validateAttachmentTarget,
  type AttachmentTarget,
} from '../lib/attachmentValidation.js'

const router: ExpressRouter = Router()

const ATTACHMENT_DIR = config.attachmentDir

const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/gif',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/x-zip-compressed',
])

const MAX_SIZE_BYTES = 10 * 1024 * 1024 // 10 MB

/** Does the (whitelisted-label) entity exist in this tenant? */
async function entityExists(target: AttachmentTarget, tenantId: string): Promise<boolean> {
  const session = getSession(undefined, 'READ')
  try {
    const row = await runQueryOne<{ id: string }>(session, entityExistsCypher(target.labels), { entityId: target.entityId, tenantId })
    return row !== null
  } finally {
    await session.close()
  }
}

// ── POST /api/attachments ─────────────────────────────────────────────────────
// Expects: multipart/form-data with fields entityType, entityId, [description]
// BEFORE the `file` part (the web client sends them in that order): the file
// stream is only opened once the target has been validated and found.

router.post('/attachments', authMiddleware, (req, res) => {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.includes('multipart/form-data')) {
    res.status(400).json({ error: 'Expected multipart/form-data' })
    return
  }

  const { tenantId, userId, role } = req.user!
  if (!UPLOAD_ROLES.has(role)) {
    res.status(403).json({ error: `Role '${role}' cannot upload attachments` })
    return
  }

  const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_SIZE_BYTES, files: 1, fields: 10 } })

  let entityType    = ''
  let entityId      = ''
  let description   = ''
  let target: AttachmentTarget | null = null
  let fileReceived  = false
  let fileId        = ''
  let savedPath     = ''
  let originalName  = ''
  let mimeType      = ''
  let sizeBytes     = 0
  let sizeLimitHit  = false
  let rejected      = false
  let writeDone: Promise<void> = Promise.resolve()

  /** Single-response guard: busboy keeps emitting after an early 4xx (A-10). */
  const reject = (status: number, message: string): void => {
    rejected = true
    if (res.headersSent) return
    res.status(status).json({ error: message })
  }
  const cleanup = (): void => {
    if (savedPath && existsSync(savedPath)) fs.unlinkSync(savedPath)
  }

  busboy.on('field', (name: string, val: string) => {
    if (name === 'entityType')  entityType  = val
    if (name === 'entityId')    entityId    = val
    if (name === 'description') description = val
  })

  busboy.on('file', (fieldname: string, fileStream: Readable, info: { filename: string; mimeType: string }) => {
    if (rejected || fieldname !== 'file') { fileStream.resume(); return }

    originalName = info.filename
    mimeType     = info.mimeType

    // 1. Validate target and MIME synchronously, before touching the disk.
    try {
      target = validateAttachmentTarget(entityType, entityId)
    } catch (err) {
      fileStream.resume()
      reject(400, err instanceof ValidationError ? err.message : 'Invalid entityType/entityId (send them before the file part)')
      return
    }
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      fileStream.resume()
      reject(400, `File type '${mimeType}' is not allowed`)
      return
    }

    fileId = uuidv4()
    let resolved: { dir: string; file: string }
    try {
      resolved = resolveAttachmentPath(ATTACHMENT_DIR, tenantId, target.entityId, safeStoredFilename(fileId, originalName))
    } catch (err) {
      fileStream.resume()
      reject(400, err instanceof Error ? err.message : 'Invalid attachment path')
      return
    }

    // 2. Existence check is async: hold the stream (backpressure) until the
    //    entity is confirmed in this tenant, then pipe to disk.
    fileStream.pause()
    const t = target
    const { dir, file } = resolved
    writeDone = (async () => {
      const exists = await entityExists(t, tenantId)
      if (!exists) {
        fileStream.resume()
        reject(404, `${t.entityType} ${t.entityId} not found`)
        return
      }
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      savedPath = file
      fileReceived = true

      await new Promise<void>((resolve, reject2) => {
        const writeStream = createWriteStream(savedPath)
        fileStream.on('limit', () => { sizeLimitHit = true })
        fileStream.on('data', (chunk: Buffer) => { sizeBytes += chunk.length })
        writeStream.on('finish', resolve)
        writeStream.on('error', reject2)
        fileStream.on('error', reject2)
        fileStream.pipe(writeStream)
      })
    })().catch((err: unknown) => {
      logger.error({ err, tenantId, entityType, entityId }, '[attachment] upload stream failed')
      fileStream.resume()
      cleanup()
      reject(500, 'Failed to store attachment')
    })
  })

  busboy.on('filesLimit', () => reject(400, 'Only one file per request'))
  busboy.on('error', (err: unknown) => {
    logger.error({ err, tenantId }, '[attachment] multipart parse error')
    cleanup()
    reject(400, 'Malformed multipart body')
  })

  busboy.on('finish', () => {
    void (async () => {
      await writeDone
      if (rejected || res.headersSent) { if (rejected) cleanup(); return }

      if (sizeLimitHit) {
        cleanup()
        reject(400, `File exceeds maximum size of ${MAX_SIZE_BYTES / 1024 / 1024}MB`)
        return
      }

      const tgt = target as AttachmentTarget | null // narrowed copy: `target` is assigned inside a closure
      if (!fileReceived || !tgt) {
        reject(400, 'No file uploaded')
        return
      }

      const now = new Date().toISOString()
      const session = getSession(undefined, 'WRITE')
      try {
        await session.executeWrite((tx) => tx.run(`
          CREATE (a:Attachment {
            id:           $id,
            tenant_id:    $tenantId,
            entity_type:  $entityType,
            entity_id:    $entityId,
            filename:     $filename,
            mime_type:    $mimeType,
            size_bytes:   $sizeBytes,
            storage_path: $storagePath,
            uploaded_by:  $uploadedBy,
            uploaded_at:  $uploadedAt,
            description:  $description
          })
        `, {
          id:          fileId,
          tenantId,
          entityType:  tgt.entityType,
          entityId:    tgt.entityId,
          filename:    originalName,
          mimeType,
          sizeBytes,
          storagePath: savedPath,
          uploadedBy:  userId,
          uploadedAt:  now,
          description: description || null,
        }))

        logger.info({ fileId, tenantId, entityType: tgt.entityType, entityId: tgt.entityId, filename: originalName, sizeBytes }, '[attachment] uploaded')
        res.status(201).json({ id: fileId, filename: originalName, sizeBytes, downloadUrl: `/api/attachments/${fileId}` })
      } catch (err) {
        logger.error({ err }, '[attachment] Neo4j write failed')
        cleanup()
        reject(500, 'Failed to save attachment metadata')
      } finally {
        await session.close()
      }
    })()
  })

  req.pipe(busboy)
})

// ── GET /api/attachments/:id ──────────────────────────────────────────────────

router.get('/attachments/:id', authMiddleware, (req, res: Response) => {
  void (async () => {
    const { tenantId } = req.user!
    const { id }       = req.params

    const session = getSession(undefined, 'READ')
    try {
      const result = await session.executeRead((tx) => tx.run(`
        MATCH (a:Attachment {id: $id, tenant_id: $tenantId})
        RETURN a.storage_path AS storagePath, a.filename AS filename, a.mime_type AS mimeType
      `, { id, tenantId }))

      if (!result.records.length) {
        res.status(404).json({ error: 'Attachment not found' })
        return
      }

      const storagePath = result.records[0].get('storagePath') as string
      const filename    = result.records[0].get('filename')    as string
      const fileMime    = result.records[0].get('mimeType')    as string

      if (!existsSync(storagePath)) {
        res.status(404).json({ error: 'File not found on disk' })
        return
      }

      res.setHeader('Content-Type', fileMime)
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`)
      fs.createReadStream(storagePath).pipe(res)
    } finally {
      await session.close()
    }
  })()
})

export { router as attachmentRouter }
