/**
 * Collaboration resolvers: @mention search, watchers, internal chat.
 */
import { v4 as uuidv4 } from 'uuid'
import { withSession } from './ci-utils.js'
import { runQuery, runQueryOne } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { parseMentions } from '../../lib/mentionParser.js'
import { audit } from '../../lib/audit.js'
import { logger } from '../../lib/logger.js'
import { sseManager } from '@opengraphity/notifications'
import { GraphQLError } from 'graphql'

type Props = Record<string, unknown>
const log = logger.child({ module: 'collaboration' })

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Filters out demo/seed email addresses */
function isRealEmail(email: string): boolean {
  if (!email) return false
  if (email.includes('@demo.')) return false
  if (email.includes('@opengrafo.com')) return false
  if (/^usr-\d+@/.test(email)) return false
  return true
}

function requireAgent(ctx: GraphQLContext): void {
  const r = ctx.role?.toLowerCase() ?? ''
  if (r !== 'admin' && r !== 'tenant_admin' && r !== 'operator') {
    throw new GraphQLError('Access denied: agents/admin only', { extensions: { code: 'FORBIDDEN' } })
  }
}

async function notifyMentions(
  tenantId: string, authorName: string, entityType: string, entityId: string,
  entityTitle: string, mentions: string[], source: 'comment' | 'internal_chat',
  excerpt?: string,
): Promise<void> {
  const label = source === 'internal_chat' ? 'nella chat interna di' : 'in'
  for (const userId of mentions) {
    sseManager.sendToUser(tenantId, userId, {
      id: uuidv4(), type: 'mention',
      title: 'Menzione',
      message: `${authorName} ti ha menzionato ${label} ${entityType} "${entityTitle}"`,
      severity: 'info',
      entity_id: entityId, entity_type: entityType,
      timestamp: new Date().toISOString(), read: false,
    })

    // Send email notification for mention
    try {
      const { sendEmail } = await import('@opengraphity/notifications')
      const { mentionNotification } = await import('../../lib/emailTemplates.js')
      const userRow = await withSession(async (s) =>
        runQueryOne<{ email: string }>(s, `MATCH (u:User {id: $id, tenant_id: $t}) RETURN u.email AS email`, { id: userId, t: tenantId }),
      )
      if (userRow?.email && isRealEmail(userRow.email)) {
        const tpl = mentionNotification({ entityType, entityTitle, entityId, mentionerName: authorName, excerpt: excerpt ?? '' }, tenantId)
        void sendEmail({ to: userRow.email, ...tpl })
      }
    } catch { /* non-fatal */ }
  }
}

async function notifyWatchers(
  tenantId: string, entityType: string, entityId: string,
  eventDescription: string, excludeUserId?: string,
): Promise<void> {
  const watchers = await withSession(async (s) => {
    const rows = await runQuery<{ userId: string }>(s, `
      MATCH (u:User)-[:WATCHES]->(e {id: $entityId, tenant_id: $tenantId})
      RETURN u.id AS userId
    `, { entityId, tenantId })
    return rows.map(r => r.userId)
  })

  for (const userId of watchers) {
    if (userId === excludeUserId) continue
    sseManager.sendToUser(tenantId, userId, {
      id: uuidv4(), type: 'watcher',
      title: 'Aggiornamento',
      message: eventDescription,
      severity: 'info',
      entity_id: entityId, entity_type: entityType,
      timestamp: new Date().toISOString(), read: false,
    })

    // Send email notification for watcher
    try {
      const { sendEmail } = await import('@opengraphity/notifications')
      const { watcherNotification } = await import('../../lib/emailTemplates.js')
      const title = await getEntityTitle(tenantId, entityId)
      const userRow = await withSession(async (s) =>
        runQueryOne<{ email: string }>(s, `MATCH (u:User {id: $id, tenant_id: $t}) RETURN u.email AS email`, { id: userId, t: tenantId }),
      )
      if (userRow?.email && isRealEmail(userRow.email)) {
        const tpl = watcherNotification({ entityType, entityTitle: title, entityId, event: eventDescription }, tenantId)
        void sendEmail({ to: userRow.email, ...tpl })
      }
    } catch { /* non-fatal */ }
  }
}

