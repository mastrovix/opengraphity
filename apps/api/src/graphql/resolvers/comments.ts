import { GraphQLError } from 'graphql'
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import { sseManager } from '@opengraphity/notifications'
import type { GraphQLContext } from '../../context.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { parseMentions } from '../../lib/mentionParser.js'
import { notifyMentions, notifyWatchers, autoWatch } from './collaboration.js'

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

const RETURN_FIELDS = `
  RETURN c.id           AS id,
         c.body         AS body,
         c.is_internal  AS isInternal,
         c.author_id    AS authorId,
         c.author_name  AS authorName,
         c.author_email AS authorEmail,
         c.created_at   AS createdAt,
         c.updated_at   AS updatedAt
`

// ── Queries ───────────────────────────────────────────────────────────────────

export async function comments(
  _: unknown,
  args: { entityType: string; entityId: string; includeInternal?: boolean },
  ctx: GraphQLContext,
): Promise<EntityComment[]> {
  const includeInternal = args.includeInternal ?? true

  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) => tx.run(`
      MATCH (c:EntityComment {tenant_id: $tenantId, entity_type: $entityType, entity_id: $entityId})
      ${!includeInternal ? 'WHERE c.is_internal = false' : ''}
      ${RETURN_FIELDS}
      ORDER BY c.created_at ASC
    `, { tenantId: ctx.tenantId, entityType: args.entityType, entityId: args.entityId }))
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

  const id         = uuidv4()
  const now        = new Date().toISOString()
  const isInternal = args.isInternal ?? false

  const session = getSession(undefined, 'WRITE')
  try {
    const res = await session.executeWrite((tx) => tx.run(`
      CREATE (c:EntityComment {
        id:           $id,
        tenant_id:    $tenantId,
        entity_type:  $entityType,
        entity_id:    $entityId,
        body:         $body,
        is_internal:  $isInternal,
        author_id:    $authorId,
        author_name:  $authorName,
        author_email: $authorEmail,
        created_at:   $createdAt,
        updated_at:   $updatedAt
      })
      ${RETURN_FIELDS}
    `, {
      id,
      tenantId:    ctx.tenantId,
      entityType:  args.entityType,
      entityId:    args.entityId,
      body:        args.body,
      isInternal,
      authorId:    ctx.userId,
      authorName:  ctx.userEmail,
      authorEmail: ctx.userEmail,
      createdAt:   now,
      updatedAt:   now,
    }))

    const created = mapComment(res.records[0])
    void audit(ctx, 'comment.added', args.entityType, args.entityId, { commentId: id, isInternal })

    // Auto-watch on comment
    void autoWatch(ctx.tenantId, ctx.userId, args.entityId)

    // Parse @mentions and notify
    const mentions = parseMentions(args.body)
    if (mentions.length > 0) {
      const entityTitle = args.entityId // will be resolved in notifyMentions
      void notifyMentions(ctx.tenantId, ctx.userEmail, args.entityType, args.entityId, entityTitle, mentions, 'comment')
    }

    // Notify watchers
    void notifyWatchers(ctx.tenantId, args.entityType, args.entityId,
      `Nuovo commento di ${ctx.userEmail} su ${args.entityType}`, ctx.userId)

    if (!isInternal) {
      sseManager.sendToTenant(ctx.tenantId, {
        id:          uuidv4(),
        type:        'comment.added',
        title:       'Nuovo commento',
        message:     args.body.slice(0, 100),
        severity:    'info',
        entity_id:   args.entityId,
        entity_type: args.entityType,
        timestamp:   now,
        read:        false,
      })
    }

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
      MATCH (c:EntityComment {id: $id, tenant_id: $tenantId})
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
      MATCH (c:EntityComment {id: $id, tenant_id: $tenantId})
      SET c.body = $body, c.updated_at = $updatedAt
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
      MATCH (c:EntityComment {id: $id, tenant_id: $tenantId})
      RETURN c.author_id AS authorId, c.entity_type AS entityType, c.entity_id AS entityId
    `, { id: args.id, tenantId: ctx.tenantId }))

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
      MATCH (c:EntityComment {id: $id, tenant_id: $tenantId})
      DETACH DELETE c
    `, { id: args.id, tenantId: ctx.tenantId }))

    void audit(ctx, 'comment.deleted', entityType, entityId, { commentId: args.id })
    return true
  } finally {
    await session.close()
  }
}

export const commentResolvers = {
  Query:    { comments },
  Mutation: { addComment, updateComment, deleteComment },
}

logger.debug('[comments] resolver module loaded')
