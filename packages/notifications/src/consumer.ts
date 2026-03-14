import { getSession } from '@opengraphity/neo4j'
import { sendSlackMessage, sendTeamsAdaptiveMessage } from './index.js'
import { formatSlackIncident, formatTeamsIncident, formatSlackChange, formatSlackChangeTask, type NotificationEvent, type IncidentData, type ChangeData, type ChangeTaskPayload } from './formatters.js'

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

async function enrichIncidentData(incident: IncidentData): Promise<IncidentData> {
  if (!incident.id || !incident.tenantId) return incident
  const session = getSession(undefined, 'READ')
  try {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (i:Incident {id: $id, tenant_id: $tenantId})
        OPTIONAL MATCH (i)-[:AFFECTED_BY]->(ci:ConfigurationItem)
        OPTIONAL MATCH (i)-[:ASSIGNED_TO]->(u:User)
        OPTIONAL MATCH (i)-[:ASSIGNED_TO_TEAM]->(t:Team)
        RETURN collect(DISTINCT ci.name) AS ciNames,
               u.name AS assignedTo,
               t.name AS teamName
      `, { id: incident.id, tenantId: incident.tenantId }),
    )
    if (!result.records.length) return incident
    const r = result.records[0]
    const ciNames   = (r.get('ciNames')   as string[]).filter(Boolean)
    const assignedTo = (r.get('assignedTo') ?? null) as string | null
    const teamName   = (r.get('teamName')   ?? null) as string | null
    return {
      ...incident,
      ciNames:      ciNames.length ? ciNames : undefined,
      assigneeName: assignedTo ?? teamName ?? null,
    }
  } finally {
    await session.close()
  }
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
  const enriched = await enrichIncidentData(incident)
  const channels = await loadChannels(tenantId, eventType)
  for (const ch of channels) {
    if (ch.platform === 'slack') {
      const blocks = formatSlackIncident(eventType, enriched)
      await sendSlackMessage(ch.webhookUrl, ch.channelId, blocks)
    } else if (ch.platform === 'teams' && ch.webhookUrl) {
      const card = formatTeamsIncident(eventType, enriched)
      await sendTeamsAdaptiveMessage(ch.webhookUrl, card)
    }
  }
}

export async function dispatchChangeNotification(
  tenantId: string,
  change: ChangeData,
): Promise<void> {
  const session = getSession(undefined, 'READ')
  let enriched = change
  try {
    const result = await session.executeRead((tx) =>
      tx.run(`
        MATCH (c:Change {id: $id, tenant_id: $tenantId})
        OPTIONAL MATCH (c)-[:AFFECTS]->(ci:ConfigurationItem)
        OPTIONAL MATCH (c)-[:ASSIGNED_TO]->(u:User)
        OPTIONAL MATCH (c)-[:ASSIGNED_TO_TEAM]->(t:Team)
        RETURN collect(DISTINCT ci.name) AS ciNames,
               u.name AS assignedTo, t.name AS teamName
      `, { id: change.id, tenantId }),
    )
    if (result.records.length) {
      const r      = result.records[0]
      const ciNames = (r.get('ciNames') as string[]).filter(Boolean)
      enriched = {
        ...change,
        ciName:      ciNames[0] ?? null,
        assigneeName: (r.get('assignedTo') ?? r.get('teamName') ?? null) as string | null,
      }
    }
  } finally {
    await session.close()
  }

  const channels = await loadChannels(tenantId, 'change_approved')
  for (const ch of channels) {
    if (ch.platform === 'slack') {
      const blocks = formatSlackChange(enriched)
      await sendSlackMessage(ch.webhookUrl, ch.channelId, blocks)
    }
  }
}

export async function dispatchChangeTaskNotification(
  tenantId: string,
  payload: ChangeTaskPayload,
): Promise<void> {
  const channels = await loadChannels(tenantId, 'change_task_assigned')
  for (const ch of channels) {
    if (ch.platform === 'slack') {
      const blocks = formatSlackChangeTask(payload)
      await sendSlackMessage(ch.webhookUrl, ch.channelId, blocks)
    }
  }
}