async function autoWatch(tenantId: string, userId: string, entityId: string): Promise<void> {
  await withSession(async (s) => {
    await runQuery(s, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      MATCH (e {id: $entityId, tenant_id: $tenantId})
      MERGE (u)-[:WATCHES {watched_at: $now}]->(e)
    `, { userId, tenantId, entityId, now: new Date().toISOString() })
  }, true)
}

async function getEntityTitle(tenantId: string, entityId: string): Promise<string> {
  const row = await withSession(async (s) =>
    runQueryOne<{ title: string }>(s, `MATCH (e {id: $id, tenant_id: $t}) RETURN e.title AS title`, { id: entityId, t: tenantId }),
  )
  return row?.title ?? entityId
}

// ── Search Users ─────────────────────────────────────────────────────────────

async function searchUsers(_: unknown, args: { search: string; limit?: number }, ctx: GraphQLContext) {
  const limit = Math.min(args.limit ?? 5, 20)
  return withSession(async (s) => {
    const rows = await runQuery<{ id: string; name: string; email: string }>(s, `
      MATCH (u:User {tenant_id: $tenantId})
      WHERE toLower(u.name) CONTAINS toLower($search) OR toLower(u.email) CONTAINS toLower($search)
      RETURN u.id AS id, u.name AS name, u.email AS email
      ORDER BY u.name LIMIT toInteger($limit)
    `, { tenantId: ctx.tenantId, search: args.search, limit })
    return rows
  })
}

// ── Watchers ─────────────────────────────────────────────────────────────────

async function watchers(_: unknown, args: { entityType: string; entityId: string }, ctx: GraphQLContext) {
  return withSession(async (s) => {
    const rows = await runQuery<Props>(s, `
      MATCH (u:User)-[w:WATCHES]->(e {id: $entityId, tenant_id: $tenantId})
      RETURN u.id AS id, u.name AS name, u.email AS email, w.watched_at AS watchedAt
      ORDER BY w.watched_at DESC
    `, { entityId: args.entityId, tenantId: ctx.tenantId })
    return rows.map(r => ({ id: r['id'], name: r['name'], email: r['email'], watchedAt: r['watchedAt'] ?? '' }))
  })
}

async function isWatching(_: unknown, args: { entityType: string; entityId: string }, ctx: GraphQLContext) {
  return withSession(async (s) => {
    const row = await runQueryOne<{ c: number }>(s, `
      MATCH (u:User {id: $userId})-[:WATCHES]->(e {id: $entityId, tenant_id: $tenantId})
      RETURN count(u) AS c
    `, { userId: ctx.userId, entityId: args.entityId, tenantId: ctx.tenantId })
    return (row?.c ?? 0) > 0
  })
}

async function watchEntity(_: unknown, args: { entityType: string; entityId: string }, ctx: GraphQLContext) {
  await autoWatch(ctx.tenantId, ctx.userId, args.entityId)
  void audit(ctx, 'entity.watched', args.entityType, args.entityId)
  return true
}

async function unwatchEntity(_: unknown, args: { entityType: string; entityId: string }, ctx: GraphQLContext) {
  await withSession(async (s) => {
    await runQuery(s, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})-[w:WATCHES]->(e {id: $entityId})
      DELETE w
    `, { userId: ctx.userId, tenantId: ctx.tenantId, entityId: args.entityId })
  }, true)
  return true
}

async function addWatcher(_: unknown, args: { entityType: string; entityId: string; userId: string }, ctx: GraphQLContext) {
  await autoWatch(ctx.tenantId, args.userId, args.entityId)
  void audit(ctx, 'watcher.added', args.entityType, args.entityId, { watcherId: args.userId })
  return true
}

