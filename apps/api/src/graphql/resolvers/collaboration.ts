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
import { COMMENTABLE_LABELS } from '../../lib/ticketComments.js'
import { hasPermission, requirePermission } from '../../lib/permissions.js'

type Props = Record<string, unknown>

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * L'indirizzo a cui mandare una e-mail di collaborazione, o `null`.
 *
 * Revisione del 14 set 2026 · CO-1: prima si scartavano gli indirizzi `@demo.`,
 * `@opengrafo.com` e `usr-N@`, una scelta da seed che faceva sparire senza
 * traccia le e-mail di un cliente con quei domini. Ora decide la persona, dal
 * Profilo (`notifications_enabled`, assente = attivo), come per il digest e il
 * dispatcher delle notifiche.
 */
async function emailRecipient(tenantId: string, userId: string): Promise<string | null> {
  const row = await withSession(async (s) =>
    runQueryOne<{ email: string | null; enabled: boolean }>(s, `
      MATCH (u:User {id: $id, tenant_id: $t})
      RETURN u.email AS email, coalesce(u.notifications_enabled, true) AS enabled
    `, { id: userId, t: tenantId }),
  )
  return row?.email && row.enabled ? row.email : null
}

/** La chat interna dei ticket: il permesso `ticket.internalChat` (ondata 7). */
function requireInternalChat(ctx: GraphQLContext): void {
  requirePermission(ctx, 'ticket.internalChat')
}

/**
 * Menzioni e osservatori parlano la lingua di chi legge (revisione del 14 set
 * 2026 · CO-2). La notifica porta la chiave del messaggio e i suoi dati, e il
 * pannello compone la frase; `message` è la stessa frase nella lingua del
 * cliente, per chi non ha la chiave. Prima erano letterali italiani
 * («Menzione», «ti ha menzionato», «Aggiornamento») per ogni cliente.
 */
async function notifyMentions(
  tenantId: string, authorName: string, entityType: string, entityId: string,
  entityTitle: string, mentions: string[], source: 'comment' | 'internal_chat',
  excerpt?: string,
): Promise<void> {
  const { loadNotificationLocale, notificationText } = await import('@opengraphity/notifications')
  const locale = await loadNotificationLocale(tenantId)
  const params = { author: authorName, entity: entityType, title: entityTitle }
  const textKey = source === 'internal_chat' ? 'mentionChatMessage' : 'mentionMessage'
  for (const userId of mentions) {
    sseManager.sendToUser(tenantId, userId, {
      id: uuidv4(), type: 'mention',
      title: 'notification.mention.title',
      message: notificationText(locale, textKey, params),
      message_key: source === 'internal_chat' ? 'inApp.mention.chatMessage' : 'inApp.mention.message',
      message_params: params,
      severity: 'info',
      entity_id: entityId, entity_type: entityType,
      timestamp: new Date().toISOString(), read: false,
    })

    // Send email notification for mention
    try {
      const { sendTenantEmail, loadTenantBrand } = await import('@opengraphity/notifications')
      const { mentionNotification } = await import('../../lib/emailTemplates.js')
      const to = await emailRecipient(tenantId, userId)
      if (to) {
        const tpl = mentionNotification({ entityType, entityTitle, entityId, mentionerName: authorName, excerpt: excerpt ?? '' }, { tenantId, brand: await loadTenantBrand(tenantId) }, locale)
        await sendTenantEmail(tenantId, { to, ...tpl })
      }
    } catch (err) {
      // Non-fatal for the mutation, but a systematically broken mailer must be
      // visible in the logs, not swallowed without a trace.
      logger.error({ err, userId, entityId }, '[collaboration] mention email failed — notification NOT sent')
    }
  }
}

/**
 * Cosa è successo, per gli osservatori: una frase del prodotto (chiave e dati)
 * o un testo scritto da una persona (il commento dal portale), che non si
 * traduce.
 */
export type WatcherEvent =
  | { kind: 'comment' | 'internal_chat'; author: string }
  | { kind: 'text'; text: string }

const WATCHER_KEYS = {
  comment:       { text: 'watcherComment',      web: 'inApp.watcher.comment' },
  internal_chat: { text: 'watcherInternalChat', web: 'inApp.watcher.internalChat' },
} as const

async function notifyWatchers(
  tenantId: string, entityType: string, entityId: string,
  event: WatcherEvent, excludeUserId?: string,
): Promise<void> {
  const watchers = await withSession(async (s) => {
    const rows = await runQuery<{ userId: string }>(s, `
      MATCH (u:User)-[:WATCHES]->(e {id: $entityId, tenant_id: $tenantId})
      RETURN u.id AS userId
    `, { entityId, tenantId })
    return rows.map(r => r.userId)
  })
  const { loadNotificationLocale, notificationText } = await import('@opengraphity/notifications')
  const locale = await loadNotificationLocale(tenantId)
  const described = event.kind === 'text'
    ? { message: event.text }
    : {
        message: notificationText(locale, WATCHER_KEYS[event.kind].text, { author: event.author }),
        message_key: WATCHER_KEYS[event.kind].web,
        message_params: { author: event.author },
      }

  for (const userId of watchers) {
    if (userId === excludeUserId) continue
    sseManager.sendToUser(tenantId, userId, {
      id: uuidv4(), type: 'watcher',
      title: 'notification.watcher.title',
      ...described,
      severity: 'info',
      entity_id: entityId, entity_type: entityType,
      timestamp: new Date().toISOString(), read: false,
    })

    // Send email notification for watcher
    try {
      const { sendTenantEmail, loadTenantBrand } = await import('@opengraphity/notifications')
      const { watcherNotification } = await import('../../lib/emailTemplates.js')
      const title = await getEntityTitle(tenantId, entityId)
      const to = await emailRecipient(tenantId, userId)
      if (to) {
        const tpl = watcherNotification({ entityType, entityTitle: title, entityId, event: described.message }, { tenantId, brand: await loadTenantBrand(tenantId) }, locale)
        await sendTenantEmail(tenantId, { to, ...tpl })
      }
    } catch (err) {
      // Per-watcher batch: keep notifying the others, but log the failure loud.
      logger.error({ err, userId, entityId }, '[collaboration] watcher email failed — notification NOT sent')
    }
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

  // Notify watchers
  const title = await getEntityTitle(ctx.tenantId, args.entityId)
  void notifyWatchers(ctx.tenantId, args.entityType, args.entityId, { kind: 'internal_chat', author: ctx.userEmail }, ctx.userId)

  // Notify mentions
  if (mentions.length > 0) {
    void notifyMentions(ctx.tenantId, ctx.userEmail, args.entityType, args.entityId, title, mentions, 'internal_chat')
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
export { notifyMentions, notifyWatchers, autoWatch, getEntityTitle }
