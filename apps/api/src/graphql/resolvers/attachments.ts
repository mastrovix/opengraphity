import { GraphQLError } from 'graphql'
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { logger } from '../../lib/logger.js'

interface Attachment {
  id:          string
  filename:    string
  mimeType:    string
  sizeBytes:   number
  uploadedBy:  string
  uploadedAt:  string
  description: string | null
  downloadUrl: string
}

function mapAttachment(r: { get: (k: string) => unknown }): Attachment {
  const id = r.get('id') as string
  return {
    id,
    filename:    r.get('filename')    as string,
    mimeType:    r.get('mimeType')    as string,
    sizeBytes:   (() => {
      const v = r.get('sizeBytes')
      return v != null && typeof (v as { toNumber(): number }).toNumber === 'function'
        ? (v as { toNumber(): number }).toNumber()
        : Number(v ?? 0)
    })(),
    uploadedBy:  r.get('uploadedBy')  as string,
    uploadedAt:  r.get('uploadedAt')  as string,
    description: r.get('description') as string | null,
    downloadUrl: `/api/attachments/${id}`,
  }
}

// ── Query: attachments(entityType, entityId) ──────────────────────────────────

export async function attachments(
  _: unknown,
  args: { entityType: string; entityId: string },
  ctx: GraphQLContext,
): Promise<Attachment[]> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) => tx.run(`
      MATCH (a:Attachment {tenant_id: $tenantId, entity_type: $entityType, entity_id: $entityId})
      RETURN a.id           AS id,
             a.filename     AS filename,
             a.mime_type    AS mimeType,
             a.size_bytes   AS sizeBytes,
             a.uploaded_by  AS uploadedBy,
             a.uploaded_at  AS uploadedAt,
             a.description  AS description
      ORDER BY a.uploaded_at DESC
    `, { tenantId: ctx.tenantId, entityType: args.entityType, entityId: args.entityId }))
    return res.records.map(mapAttachment)
  } finally {
    await session.close()
  }
}

// ── Mutation: deleteAttachment(id) ────────────────────────────────────────────

export async function deleteAttachment(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
): Promise<boolean> {
  const session = getSession(undefined, 'WRITE')
  try {
    const loadRes = await session.executeRead((tx) => tx.run(`
      MATCH (a:Attachment {id: $id, tenant_id: $tenantId})
      RETURN a.uploaded_by AS uploadedBy, a.storage_path AS storagePath
    `, { id: args.id, tenantId: ctx.tenantId }))

    if (!loadRes.records.length) {
      throw new GraphQLError('Attachment not found', { extensions: { code: 'NOT_FOUND' } })
    }

    const uploadedBy  = loadRes.records[0].get('uploadedBy')  as string
    const storagePath = loadRes.records[0].get('storagePath') as string

    if (uploadedBy !== ctx.userId && ctx.role !== 'admin') {
      throw new GraphQLError('Only the uploader or an admin can delete attachments', { extensions: { code: 'FORBIDDEN' } })
    }

    // Delete from Neo4j
    await session.executeWrite((tx) => tx.run(`
      MATCH (a:Attachment {id: $id, tenant_id: $tenantId})
      DETACH DELETE a
    `, { id: args.id, tenantId: ctx.tenantId }))

    // Delete file from disk (best-effort — import fs lazily)
    try {
      const { unlink } = await import('fs/promises')
      await unlink(storagePath)
    } catch (err) {
      logger.warn({ err, id: args.id, storagePath }, '[attachment] file delete failed')
    }

    return true
  } finally {
    await session.close()
  }
}

export const attachmentResolvers = {
  Query:    { attachments },
  Mutation: { deleteAttachment },
}
