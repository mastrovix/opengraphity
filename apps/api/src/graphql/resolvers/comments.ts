import { isEntityClosed } from '../../lib/workflowHelpers.js'
import { GraphQLError } from 'graphql'
import { NotFoundError } from '../../lib/errors.js'
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { COMMENTABLE_LABELS, requireCommentRead, writeTicketComment } from '../../lib/ticketComments.js'
import { hasPermission, isPortalOnly } from '../../lib/permissions.js'
import { notifyCommentAudience } from '../../services/commentAudience.js'

interface EntityComment {
  id:          string
  body:        string
  isInternal:  boolean
  authorId:    string
  authorName:  string
  authorEmail: string
  createdAt:   string
  updatedAt:   string
  editedAt:      string | null
  editedByName:  string | null
  deletedAt:     string | null
  deletedByName: string | null
}

function mapComment(r: { get: (k: string) => unknown }): EntityComment {
  return {
    id:          r.get('id')          as string,
    body:        r.get('body')        as string,
    isInternal:  (r.get('isInternal') as boolean | null) ?? false,
    authorId:    r.get('authorId')    as string,
    authorName:  r.get('authorName')  as string,
    authorEmail: r.get('authorEmail') as string,
    createdAt:   r.get('createdAt')   as string,
    updatedAt:   r.get('updatedAt')   as string,
    editedAt:      (r.get('editedAt')      ?? null) as string | null,
    editedByName:  (r.get('editedByName')  ?? null) as string | null,
    deletedAt:     (r.get('deletedAt')     ?? null) as string | null,
    deletedByName: (r.get('deletedByName') ?? null) as string | null,
  }
}

/**
 * La vista «generica» dei commenti di un ticket (API): stesso modello dei
 * commenti del dettaglio e del portale (lib/ticketComments.ts), con i nomi di
 * campo di questa API (`body`, autore per nome ed email). Prima leggeva e
 * scriveva un modello suo, `EntityComment`, che nessuna pagina mostrava (F1).
 */
const RETURN_FIELDS = `
  OPTIONAL MATCH (u:User {id: c.author_id, tenant_id: $tenantId})
  RETURN c.id                              AS id,
         c.text                            AS body,
         c.is_internal                     AS isInternal,
         c.author_id                       AS authorId,
         coalesce(u.name, c.author_label, u.email, '') AS authorName,
         coalesce(u.email, '')             AS authorEmail,
         c.created_at                      AS createdAt,
         c.updated_at                      AS updatedAt,
         c.edited_at                       AS editedAt,
         c.edited_by_name                  AS editedByName,
         c.deleted_at                      AS deletedAt,
         c.deleted_by_name                 AS deletedByName
`

// ── Queries ───────────────────────────────────────────────────────────────────

export async function comments(
  _: unknown,
  args: { entityType: string; entityId: string; includeInternal?: boolean },
  ctx: GraphQLContext,
): Promise<EntityComment[]> {
  const includeInternal = args.includeInternal ?? true
  requireCommentRead(ctx, args.entityType)
  const label = COMMENTABLE_LABELS[args.entityType]!

  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) => tx.run(`
      MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})-[:HAS_COMMENT]->(c:Comment)
      WHERE ($includeInternal = true OR c.is_internal = false)
      WITH c ORDER BY c.created_at ASC
      ${RETURN_FIELDS}
    `, { tenantId: ctx.tenantId, entityId: args.entityId, includeInternal }))
    return res.records.map(mapComment)
  } finally {
    await session.close()
  }
}

// ── Mutations ─────────────────────────────────────────────────────────────────

