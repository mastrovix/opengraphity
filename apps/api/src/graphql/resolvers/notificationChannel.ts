import { NotFoundError } from '../../lib/errors.js'
import { randomUUID } from 'crypto'
import type { GraphQLContext } from '../../context.js'
import { withSession } from './ci-utils.js'
import { assertSafeOutboundUrl } from '../../lib/safeUrl.js'
import { ValidationError } from '../../lib/errors.js'

const PLATFORMS = ['slack', 'teams', 'email'] as const
function assertPlatform(p: string): void {
  if (!(PLATFORMS as readonly string[]).includes(p)) throw new ValidationError(`platform "${p}" is not supported (allowed: ${PLATFORMS.join(', ')})`, { key: 'errors.channel.platform', params: { platform: p, allowed: PLATFORMS.join(', ') } })
}

function mapChannel(n: Record<string, unknown>) {
  return {
    id:         n['id'] as string,
    platform:   n['platform'] as string,
    name:       n['name'] as string,
    webhookUrl: (n['webhook_url'] ?? null) as string | null,
    channelId:  (n['channel_id'] ?? null) as string | null,
    eventTypes: JSON.parse((n['event_types'] as string) ?? '[]') as string[],
    active:     n['active'] as boolean,
    createdAt:  n['created_at'] as string,
  }
}

async function notificationChannels(_: unknown, __: unknown, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(
        'MATCH (n:NotificationChannel {tenant_id: $tenantId}) RETURN n ORDER BY n.created_at DESC',
        { tenantId: ctx.tenantId },
      ),
    )
    return result.records.map((r) => mapChannel(r.get('n').properties as Record<string, unknown>))
  })
}

async function createNotificationChannel(
  _: unknown,
  { input }: { input: { platform: string; name: string; webhookUrl?: string; channelId?: string; eventTypes: string[] } },
  ctx: GraphQLContext,
) {
  assertPlatform(input.platform)
  // SSRF guard on the tenant-configured webhook (ValidationError → 400).
  if (input.webhookUrl) await assertSafeOutboundUrl(input.webhookUrl)
  return withSession(async (session) => {
    const now = new Date().toISOString()
    const id = randomUUID()
    const result = await session.executeWrite((tx) =>
      tx.run(
        `CREATE (n:NotificationChannel {
          id: $id, tenant_id: $tenantId, platform: $platform,
          name: $name, webhook_url: $webhookUrl, channel_id: $channelId,
          event_types: $eventTypes, active: true, created_at: $now
        }) RETURN n`,
        {
          id, tenantId: ctx.tenantId, platform: input.platform, name: input.name,
          webhookUrl: input.webhookUrl ?? null, channelId: input.channelId ?? null,
          eventTypes: JSON.stringify(input.eventTypes), now,
        },
      ),
    )
    return mapChannel(result.records[0]!.get('n').properties as Record<string, unknown>)
  }, true)
}

async function updateNotificationChannel(
  _: unknown,
  { id, input }: { id: string; input: { platform: string; name: string; webhookUrl?: string; channelId?: string; eventTypes: string[] } },
  ctx: GraphQLContext,
) {
  assertPlatform(input.platform)
  if (input.webhookUrl) await assertSafeOutboundUrl(input.webhookUrl)
  return withSession(async (session) => {
    const result = await session.executeWrite((tx) =>
      tx.run(
        `MATCH (n:NotificationChannel {id: $id, tenant_id: $tenantId})
         SET n.platform = $platform, n.name = $name,
             n.webhook_url = $webhookUrl, n.channel_id = $channelId,
             n.event_types = $eventTypes
         RETURN n`,
        {
          id, tenantId: ctx.tenantId, platform: input.platform, name: input.name,
          webhookUrl: input.webhookUrl ?? null, channelId: input.channelId ?? null,
          eventTypes: JSON.stringify(input.eventTypes),
        },
      ),
    )
    if (!result.records.length) throw new NotFoundError('NotificationChannel')
    return mapChannel(result.records[0]!.get('n').properties as Record<string, unknown>)
  }, true)
}

