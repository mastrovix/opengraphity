/**
 * I canali Slack che scrivono con il bot (`channel_id`, non un webhook) in
 * un'organizzazione che non ha collegato il suo workspace (ondata 8 di «Nulla
 * cablato»): ogni notifica verso di loro fallirebbe. Lo usa la diagnostica.
 */
import type { Queryable } from '@opengraphity/neo4j'

export async function slackChannelsWithoutWorkspace(session: Queryable, tenantId: string): Promise<string[]> {
  const res = await session.run(`
    MATCH (c:NotificationChannel {tenant_id: $tenantId, platform: 'slack', active: true})
    WHERE c.channel_id IS NOT NULL AND c.channel_id <> '' AND (c.webhook_url IS NULL OR c.webhook_url = '')
      AND NOT EXISTS { MATCH (:SlackInstallation {tenant_id: $tenantId}) }
    RETURN collect(c.name) AS names
  `, { tenantId })
  return ((res.records[0]?.get('names') as string[] | undefined) ?? []).filter(Boolean)
}