export async function addComment(
  _: unknown,
  args: { entityType: string; entityId: string; body: string; isInternal?: boolean },
  ctx: GraphQLContext,
): Promise<EntityComment> {
  if (args.body.length > 10_000) {
    throw new GraphQLError('Comment body exceeds maximum length of 10000 characters', { extensions: { code: 'BAD_REQUEST' } })
  }

  const now        = new Date().toISOString()
  // Nota interna salvo scelta esplicita, come nel dettaglio dei ticket.
  const isInternal = args.isInternal !== false

  const session = getSession(undefined, 'WRITE')
  try {
    // L'entità commentata deve esistere ed essere del tenant: prima un
    // entityId qualunque (anche di un altro tenant) creava un commento orfano
    // che l'autore credeva pubblicato.
    const label = COMMENTABLE_LABELS[args.entityType]
    if (!label) throw new GraphQLError(`Entity type cannot be commented on: ${args.entityType}`, { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.comment.entityType', params: { entityType: args.entityType } } } })
    const written = await writeTicketComment(session, {
      entityType: args.entityType, entityId: args.entityId, tenantId: ctx.tenantId,
      text: args.body, authorId: ctx.userId, isInternal, createdAt: now,
    })
    if (!written) {
      throw new NotFoundError(label, args.entityId)
    }
    const res = await session.executeRead((tx) => tx.run(`
      MATCH (c:Comment {id: $commentId, tenant_id: $tenantId})
      ${RETURN_FIELDS}
    `, { commentId: written.comment['id'], tenantId: ctx.tenantId }))
    const created = mapComment(res.records[0])
    void audit(ctx, 'comment.added', args.entityType, args.entityId, { commentId: created.id, isInternal })

    // `void` voluto (chi commenta non aspetta gli avvisi), `.catch`
    // obbligatorio: senza, un avviso che fallisce diventa una rejection senza
    // padrone e su Node 24 quella termina il processo (21 set 2026).
    void notifyCommentAudience(ctx, args.entityType, args.entityId, args.body, isInternal)
      .catch((err: unknown) => logger.error({ err, entityType: args.entityType, entityId: args.entityId }, '[comments] comment audience NOT notified'))
    // Revisione del 14 set 2026 · CO-2/F10: qui partiva «nuovo commento» a
    // TUTTO il tenant per ogni risposta pubblica, in italiano. Chi deve saperlo
    // (osservatori e menzionati) lo sa da notifyCommentAudience.

    return created
  } finally {
    await session.close()
  }
}

/**
 * Chi può toccare un commento (verifica «Cosa resta cablato», ondata 6):
 * l'autore il proprio, l'admin qualunque. Prima la modifica valeva solo per
 * l'autore e nei primi 15 minuti, la cancellazione era fisica, e nessuna
 * pagina offriva né l'una né l'altra. Un commento cancellato non si modifica.
 */
async function loadCommentForChange(
  session: ReturnType<typeof getSession>, id: string, ctx: GraphQLContext, action: 'edit' | 'delete',
): Promise<{ entityType: string; entityId: string; text: string; isInternal: boolean }> {
  const loadRes = await session.executeRead((tx) => tx.run(`
    MATCH (e)-[:HAS_COMMENT]->(c:Comment {id: $id, tenant_id: $tenantId})
    RETURN c.author_id AS authorId, c.text AS text, c.deleted_at AS deletedAt, c.is_internal AS isInternal,
           head([k IN keys($labels) WHERE $labels[k] IN labels(e)]) AS entityType, e.id AS entityId
  `, { id, tenantId: ctx.tenantId, labels: COMMENTABLE_LABELS }))
  const rec = loadRes.records[0]
  if (!rec) throw new NotFoundError('Comment', id)
  const authorId = rec.get('authorId') as string
  if (authorId !== ctx.userId && !hasPermission(ctx, 'ticket.moderateComments')) {
    throw new GraphQLError(`Only the author or someone who moderates comments can ${action} a comment`,
      { extensions: { code: 'FORBIDDEN', i18n: { key: action === 'edit' ? 'errors.comment.editForbidden' : 'errors.comment.deleteForbidden' } } })
  }
  // L'utente del portale vede solo le risposte pubbliche: le sue, per costruzione.
  if (isPortalOnly(ctx) && rec.get('isInternal') !== false) throw new NotFoundError('Comment', id)
  // Un ticket chiuso non si riscrive dal portale (revisione totale · H-39): lo staff non lo vedrebbe cambiare.
  if (isPortalOnly(ctx) && await isEntityClosed(session, rec.get('entityId') as string, ctx.tenantId)) {
    throw new GraphQLError('The ticket is closed: its conversation can no longer be changed', { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.comment.ticketClosed' } } })
  }
  if (rec.get('deletedAt')) {
    throw new GraphQLError('The comment has been deleted', { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.comment.deleted' } } })
  }
  return {
    entityType: rec.get('entityType') as string, entityId: rec.get('entityId') as string,
    text: String(rec.get('text') ?? ''), isInternal: rec.get('isInternal') === true,
  }
}

export async function updateComment(
  _: unknown,
  args: { id: string; body: string },
  ctx: GraphQLContext,
): Promise<EntityComment> {
  const body = args.body.trim()
  if (body.length === 0 || body.length > 10_000) {
    throw new GraphQLError('A comment must have 1–10000 characters', { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.comment.length', params: { max: 10000 } } } })
  }

  const session = getSession(undefined, 'WRITE')
  try {
    const current = await loadCommentForChange(session, args.id, ctx, 'edit')
    const now = new Date().toISOString()
    const res = await session.executeWrite((tx) => tx.run(`
      MATCH (c:Comment {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (me:User {id: $userId, tenant_id: $tenantId})
      SET c.text = $body, c.updated_at = $now, c.edited_at = $now,
          c.edited_by = $userId, c.edited_by_name = coalesce(me.name, me.email, $userEmail)
      WITH c
      ${RETURN_FIELDS}
    `, { id: args.id, tenantId: ctx.tenantId, body, now, userId: ctx.userId, userEmail: ctx.userEmail }))
    // Il testo di prima resta nell'Audit Log: la pagina mostra solo «modificato».
    void audit(ctx, 'comment.edited', current.entityType, current.entityId, { commentId: args.id, previousText: current.text })
    return mapComment(res.records[0])
  } finally {
    await session.close()
  }
}

export async function deleteComment(
  _: unknown,
  args: { id: string },
  ctx: GraphQLContext,
): Promise<boolean> {
  const session = getSession(undefined, 'WRITE')
  try {
    const current = await loadCommentForChange(session, args.id, ctx, 'delete')
    const now = new Date().toISOString()
    // Cancellazione come TRACCIA: il commento resta al suo posto, senza testo,
    // con chi e quando. Il testo cancellato è nell'Audit Log.
    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Comment {id: $id, tenant_id: $tenantId})
      OPTIONAL MATCH (me:User {id: $userId, tenant_id: $tenantId})
      SET c.text = '', c.updated_at = $now, c.deleted_at = $now,
          c.deleted_by = $userId, c.deleted_by_name = coalesce(me.name, me.email, $userEmail)
    `, { id: args.id, tenantId: ctx.tenantId, now, userId: ctx.userId, userEmail: ctx.userEmail }))

    void audit(ctx, 'comment.deleted', current.entityType, current.entityId, { commentId: args.id, deletedText: current.text })
    return true
  } finally {
    await session.close()
  }
}

// Who is told of a comment lives in services/collaboration.ts (wave 7 · C1): the REST API tells them too.
export { notifyCommentAudience }

export const commentResolvers = {
  Query:    { comments },
  Mutation: { addComment, updateComment, deleteComment },
}

logger.debug('[comments] resolver module loaded')
