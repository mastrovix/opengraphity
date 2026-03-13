import { getSession } from '@opengraphity/neo4j'
import { randomUUID } from 'crypto'
import type { GraphQLContext } from '../../context.js'

type Session = ReturnType<typeof getSession>

async function withSession<T>(fn: (s: Session) => Promise<T>, write = false): Promise<T> {
  const session = getSession(undefined, write ? 'WRITE' : 'READ')
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
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
    if (!result.records.length) throw new Error('NotificationChannel non trovato')
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
    if (!result.records.length) throw new Error('NotificationChannel non trovato')
    const ch = mapChannel(result.records[0]!.get('n').properties as Record<string, unknown>)
    const { sendTestMessage } = await import('@opengraphity/notifications')
    return sendTestMessage(ch)
  })
}

async function linkSlackAccount(_: unknown, { slackId }: { slackId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const result = await session.executeWrite((tx) =>
      tx.run(
        'MATCH (u:User {id: $userId, tenant_id: $tenantId}) SET u.slack_id = $slackId RETURN u',
        { userId: ctx.userId, tenantId: ctx.tenantId, slackId },
      ),
    )
    if (!result.records.length) throw new Error('User non trovato')
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
