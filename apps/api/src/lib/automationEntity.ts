/**
 * Il ticket come lo vedono le condizioni delle automazioni: le proprietà del
 * nodo, più `assigned_to` e `assigned_team` (id), che non sono proprietà ma
 * relazioni. Una lettura sola per il consumatore degli eventi e per il job dei
 * trigger a tempo, così le due strade valutano la stessa cosa.
 */
import type { Session } from 'neo4j-driver'
import { runQuery } from '@opengraphity/neo4j'
import type { AutomationEntityType } from '@opengraphity/types'

export const AUTOMATION_LABELS: Readonly<Record<AutomationEntityType, string>> = {
  incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'ServiceRequest',
}

/** `null` se il ticket non esiste (più) nel tenant, o è una change eliminata. */
export async function loadAutomationEntity(
  session: Session, tenantId: string, entityType: AutomationEntityType, entityId: string,
): Promise<Record<string, unknown> | null> {
  const label = AUTOMATION_LABELS[entityType]
  const rows = await runQuery<{ props: Record<string, unknown>; assignedTo: string | null; assignedTeam: string | null }>(session, `
    MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})
    WHERE coalesce(e.deleted, false) = false
    OPTIONAL MATCH (e)-[:ASSIGNED_TO]->(u:User)
    OPTIONAL MATCH (e)-[:ASSIGNED_TO_TEAM]->(t:Team)
    RETURN properties(e) AS props, u.id AS assignedTo, t.id AS assignedTeam
  `, { entityId, tenantId })
  const row = rows[0]
  if (!row) return null
  return { ...row.props, assigned_to: row.assignedTo, assigned_team: row.assignedTeam }
}
