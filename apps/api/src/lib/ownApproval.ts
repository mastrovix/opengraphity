/**
 * NOBODY APPROVES WHAT THEY ASKED FOR (24 Sep 2026, decision of the owner:
 * «No, mai. La approva un altro membro del suo gruppo»).
 *
 * The requester of a change does not approve it, the requester of a service
 * request does not move it out of its approval, the author of a knowledge
 * article does not approve its publication — not even with
 * `approval.override`, which lets a person act for a team, not for
 * themselves. Another member of the approving group decides.
 */
import type { Session } from 'neo4j-driver'
import { runQueryOne } from '@opengraphity/neo4j'
import { ENTITY_NEO4J_LABELS } from '@opengraphity/types'

/**
 * Who asked for what is being approved: the person who asks for the approval
 * (`requestedBy`, when given), whoever the ticket was opened for
 * (REQUESTED_BY) and the author of an article. None of them approves it.
 */
export async function askersOf(
  session: Session, tenantId: string, entityType: string, entityId: string, requestedBy?: string | null,
): Promise<Set<string>> {
  const askers = new Set<string>(requestedBy ? [requestedBy] : [])
  const label = ENTITY_NEO4J_LABELS[entityType]
  if (!label) return askers
  const res = await session.executeRead((tx) => tx.run(`
    MATCH (e:${label} {id: $entityId, tenant_id: $tenantId})
    OPTIONAL MATCH (e)-[:REQUESTED_BY]->(u:User {tenant_id: $tenantId})
    RETURN u.id AS requester, e.author_id AS author
    LIMIT 1
  `, { entityId, tenantId }))
  for (const r of res.records) {
    for (const id of [r.get('requester'), r.get('author')]) if (typeof id === 'string' && id) askers.add(id)
  }
  return askers
}

/**
 * Is this move of a service request its approval by the person who asked for
 * it? The approval is leaving a step of purpose `approval` towards a step
 * that is not an end (the way to «rejected» stays open: a requester may
 * withdraw their own request).
 */
export async function isOwnRequestApproval(
  session: Session, tenantId: string, instanceId: string, toStep: string, userId: string,
): Promise<boolean> {
  const row = await runQueryOne<{ approvingMove: boolean; requester: string | null }>(session, `
    MATCH (wi:WorkflowInstance {id: $instanceId, tenant_id: $tenantId})-[:CURRENT_STEP]->(cur:WorkflowStep)
    MATCH (r:ServiceRequest {id: wi.entity_id, tenant_id: $tenantId})
    OPTIONAL MATCH (cur)-[:TRANSITIONS_TO]->(target:WorkflowStep {name: $toStep})
    OPTIONAL MATCH (r)-[:REQUESTED_BY]->(u:User {tenant_id: $tenantId})
    RETURN cur.purpose = 'approval' AND target IS NOT NULL
             AND NOT coalesce(target.is_terminal, target.type = 'end', false) AS approvingMove,
           u.id AS requester
  `, { instanceId, tenantId, toStep })
  return row?.approvingMove === true && row.requester !== null && row.requester === userId
}
