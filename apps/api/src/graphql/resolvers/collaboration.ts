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
import { notifyMentions, notifyWatchers, autoWatch, getEntityTitle } from '../../services/collaboration.js'
import { GraphQLError } from 'graphql'
import { COMMENTABLE_LABELS, requireCommentRead } from '../../lib/ticketComments.js'
import { hasPermission, requirePermission } from '../../lib/permissions.js'
import { tenantRoles } from '../../lib/roles.js'
import { isPermission } from '@opengraphity/types'
import { ValidationError } from '../../lib/errors.js'
import { matchById } from '../../lib/cypherLookups.js'

type Props = Record<string, unknown>

// ── Helpers ──────────────────────────────────────────────────────────────────

/** La chat interna dei ticket: il permesso `ticket.internalChat` (ondata 7). */
function requireInternalChat(ctx: GraphQLContext): void {
  requirePermission(ctx, 'ticket.internalChat')
}


// ── Search Users ─────────────────────────────────────────────────────────────

/**
 * The roles of the organization that grant `permission` — the same source
 * as a person's `permissions` field (`tenantRoles`). Null when no permission
 * is asked; an unknown permission is an error, not «nobody».
 */
async function rolesGranting(tenantId: string, permission: string | null | undefined): Promise<string[] | null> {
  if (permission == null) return null
  if (!isPermission(permission)) {
    throw new ValidationError(`Unknown permission "${permission}"`, { key: 'errors.users.unknownPermission', params: { permission } })
  }
  return [...(await tenantRoles(tenantId)).values()].filter((r) => r.permissions.has(permission)).map((r) => r.key)
}

async function searchUsers(_: unknown, args: { search: string; limit?: number; permission?: string | null }, ctx: GraphQLContext) {
  const limit = Math.min(args.limit ?? 5, 20)
  const roles = await rolesGranting(ctx.tenantId, args.permission)
  if (roles !== null && roles.length === 0) return []
  return withSession(async (s) => {
    const rows = await runQuery<{ id: string; name: string; email: string; role: string | null }>(s, `
      MATCH (u:User {tenant_id: $tenantId})
      WHERE (toLower(u.name) CONTAINS toLower($search) OR toLower(u.email) CONTAINS toLower($search))
        AND coalesce(u.active, true) = true
        AND ($roles IS NULL OR u.role IN $roles)
      RETURN u.id AS id, u.name AS name, u.email AS email, u.role AS role
      ORDER BY u.name LIMIT toInteger($limit)
    `, { tenantId: ctx.tenantId, search: args.search, limit, roles })
    return rows
  })
}

/** How many people one `usersByIds` names at most: a rule, a step or a preview names a handful. */
export const USERS_BY_IDS_MAX = 100

/**
 * The names of people already chosen, by id (review of 23 Sep 2026). The
 * automation editors downloaded every person of the organization to show the
 * name of the one or two a rule names; the pickers search as the user types
 * (`searchUsers`), and this names what is already saved — inactive people
 * too, so a rule that names one says who, instead of an id.
 */
async function usersByIds(_: unknown, args: { ids: string[] }, ctx: GraphQLContext) {
  const ids = [...new Set(args.ids)]
  if (ids.length > USERS_BY_IDS_MAX) {
    throw new ValidationError(`At most ${USERS_BY_IDS_MAX} people can be named at once (got ${ids.length})`,
      { key: 'errors.users.tooManyIds', params: { max: String(USERS_BY_IDS_MAX) } })
  }
  if (ids.length === 0) return []
  return withSession(async (s) => runQuery<{ id: string; name: string; email: string; active: boolean }>(s, `
    MATCH (u:User {tenant_id: $tenantId})
    WHERE u.id IN $ids
    RETURN u.id AS id, u.name AS name, u.email AS email, coalesce(u.active, true) AS active
    ORDER BY u.name
  `, { tenantId: ctx.tenantId, ids }))
}

// ── Watchers ─────────────────────────────────────────────────────────────────

async function watchers(_: unknown, args: { entityType: string; entityId: string }, ctx: GraphQLContext) {
  return withSession(async (s) => {
    const rows = await runQuery<Props>(s, `
      ${matchById('e', { labels: 'entities', id: '$entityId' })}
      MATCH (u:User)-[w:WATCHES]->(e)
      WITH u, min(w.watched_at) AS watchedAt
      RETURN u.id AS id, u.name AS name, u.email AS email, watchedAt
      ORDER BY watchedAt DESC
    `, { entityId: args.entityId, tenantId: ctx.tenantId })
    return rows.map(r => ({ id: r['id'], name: r['name'], email: r['email'], watchedAt: r['watchedAt'] ?? '' }))
  })
}