async function deleteNotificationChannel(_: unknown, { id }: { id: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    await session.executeWrite((tx) =>
      tx.run(
        'MATCH (n:NotificationChannel {id: $id, tenant_id: $tenantId}) DETACH DELETE n',
        { id, tenantId: ctx.tenantId },
      ),
    )
    return true
  }, true)
}

async function testNotificationChannel(_: unknown, { id }: { id: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const result = await session.executeRead((tx) =>
      tx.run(
        'MATCH (n:NotificationChannel {id: $id, tenant_id: $tenantId}) RETURN n',
        { id, tenantId: ctx.tenantId },
      ),
    )
    if (!result.records.length) throw new NotFoundError('NotificationChannel')
    const ch = mapChannel(result.records[0]!.get('n').properties as Record<string, unknown>)
    // The notifications package re-checks too (UnsafeUrlError); checking here
    // first surfaces a proper ValidationError to the caller.
    if (ch.webhookUrl) await assertSafeOutboundUrl(ch.webhookUrl)
    const { sendTestMessage } = await import('@opengraphity/notifications')
    return sendTestMessage(ch, ctx.tenantId)
  })
}

/**
 * Collega o scollega l'account Slack di chi chiama. `slackId` null = scollega
 * (revisione totale · F-20): il web mandava `slackId: ""`, cioè «collega alla
 * stringa vuota», e il nodo restava con un id vuoto — due persone
 * «scollegate» avrebbero avuto lo stesso `slack_id`, e le azioni dai messaggi
 * Slack (`rest/slack.ts` cerca `User {slack_id}`) avrebbero potuto agire come
 * la persona sbagliata. Un id già usato da un'altra persona del cliente viene
 * rifiutato per la stessa ragione.
 */
async function linkSlackAccount(_: unknown, { slackId }: { slackId?: string | null }, ctx: GraphQLContext) {
  const trimmed = slackId == null ? null : slackId.trim()
  if (trimmed !== null && trimmed === '') {
    throw new ValidationError('slackId cannot be empty: pass null to unlink the Slack account')
  }
  return withSession(async (session) => {
    if (trimmed !== null) {
      const taken = await session.executeRead((tx) => tx.run(
        'MATCH (o:User {slack_id: $slackId, tenant_id: $tenantId}) WHERE o.id <> $userId RETURN o.name AS name LIMIT 1',
        { slackId: trimmed, tenantId: ctx.tenantId, userId: ctx.userId },
      ))
      const other = taken.records[0]?.get('name') as string | undefined
      if (other !== undefined) {
        throw new ValidationError(`Slack account ${trimmed} is already linked to ${other}`, { key: 'errors.slack.idTaken', params: { user: other } })
      }
    }
    const result = await session.executeWrite((tx) =>
      tx.run(
        'MATCH (u:User {id: $userId, tenant_id: $tenantId}) SET u.slack_id = $slackId RETURN u',
        { userId: ctx.userId, tenantId: ctx.tenantId, slackId: trimmed },
      ),
    )
    if (!result.records.length) throw new NotFoundError('User')
    const u = result.records[0]!.get('u').properties as Record<string, unknown>
    return {
      id:       u['id']        as string,
      tenantId: u['tenant_id'] as string,
      email:    u['email']     as string,
      name:     u['name']      as string,
      role:     u['role']      as string,
      teamId:   (u['team_id']  ?? null) as string | null,
      slackId:  (u['slack_id'] ?? null) as string | null,
    }
  }, true)
}

export const notificationChannelResolvers = {
  Query: { notificationChannels },
  Mutation: {
    createNotificationChannel,
    updateNotificationChannel,
    deleteNotificationChannel,
    testNotificationChannel,
    linkSlackAccount,
  },
}
