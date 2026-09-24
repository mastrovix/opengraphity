/**
 * THE STEP ACTIONS THAT WRITE THE GRAPH, registered on the workflow engine at
 * import (review of 23 Sep 2026, wave 7 · B1).
 *
 * `assign_to`, `update_field`, `create_entity` and `create_approval_request`
 * were callbacks of the manual transition's ActionContext: on the other paths
 * (escalation, portal, approvals, automatic changes, incident resolution…)
 * they failed and the ticket moved on anyway. Registered here, like the
 * conditions and the task creator, they hold for every path that moves a
 * ticket. Each handler opens its own session: it runs after the transition
 * is persisted, like the actions always did.
 */
import { getSession } from '@opengraphity/neo4j'
import { publish } from '@opengraphity/events'
import { registerStepActionHandlers } from '@opengraphity/workflow'
import { v4 as uuidv4 } from 'uuid'
import { matchById } from '../lib/cypherLookups.js'
import { assignTeamCypher, TEAM_NOW_PARAM } from '../lib/ticketTeamHistory.js'
import { assertStepFieldValue, stepFieldMetas } from '../lib/stepFieldWrites.js'
import { createStepApprovalRequest } from '../lib/stepApprovalRequest.js'

async function inSession<T>(fn: (session: ReturnType<typeof getSession>) => Promise<T>): Promise<T> {
  const session = getSession(undefined, 'WRITE')
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

registerStepActionHandlers({
  createEntity: (actor, type, data, parent) => inSession(async (session) => {
    const { createEntityFromStepAction } = await import('../lib/stepActionCreateEntity.js')
    return createEntityFromStepAction(session, { tenantId: actor.tenantId, userId: actor.userId }, type, data, parent)
  }),

  assignTo: (actor, entity, targetType, targetId) => inSession(async (session) => {
    // Secondo giro UI del 15 set 2026: per il team era un MERGE senza togliere
    // quello di prima (il ticket restava con due team). Sostituisce, e per il
    // team scrive anche la storia delle assegnazioni (lib/ticketTeamHistory.ts).
    const now = new Date().toISOString()
    if (targetType !== 'team') {
      const { assertAssignablePerson } = await import('../services/ticketAssignment.js')
      await assertAssignablePerson(session, targetId, actor.tenantId)
    }
    await session.executeWrite((tx) =>
      targetType === 'team'
        ? tx.run(
          `${matchById('e', { labels: 'entities', id: '$entityId' })}
           MATCH (t:Team {id: $targetId, tenant_id: $tenantId})
           ${assignTeamCypher('e', 't')}
           SET e.updated_at = $now`,
          { entityId: entity.id, tenantId: actor.tenantId, targetId, now, [TEAM_NOW_PARAM]: now },
        )
        : tx.run(
          `${matchById('e', { labels: 'entities', id: '$entityId' })}
           MATCH (u:User {id: $targetId, tenant_id: $tenantId})
           OPTIONAL MATCH (e)-[old:ASSIGNED_TO]->(:User)
           DELETE old
           WITH DISTINCT e, u
           MERGE (e)-[:ASSIGNED_TO]->(u)
           SET e.updated_at = $now`,
          { entityId: entity.id, tenantId: actor.tenantId, targetId, now },
        ),
    )
  }),

  updateField: (actor, entity, field, value) => inSession(async (session) => {
    // Stessa scrittura delle automazioni (lib/ticketFieldWrite.ts, AU-3): la
    // priorità nella proprietà giusta, l'invariante della matrice. Prima il
    // campo e il valore contro il metamodello di ADESSO (ondata 3).
    const metas = await stepFieldMetas(session, actor.tenantId, entity.type)
    const checked = assertStepFieldValue(metas, entity.type, field, value, `update_field of step "${actor.stepName}"`, { allowTemplate: false })
    const { writeTicketField } = await import('../lib/ticketFieldWrite.js')
    await writeTicketField(session, actor.tenantId, entity.type, entity.id, field, checked)
  }),

  createApprovalRequest: (actor, entity, params) => inSession((session) => createStepApprovalRequest(session, actor, entity, params)),

  publishEvent: async (actor, type, payload) => {
    await publish({
      id:             uuidv4(),
      type,
      tenant_id:      actor.tenantId,
      timestamp:      new Date().toISOString(),
      correlation_id: uuidv4(),
      actor_id:       actor.userId,
      payload,
    })
  },
})
