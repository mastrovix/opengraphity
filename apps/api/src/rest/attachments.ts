import path from 'path'
import fs from 'fs'
import { createWriteStream, existsSync, mkdirSync } from 'fs'
import { Router, type Router as ExpressRouter } from 'express'
import { v4 as uuidv4 } from 'uuid'
import Busboy from 'busboy'
import { getSession } from '@opengraphity/neo4j'
import { authMiddleware } from '../middleware/auth.js'
import { logger } from '../lib/logger.js'

const router: ExpressRouter = Router()

const ATTACHMENT_DIR = process.env['ATTACHMENT_DIR'] ?? path.resolve('./data/attachments')

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

// ── POST /api/attachments ─────────────────────────────────────────────────────
// Expects: multipart/form-data with fields: file, entityType, entityId, description

router.post('/attachments', authMiddleware, (req, res) => {
  void (async () => {
    const contentType = req.headers['content-type'] ?? ''
    if (!contentType.includes('multipart/form-data')) {
      res.status(400).json({ error: 'Expected multipart/form-data' })
      return
    }

    const { tenantId, userId } = req.user!

    const busboy = Busboy({ headers: req.headers, limits: { fileSize: MAX_SIZE_BYTES } })

    let entityType    = ''
    let entityId      = ''
    let description   = ''
    let fileReceived  = false
    let fileId        = ''
    let savedPath     = ''
    let originalName  = ''
    let mimeType      = ''
    let sizeBytes     = 0
    let sizeLimitHit  = false

    busboy.on('field', (name: string, val: string) => {
      if (name === 'entityType')  entityType  = val
      if (name === 'entityId')    entityId    = val
      if (name === 'description') description = val
    })

    busboy.on('file', (fieldname: string, fileStream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
      if (fieldname !== 'file') { fileStream.resume(); return }

      originalName = info.filename
      mimeType     = info.mimeType

      if (!ALLOWED_MIME_TYPES.has(mimeType)) {
        fileStream.resume()
        res.status(400).json({ error: `File type '${mimeType}' is not allowed` })
        return
      }

      fileId = uuidv4()
      const tenantDir = path.join(ATTACHMENT_DIR, tenantId, entityId)
      if (!existsSync(tenantDir)) mkdirSync(tenantDir, { recursive: true })

      const safeFilename = `${fileId}_${path.basename(originalName)}`
      savedPath = path.join(tenantDir, safeFilename)

      const writeStream = createWriteStream(savedPath)
      fileStream.pipe(writeStream)
      fileReceived = true

      fileStream.on('limit', () => {
        sizeLimitHit = true
        fileStream.resume()
      })

      fileStream.on('data', (chunk: Buffer) => {
        sizeBytes += chunk.length
      })
    })

    busboy.on('finish', () => {
      void (async () => {
        if (sizeLimitHit) {
          if (savedPath && existsSync(savedPath)) fs.unlinkSync(savedPath)
          res.status(400).json({ error: `File exceeds maximum size of ${MAX_SIZE_BYTES / 1024 / 1024}MB` })
          return
        }

        if (!fileReceived) {
          res.status(400).json({ error: 'No file uploaded' })
          return
        }

        if (!entityType || !entityId) {
          if (savedPath && existsSync(savedPath)) fs.unlinkSync(savedPath)
          res.status(400).json({ error: 'entityType and entityId are required' })
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
            entityType,
            entityId,
            filename:    originalName,
            mimeType,
            sizeBytes,
            storagePath: savedPath,
            uploadedBy:  userId,
            uploadedAt:  now,
            description: description || null,
          }))

          logger.info({ fileId, tenantId, entityType, entityId, filename: originalName, sizeBytes }, '[attachment] uploaded')
          res.status(201).json({ id: fileId, filename: originalName, sizeBytes, downloadUrl: `/api/attachments/${fileId}` })
        } catch (err) {
          logger.error({ err }, '[attachment] Neo4j write failed')
          if (savedPath && existsSync(savedPath)) fs.unlinkSync(savedPath)
          res.status(500).json({ error: 'Failed to save attachment metadata' })
        } finally {
          await session.close()
        }
      })()
    })

    req.pipe(busboy)
  })()
})

// ── GET /api/attachments/:id ──────────────────────────────────────────────────

router.get('/attachments/:id', authMiddleware, (req, res) => {
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