async function isWatching(_: unknown, args: { entityType: string; entityId: string }, ctx: GraphQLContext) {
  return withSession(async (s) => {
    const row = await runQueryOne<{ c: number }>(s, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})-[:WATCHES]->(e {id: $entityId, tenant_id: $tenantId})
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
  requireInternalChat(ctx)
  requireCommentRead(ctx, args.entityType)
  const limit = Math.min(args.limit ?? 50, 100)
  return withSession(async (s) => {
    const beforeFilter = args.before ? 'AND m.created_at < $before' : ''
    const rows = await runQuery<{ props: Props }>(s, `
      MATCH (m:InternalMessage {entity_id: $entityId, tenant_id: $tenantId})
      WHERE m.entity_type = $entityType ${beforeFilter}
      // Il nome della persona, non l'e-mail salvata (giro del 14 set 2026, #19):
      // i commenti mostravano il nome, la chat l'indirizzo.
      RETURN m {.*, author_name: coalesce(COLLECT { MATCH (u:User {id: m.author_id, tenant_id: $tenantId}) RETURN u.name }[0], m.author_name)} AS props
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
  requireInternalChat(ctx)
  const id  = uuidv4()
  const now = new Date().toISOString()
  const mentions = parseMentions(args.body)
  // CO-3 (revisione del 14 set 2026): il messaggio si appende solo a un ticket
  // che esiste in questo tenant. Prima un entityId qualunque creava un messaggio
  // orfano che l'autore credeva inviato.
  const label = COMMENTABLE_LABELS[args.entityType]
  if (!label) throw new GraphQLError(`Entity type cannot have an internal chat: ${args.entityType}`, { extensions: { code: 'BAD_USER_INPUT', i18n: { key: 'errors.comment.entityType', params: { entityType: args.entityType } } } })

  const msg = await withSession(async (s) => {
    const rows = await runQuery<{ props: Props }>(s, `
      MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})
      OPTIONAL MATCH (author:User {id: $authorId, tenant_id: $tenantId})
      CREATE (m:InternalMessage {
        id: $id, tenant_id: $tenantId, entity_type: $entityType, entity_id: $entityId,
        author_id: $authorId, author_name: coalesce(author.name, $authorName), body: $body,
        mentions: $mentions, created_at: $now, edited_at: null
      })
      RETURN properties(m) AS props
    `, {
      id, tenantId: ctx.tenantId, entityType: args.entityType, entityId: args.entityId,
      authorId: ctx.userId, authorName: ctx.userEmail, body: args.body,
      mentions, now,
    })
    if (!rows[0]) throw new GraphQLError(`${label} not found`, { extensions: { code: 'NOT_FOUND' } })
    return mapMessage(rows[0].props)
  }, true)

  // Auto-watch on message
  await autoWatch(ctx.tenantId, ctx.userId, args.entityId)

  /*
   * AVVISI A PARTE, MA NON SENZA PADRONE (21 set 2026).
   *
   * Il `void` qui e' voluto: chi scrive un messaggio non deve aspettare che
   * partano gli avvisi. Ma senza `.catch` un errore la' dentro diventa una
   * rejection senza padrone, e su Node 24 quella TERMINA il processo: un
   * avviso che non parte avrebbe buttato giu' l'API.
   *
   * Non si ingoia: si scrive a livello di errore, perche' un osservatore che
   * non viene avvisato e' un difetto, non un dettaglio. Lo ha trovato vitest
   * 5, che una rejection senza padrone la fa fallire invece di stamparla.
   */
  const title = await getEntityTitle(ctx.tenantId, args.entityId)
  void notifyWatchers(ctx.tenantId, args.entityType, args.entityId, { kind: 'internal_chat', author: ctx.userEmail }, ctx.userId, true)
    .catch((err: unknown) => logger.error({ err, entityType: args.entityType, entityId: args.entityId }, '[collaboration] watchers NOT notified of the internal message'))

  if (mentions.length > 0) {
    void notifyMentions(ctx.tenantId, ctx.userEmail, args.entityType, args.entityId, title, mentions, 'internal_chat')
      .catch((err: unknown) => logger.error({ err, entityType: args.entityType, entityId: args.entityId }, '[collaboration] mentioned people NOT notified of the internal message'))
  }

  // Revisione del 14 set 2026 · CO-2/F10: qui partiva «nuovo messaggio
  // interno» a TUTTO il tenant. Nessuna pagina lo ascoltava, e con le notifiche
  // salvate sarebbe finito nel pannello di ogni persona: lo ricevono gli
  // osservatori e i menzionati, sopra.

  void audit(ctx, 'internal_message.sent', args.entityType, args.entityId)
  return msg
}

async function editInternalMessage(_: unknown, args: { messageId: string; body: string }, ctx: GraphQLContext) {
  requireInternalChat(ctx)
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
  requireInternalChat(ctx)
  await withSession(async (s) => {
    // Chi modera i commenti cancella qualunque messaggio, gli altri solo i propri
    const authorFilter = hasPermission(ctx, 'ticket.moderateComments') ? '' : 'AND m.author_id = $authorId'
    const rows = await runQuery<{ n: unknown }>(s, `
      MATCH (m:InternalMessage {id: $id, tenant_id: $tenantId})
      WHERE true ${authorFilter}
      WITH m, count(m) AS n
      DETACH DELETE m
      RETURN n
    `, { id: args.messageId, tenantId: ctx.tenantId, authorId: ctx.userId })
    // CO-3: prima rispondeva `true` anche quando non aveva cancellato niente
    // (messaggio inesistente o di un altro autore).
    if (rows.length === 0) throw new GraphQLError('Message not found, or not yours', { extensions: { code: 'NOT_FOUND', i18n: { key: 'errors.internalChat.notFoundOrNotYours' } } })
  }, true)
  return true
}

// ── Export ────────────────────────────────────────────────────────────────────

export const collaborationResolvers = {
  Query: {
    searchUsers,
    usersByIds,
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
// Who is told of what happens on a ticket lives in services/collaboration.ts (wave 7 · C1): re-exported for the resolvers.
export { notifyMentions, notifyWatchers, autoWatch, getEntityTitle }
export type { WatcherEvent } from '../../services/collaboration.js'
