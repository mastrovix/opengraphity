import { attachmentAccess, attachmentAccessCondition } from '../lib/attachmentAccess.js'
import fs from 'fs'
import { createWriteStream, existsSync, mkdirSync } from 'fs'
import type { Readable } from 'stream'
import { Router, type Request, type Response, type Router as ExpressRouter } from 'express'
import { v4 as uuidv4 } from 'uuid'
import Busboy from 'busboy'
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import { authMiddleware } from '../middleware/auth.js'
import { logger } from '../lib/logger.js'
import { config } from '../lib/config.js'
import { ValidationError } from '../lib/errors.js'
import { attachmentPolicy, extensionAllowed, fileExtension, type AttachmentPolicy } from '../lib/attachmentPolicy.js'
import {
  UPLOAD_PERMISSIONS,
  ATTACHMENT_ENTITY_LABELS,
  entityExistsCypher,
  resolveAttachmentPath,
  safeStoredFilename,
  validateAttachmentTarget,
  validateAttachmentFieldName,
  FORM_DRAFT_ENTITY_TYPE,
  type AttachmentTarget,
} from '../lib/attachmentValidation.js'

const router: ExpressRouter = Router()

const ATTACHMENT_DIR = config.attachmentDir

// Tipi e dimensione ammessi sono dell'organizzazione (lib/attachmentPolicy.ts,
// verifica «Cosa resta cablato», ondata 6): prima un elenco MIME e 10 MB fissi.

/** Does the (whitelisted-label) entity exist in this tenant? */
/** L'entità esiste nel tenant E il chiamante ci arriva con quell'accesso (lib/attachmentAccess.ts). */
async function entityReachable(target: AttachmentTarget, tenantId: string, userId: string, condition: string): Promise<boolean> {
  const session = getSession(undefined, 'READ')
  try {
    const row = await runQueryOne<{ id: string }>(session, entityExistsCypher(target.labels, condition), { entityId: target.entityId, tenantId, userId })
    return row !== null
  } finally {
    await session.close()
  }
}

// ── POST /api/attachments ─────────────────────────────────────────────────────
// Expects: multipart/form-data with fields entityType, entityId, [description]
// BEFORE the `file` part (the web client sends them in that order): the file
// stream is only opened once the target has been validated and found.

// Stessa ragione di `assistant.ts`: un `void` nudo su una funzione con degli
// `await` è una rejection senza padrone, e su Node 24 quella termina il
// processo. L'upload ha già un try/catch suo, ma la rete di sicurezza si mette
// dove si lancia, non dove si spera.
router.post('/attachments', authMiddleware, (req, res) => {
  void handleUpload(req, res).catch((err: unknown) => {
    logger.error({ err }, '[attachments] the upload failed outside its own handler')
    if (res.headersSent) { res.end(); return }
    res.status(500).json({ error: 'upload failed' })
  })
})