async function removeWatcher(_: unknown, args: { entityType: string; entityId: string; userId: string }, ctx: GraphQLContext) {
  await withSession(async (s) => {
    await runQuery(s, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})-[w:WATCHES]->(e {id: $entityId})
      DELETE w
    `, { userId: args.userId, tenantId: ctx.tenantId, entityId: args.entityId })
  }, true)
  void audit(ctx, 'watcher.removed', args.entityType, args.entityId, { watcherId: args.userId })
  return true
}

// ── Internal Messages ────────────────────────────────────────────────────────

async function internalMessages(
  _: unknown,
  args: { entityType: string; entityId: string; limit?: number; before?: string },
  ctx: GraphQLContext,
) {
  requireAgent(ctx)
  const limit = Math.min(args.limit ?? 50, 100)
  return withSession(async (s) => {
    const beforeFilter = args.before ? 'AND m.created_at < $before' : ''
    const rows = await runQuery<{ props: Props }>(s, `
      MATCH (m:InternalMessage {entity_id: $entityId, tenant_id: $tenantId})
      WHERE m.entity_type = $entityType ${beforeFilter}
      RETURN properties(m) AS props
      ORDER BY m.created_at DESC LIMIT toInteger($limit)
    `, { entityId: args.entityId, tenantId: ctx.tenantId, entityType: args.entityType, limit, before: args.before ?? null })
    return rows.map(r => mapMessage(r.props)).reverse()
  })
}

function mapMessage(p: Props) {
  const mentionsRaw = p['mentions'] as string | string[] | null
  let mentions: string[] = []
  if (Array.isArray(mentionsRaw)) mentions = mentionsRaw
  else if (typeof mentionsRaw === 'string') { try { mentions = JSON.parse(mentionsRaw) } catch { /* */ } }
  return {
    id:         p['id'],
    authorId:   p['author_id'],
    authorName: p['author_name'],
    body:       p['body'],
    mentions,
    createdAt:  p['created_at'],
    editedAt:   p['edited_at'] ?? null,
  }
}

async function sendInternalMessage(
  _: unknown,
  args: { entityType: string; entityId: string; body: string },
  ctx: GraphQLContext,
) {
  requireAgent(ctx)
  const id  = uuidv4()
  const now = new Date().toISOString()
  const mentions = parseMentions(args.body)

  const msg = await withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `
      CREATE (m:InternalMessage {
        id: $id, tenant_id: $tenantId, entity_type: $entityType, entity_id: $entityId,
        author_id: $authorId, author_name: $authorName, body: $body,
        mentions: $mentions, created_at: $now, edited_at: null
      })
      RETURN properties(m) AS props
    `, {
      id, tenantId: ctx.tenantId, entityType: args.entityType, entityId: args.entityId,
      authorId: ctx.userId, authorName: ctx.userEmail, body: args.body,
      mentions, now,
    })
    return mapMessage(rows[0]!.props)
  }, true)

  // Auto-watch on message
  await autoWatch(ctx.tenantId, ctx.userId, args.entityId)

  // Notify watchers
  const title = await getEntityTitle(ctx.tenantId, args.entityId)
  void notifyWatchers(ctx.tenantId, args.entityType, args.entityId,
    `${ctx.userEmail} ha scritto nella chat interna di ${args.entityType} "${title}"`, ctx.userId)

  // Notify mentions
  if (mentions.length > 0) {
    void notifyMentions(ctx.tenantId, ctx.userEmail, args.entityType, args.entityId, title, mentions, 'internal_chat')
  }

  // SSE event for real-time chat update
  sseManager.sendToTenant(ctx.tenantId, {
    id: uuidv4(), type: 'internal_message.new',
    title: 'Nuovo messaggio interno',
    message: args.body.slice(0, 100),
    entity_id: args.entityId, entity_type: args.entityType,
    timestamp: now, read: false,
  })

  void audit(ctx, 'internal_message.sent', args.entityType, args.entityId)
  return msg
}

async function editInternalMessage(_: unknown, args: { messageId: string; body: string }, ctx: GraphQLContext) {
  requireAgent(ctx)
  const now = new Date().toISOString()
  const mentions = parseMentions(args.body)

  return withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `
      MATCH (m:InternalMessage {id: $id, tenant_id: $tenantId, author_id: $authorId})
      WHERE duration.between(datetime(m.created_at), datetime($now)).minutes < 15
      SET m.body = $body, m.mentions = $mentions, m.edited_at = $now
      RETURN properties(m) AS props
    `, { id: args.messageId, tenantId: ctx.tenantId, authorId: ctx.userId, body: args.body, mentions, now })
    if (!rows[0]) throw new GraphQLError('Message not found, not yours, or edit window expired (15 min)')
    return mapMessage(rows[0].props)
  }, true)
}

async function deleteInternalMessage(_: unknown, args: { messageId: string }, ctx: GraphQLContext) {
  requireAgent(ctx)
  await withSession(async (s) => {
    // Admin can delete any, author can delete own
    const r = ctx.role?.toLowerCase() ?? ''
    const isAdmin = r === 'admin' || r === 'tenant_admin'
    const authorFilter = isAdmin ? '' : 'AND m.author_id = $authorId'
    await runQuery(s, `
      MATCH (m:InternalMessage {id: $id, tenant_id: $tenantId})
      WHERE true ${authorFilter}
      DETACH DELETE m
    `, { id: args.messageId, tenantId: ctx.tenantId, authorId: ctx.userId })
  }, true)
  return true
}

// ── Export ────────────────────────────────────────────────────────────────────

export const collaborationResolvers = {
  Query: {
    searchUsers,
    watchers,
    isWatching,
    internalMessages,
  },
  Mutation: {
    watchEntity,
    unwatchEntity,
    addWatcher,
    removeWatcher,
    sendInternalMessage,
    editInternalMessage,
    deleteInternalMessage,
  },
}

// Re-export helpers for use in other resolvers (comment creation, entity creation)
export { notifyMentions, notifyWatchers, autoWatch }
