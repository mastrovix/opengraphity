/**
 * THE TEAM OF A SERVICE REQUEST (browser tour of 23 Sep 2026, D56 — the
 * owner's choice).
 *
 * A request had an assignee and no team: the OLA and UC contracts on service
 * requests — which the product lets an administrator define — measured
 * nothing, and the diagnostics said so for three contracts of the demo
 * tenant. Now a request has its team like an incident: the FULFILMENT GROUP
 * of its catalog item takes it when it is created, a person may move it to
 * another team, and the assignee is a member of the team (the same ITSM rule
 * as incidents and problems, `assertUserInAssignedTeam`). The team history
 * (`TicketTeamSegment`) is what the OLA engine measures.
 */
import { TICKET_TEAM_ASSIGNED_EVENT, type TicketTeamAssignedPayload } from '@opengraphity/types'
import { runQueryOne } from '@opengraphity/neo4j'
import { withSession } from '../graphql/resolvers/ci-utils.js'
import { NotFoundError, ValidationError } from '../lib/errors.js'
import { publishEvent } from '../lib/publishEvent.js'
import { systemText } from '../lib/systemText.js'
import { writeTicketComment } from '../lib/ticketComments.js'
import { setTicketTeam } from './ticketAssignment.js'
import { mapRequest } from './requestService.js'
import type { ServiceCtx } from './incidentService.js'

export interface RequestTeamAssignment {
  request: ReturnType<typeof mapRequest>
  teamName: string
  previousTeamName: string | null
  unassignedUserName: string | null
}

/**
 * Assigns the request to a team. `fromCatalogItem` is set by the creation:
 * the team is the fulfilment group of that item, and the note says so.
 */
export async function assignRequestToTeam(
  id: string, teamId: string, ctx: ServiceCtx, opts: { fromCatalogItem?: string } = {},
): Promise<RequestTeamAssignment> {
  if (!teamId?.trim()) throw new ValidationError('teamId is required', { key: 'errors.assignment.teamRequired' })
  const now = new Date().toISOString()
  const result = await withSession(async (session) => {
    const current = await runQueryOne<{ completedAt: string | null }>(session,
      'MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId}) RETURN r.completed_at AS completedAt', { id, tenantId: ctx.tenantId })
    if (!current) throw new NotFoundError('ServiceRequest', id)
    if (current.completedAt) throw new ValidationError('A concluded request cannot be reassigned', { key: 'errors.request.assignConcluded' })

    const { teamName, previousTeamName, unassignedUserName } = await setTicketTeam(session, 'ServiceRequest', id, teamId, ctx.tenantId)
    const note = opts.fromCatalogItem
      ? await systemText(ctx.tenantId, 'request.fulfilmentTeam', { team: teamName, item: opts.fromCatalogItem })
      : await systemText(ctx.tenantId, previousTeamName ? 'request.reassignedTeam' : 'request.assignedTeam', { team: teamName })
    const comment = (text: string) => writeTicketComment(session, {
      entityType: 'service_request', entityId: id, tenantId: ctx.tenantId, text,
      authorId: ctx.userId, authorLabel: ctx.actorLabel ?? null, isInternal: true, createdAt: now,
    })
    // M-10: the assignee who is not in the new team is detached, and the ticket says who and why.
    if (unassignedUserName) await comment(await systemText(ctx.tenantId, 'incident.unassignedOnTeamChange', { user: unassignedUserName, team: teamName }))
    await comment(note)

    const row = await runQueryOne<{ props: Record<string, unknown> }>(session,
      'MATCH (r:ServiceRequest {id: $id, tenant_id: $tenantId}) RETURN properties(r) AS props', { id, tenantId: ctx.tenantId })
    if (!row) throw new NotFoundError('ServiceRequest', id)
    return { request: mapRequest(row.props), teamName, previousTeamName, unassignedUserName }
  }, true)
  // SL-10: the SLA policy may depend on the team; the OLA engine reads the segment setTicketTeam opened.
  await publishEvent(TICKET_TEAM_ASSIGNED_EVENT, ctx.tenantId, ctx.userId,
    { entity_type: 'service_request', entity_id: id, team_id: teamId } satisfies TicketTeamAssignedPayload, now)
  return result
}

/** The fulfilment group of a catalog item, if it has one. */
export async function fulfilmentTeamOf(tenantId: string, catalogItemId: string): Promise<{ teamId: string; itemName: string } | null> {
  return withSession((session) => runQueryOne<{ teamId: string; itemName: string }>(session, `
    MATCH (i:ServiceCatalogItem {id: $catalogItemId, tenant_id: $tenantId})-[:FULFILLED_BY]->(t:Team {tenant_id: $tenantId})
    RETURN t.id AS teamId, i.name AS itemName
  `, { catalogItemId, tenantId }))
}