async function handleUpload(req: Request, res: Response): Promise<void> {
  const contentType = req.headers['content-type'] ?? ''
  if (!contentType.includes('multipart/form-data')) {
    res.status(400).json({ error: 'Expected multipart/form-data' })
    return
  }

  const { tenantId, userId, role, permissions } = req.user!
  if (!UPLOAD_PERMISSIONS.some((p) => permissions.has(p))) {
    res.status(403).json({ error: `Role '${role}' cannot upload attachments (requires one of: ${UPLOAD_PERMISSIONS.join(', ')})` })
    return
  }

  let policy: AttachmentPolicy
  try {
    policy = await attachmentPolicy(tenantId)
  } catch (err) {
    logger.error({ err, tenantId }, '[attachment] attachment policy not readable')
    res.status(500).json({ error: 'The attachment policy of this organization cannot be read' })
    return
  }
  const maxSizeBytes = policy.maxSizeMb * 1024 * 1024
  const busboy = Busboy({ headers: req.headers, limits: { fileSize: maxSizeBytes, files: 1, fields: 10 } })

  let entityType    = ''
  let entityId      = ''
  let description   = ''
  /** Il campo del modulo a cui il file risponde (solo per le bozze, ondata 2). */
  let fieldName     = ''
  let target: AttachmentTarget | null = null
  let fileReceived  = false
  let fileId        = ''
  let savedPath     = ''
  let originalName  = ''
  let mimeType      = ''
  let sizeBytes     = 0
  let sizeLimitHit  = false
  /** Assegnato dentro il callback del file, letto alla scrittura del nodo. */
  let fieldNameOfUpload: string | null = null
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
    if (name === 'fieldName')   fieldName   = val
  })

  busboy.on('file', (fieldname: string, fileStream: Readable, info: { filename: string; mimeType: string }) => {
    if (rejected || fieldname !== 'file') { fileStream.resume(); return }

    originalName = info.filename
    mimeType     = info.mimeType

    // 1. Validate target and MIME synchronously, before touching the disk.
    let campoDelModulo: string | null = null
    try {
      target = validateAttachmentTarget(entityType, entityId)
      campoDelModulo = validateAttachmentFieldName(target.entityType, fieldName || undefined)
    } catch (err) {
      fileStream.resume()
      reject(400, err instanceof ValidationError ? err.message : 'Invalid entityType/entityId (send them before the file part)')
      return
    }
    fieldNameOfUpload = campoDelModulo
    /**
     * Revisione totale · H-3: il portale allega solo ai propri ticket, lo staff
     * secondo i permessi del tipo.
     *
     * La BOZZA di un modulo (ondata 2) è l'eccezione, e la ragione è che non
     * c'è ancora niente di cui essere proprietari: basta il permesso di
     * caricare (già verificato sopra). La proprietà si verifica al momento di
     * reclamare i file, dove si pretende `uploaded_by` = chi crea la richiesta.
     */
    const bozza = target.entityType === FORM_DRAFT_ENTITY_TYPE
    const condition = bozza ? 'true' : attachmentAccessCondition(attachmentAccess(permissions, target.entityType, 'write'))
    if (condition === null) {
      fileStream.resume()
      reject(403, `Role '${role}' cannot attach files to a ${target.entityType}`)
      return
    }
    if (!extensionAllowed(policy, originalName)) {
      fileStream.resume()
      reject(400, `File type '.${fileExtension(originalName) || '?'}' is not allowed. Allowed: ${policy.extensions.map((x) => '.' + x).join(', ')}`)
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
      // Una bozza non ha un nodo da raggiungere: il controllo si salta.
      const exists = t.entityType === FORM_DRAFT_ENTITY_TYPE || await entityReachable(t, tenantId, userId, condition)
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
        reject(400, `File exceeds maximum size of ${String(policy.maxSizeMb)}MB`)
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
            description:  $description,
            field_name:   $fieldName
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
          fieldName:   fieldNameOfUpload,
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
}

// ── GET /api/attachments/:id ──────────────────────────────────────────────────

router.get('/attachments/:id', authMiddleware, (req, res: Response) => {
  void (async () => {
    const { tenantId, userId, permissions } = req.user!
    const { id }       = req.params

    const session = getSession(undefined, 'READ')
    try {
      const result = await session.executeRead((tx) => tx.run(`
        MATCH (a:Attachment {id: $id, tenant_id: $tenantId})
        RETURN a.storage_path AS storagePath, a.filename AS filename, a.mime_type AS mimeType,
               a.entity_type AS entityType, a.entity_id AS entityId
      `, { id, tenantId }))

      if (!result.records.length) {
        res.status(404).json({ error: 'Attachment not found' })
        return
      }

      // Revisione totale · H-14: si scarica solo l'allegato di un'entità che il chiamante può vedere.
      // Un rifiuto risponde come «non trovato»: l'esistenza di un file altrui non si rivela.
      const entityType = String(result.records[0].get('entityType') ?? '')
      const condition = attachmentAccessCondition(attachmentAccess(permissions, entityType, 'read'))
      const labels = ATTACHMENT_ENTITY_LABELS[entityType]
      if (condition === null || !labels || !(await entityReachable({ entityType, entityId: String(result.records[0].get('entityId')), labels }, tenantId, userId, condition))) {
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
