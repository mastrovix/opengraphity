/**
 * Il pannello delle notifiche in-app: l'archivio della persona collegata
 * (revisione del 14 set 2026 · F10). Prima il pannello era la memoria del
 * browser: una ricarica lo svuotava.
 */
import { dismissInbox, listInbox, markAllInboxRead, markInboxRead } from '@opengraphity/notifications'
import type { GraphQLContext } from '../../context.js'
import { ValidationError } from '../../lib/errors.js'

const MAX_NOTIFICATIONS = 200

async function myNotifications(_: unknown, args: { limit?: number | null }, ctx: GraphQLContext) {
  const limit = args.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NOTIFICATIONS) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_NOTIFICATIONS} (got ${String(limit)})`,
      { key: 'errors.list.limit', params: { max: MAX_NOTIFICATIONS, got: String(limit) } })
  }
  const items = await listInbox(ctx.tenantId, ctx.userId, limit)
  return items.map((n) => ({
    id: n.id, type: n.type, title: n.title, titleFallback: n.title_fallback ?? null,
    message: n.message, messageKey: n.message_key ?? null,
    messageParams: n.message_params ? JSON.stringify(n.message_params) : null,
    severity: n.severity ?? null, entityId: n.entity_id ?? null, entityType: n.entity_type ?? null,
    timestamp: n.timestamp, read: n.read,
  }))
}

async function markNotificationRead(_: unknown, args: { id: string }, ctx: GraphQLContext) {
  return (await markInboxRead(ctx.tenantId, ctx.userId, args.id)) > 0
}

async function markAllNotificationsRead(_: unknown, __: unknown, ctx: GraphQLContext) {
  return markAllInboxRead(ctx.tenantId, ctx.userId)
}

async function dismissAllNotifications(_: unknown, __: unknown, ctx: GraphQLContext) {
  return dismissInbox(ctx.tenantId, ctx.userId)
}

export const inboxResolvers = {
  Query:    { myNotifications },
  Mutation: { markNotificationRead, markAllNotificationsRead, dismissAllNotifications },
}
