import { getSession } from '@opengraphity/neo4j'
import { sendSlackMessage, sendTeamsAdaptiveMessage } from './index.js'
import { formatSlackIncident, formatTeamsIncident, type NotificationEvent, type IncidentData } from './formatters.js'

interface NotificationChannelRow {
  id: string
  platform: string
  webhookUrl: string | null
  channelId: string | null
  eventTypes: string[]
}

interface Neo4jNode {
  properties: Record<string, unknown>
}

async function loadChannels(tenantId: string, eventType: string): Promise<NotificationChannelRow[]> {
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead((tx) =>
      tx.run(
        'MATCH (n:NotificationChannel {tenant_id: $tenantId, active: true}) RETURN n',
        { tenantId },
      ),
    )
    return result.records
      .map((r) => {
        const n = (r.get('n') as Neo4jNode).properties
        const eventTypes = JSON.parse((n['event_types'] as string) ?? '[]') as string[]
        return {
          id:         n['id']           as string,
          platform:   n['platform']     as string,
          webhookUrl: (n['webhook_url'] ?? null) as string | null,
          channelId:  (n['channel_id']  ?? null) as string | null,
          eventTypes,
        }
      })
      .filter((ch) => ch.eventTypes.includes(eventType))
  } finally {
    await session.close()
  }
}

export async function dispatchIncidentNotification(
  tenantId: string,
  eventType: NotificationEvent,
  incident: IncidentData,
): Promise<void> {
  console.log('[NOTIFICATION] payload ricevuto:', JSON.stringify({ tenantId, eventType, incident }, null, 2))
  const channels = await loadChannels(tenantId, eventType)
  for (const ch of channels) {
    if (ch.platform === 'slack') {
      const blocks = formatSlackIncident(eventType, incident)
      await sendSlackMessage(ch.webhookUrl, ch.channelId, blocks)
    } else if (ch.platform === 'teams' && ch.webhookUrl) {
      const card = formatTeamsIncident(eventType, incident)
      await sendTeamsAdaptiveMessage(ch.webhookUrl, card)
    }
  }
}
