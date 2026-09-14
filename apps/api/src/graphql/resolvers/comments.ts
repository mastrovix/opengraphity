import { GraphQLError } from 'graphql'
import { NotFoundError } from '../../lib/errors.js'
import { getSession } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { parseMentions } from '../../lib/mentionParser.js'
import { notifyMentions, notifyWatchers, autoWatch, getEntityTitle } from './collaboration.js'
import { COMMENTABLE_LABELS, writeTicketComment } from '../../lib/ticketComments.js'

interface EntityComment {
  id:          string
  body:        string
  isInternal:  boolean
  authorId:    string
  authorName:  string
  authorEmail: string
  createdAt:   string
  updatedAt:   string
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
         c.updated_at                      AS updatedAt
`

// ── Queries ───────────────────────────────────────────────────────────────────

export async function comments(
  _: unknown,
  args: { entityType: string; entityId: string; includeInternal?: boolean },
  ctx: GraphQLContext,
): Promise<EntityComment[]> {
  const includeInternal = args.includeInternal ?? true
  const label = COMMENTABLE_LABELS[args.entityType]
  if (!label) throw new GraphQLError(`Entity type cannot be commented on: ${args.entityType}`, { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.comment.entityType', params: { entityType: args.entityType } } } })

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

    void notifyCommentAudience(ctx, args.entityType, args.entityId, args.body)
    // Revisione del 14 set 2026 · CO-2/F10: qui partiva «nuovo commento» a
    // TUTTO il tenant per ogni risposta pubblica, in italiano. Chi deve saperlo
    // (osservatori e menzionati) lo sa da notifyCommentAudience.

    return created
  } finally {
    await session.close()
  }
}

export async function updateComment(
  _: unknown,
  args: { id: string; body: string },
  ctx: GraphQLContext,
): Promise<EntityComment> {
  if (args.body.length > 10_000) {
    throw new GraphQLError('Comment body exceeds maximum length of 10000 characters', { extensions: { code: 'BAD_REQUEST' } })
  }

  const session = getSession(undefined, 'WRITE')
  try {
    const loadRes = await session.executeRead((tx) => tx.run(`
      MATCH (c:Comment {id: $id, tenant_id: $tenantId})
      RETURN c.author_id AS authorId, c.created_at AS createdAt
    `, { id: args.id, tenantId: ctx.tenantId }))

    if (!loadRes.records.length) {
      throw new GraphQLError('Comment not found', { extensions: { code: 'NOT_FOUND' } })
    }

    const authorId  = loadRes.records[0].get('authorId')  as string
    const createdAt = loadRes.records[0].get('createdAt') as string

    if (authorId !== ctx.userId) {
      throw new GraphQLError('Only the author can edit a comment', { extensions: { code: 'FORBIDDEN' } })
    }

    const ageMs = Date.now() - new Date(createdAt).getTime()
    if (ageMs > 15 * 60 * 1000) {
      throw new GraphQLError('Comments can only be edited within 15 minutes of creation', { extensions: { code: 'BAD_REQUEST' } })
    }

    const now = new Date().toISOString()
    const res = await session.executeWrite((tx) => tx.run(`
      MATCH (c:Comment {id: $id, tenant_id: $tenantId})
      SET c.text = $body, c.updated_at = $updatedAt
      ${RETURN_FIELDS}
    `, { id: args.id, tenantId: ctx.tenantId, body: args.body, updatedAt: now }))

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
    const loadRes = await session.executeRead((tx) => tx.run(`
      MATCH (e)-[:HAS_COMMENT]->(c:Comment {id: $id, tenant_id: $tenantId})
      RETURN c.author_id AS authorId, head([k IN keys($labels) WHERE $labels[k] IN labels(e)]) AS entityType, e.id AS entityId
    `, { id: args.id, tenantId: ctx.tenantId, labels: COMMENTABLE_LABELS }))

    if (!loadRes.records.length) {
      throw new GraphQLError('Comment not found', { extensions: { code: 'NOT_FOUND' } })
    }

    const authorId  = loadRes.records[0].get('authorId')  as string
    const entityType = loadRes.records[0].get('entityType') as string
    const entityId   = loadRes.records[0].get('entityId')   as string

    if (authorId !== ctx.userId && ctx.role !== 'admin') {
      throw new GraphQLError('Only the author or an admin can delete a comment', { extensions: { code: 'FORBIDDEN' } })
    }

    await session.executeWrite((tx) => tx.run(`
      MATCH (c:Comment {id: $id, tenant_id: $tenantId})
      DETACH DELETE c
    `, { id: args.id, tenantId: ctx.tenantId }))

    void audit(ctx, 'comment.deleted', entityType, entityId, { commentId: args.id })
    return true
  } finally {
    await session.close()
  }
}

/**
 * Chi deve sapere di un commento: chi lo scrive diventa osservatore, i
 * menzionati ricevono la menzione, gli osservatori l'aggiornamento. Una
 * funzione per tutte le porte da cui si commenta (CO-3: il dettaglio di
 * incident e problem non notificava nessuno).
 */
export async function notifyCommentAudience(ctx: GraphQLContext, entityType: string, entityId: string, body: string): Promise<void> {
  await autoWatch(ctx.tenantId, ctx.userId, entityId)
  const mentions = parseMentions(body)
  // Il titolo del ticket nella menzione: prima si passava l'id, e la frase diceva «in incident "3f2a…"».
  if (mentions.length > 0) await notifyMentions(ctx.tenantId, ctx.userEmail, entityType, entityId, await getEntityTitle(ctx.tenantId, entityId), mentions, 'comment', body.slice(0, 200))
  await notifyWatchers(ctx.tenantId, entityType, entityId, { kind: 'comment', author: ctx.userEmail }, ctx.userId)
}

export const commentResolvers = {
  Query:    { comments },
  Mutation: { addComment, updateComment, deleteComment },
}

logger.debug('[comments] resolver module loaded')
