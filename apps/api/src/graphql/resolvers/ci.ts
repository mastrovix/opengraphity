/**
 * CI ⇄ ticket relations wired in resolvers/index.ts (`ciIncidents`,
 * `ciChanges`). The former `allCIs/ciById/blastRadius` here were dead copies
 * (B-09): the live ones come from buildDynamicCIResolvers (dynamic-ci.ts).
 */
import { withSession, runQuery } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import type { Props } from './ci-utils.js'
import { toNumber } from '@opengraphity/neo4j'
import { TICKET_CI_RELATIONSHIP } from '@opengraphity/types'
import { mapRequest } from '../../services/requestService.js'

async function ciIncidents(_: unknown, args: { ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session,
      `MATCH (i:Incident {tenant_id: $tenantId})-[:${TICKET_CI_RELATIONSHIP.incident}]->(n {id: $ciId})
       RETURN properties(i) AS props
       ORDER BY i.created_at DESC`,
      { ciId: args.ciId, tenantId: ctx.tenantId },
    )
    return rows.map((r) => ({
      id:          r.props['id']          as string,
      number:      (r.props['number'] ?? '') as string,
      tenantId:    r.props['tenant_id']   as string,
      title:       r.props['title']       as string,
      description: r.props['description'] as string | undefined,
      severity:    r.props['severity']    as string,
      status:      r.props['status']      as string,
      createdAt:   r.props['created_at']  as string,
      updatedAt:   r.props['updated_at']  as string,
      resolvedAt:  r.props['resolved_at'] as string | undefined,
      rootCause:   (r.props['root_cause'] ?? null) as string | null,
      assignee:    null,
      assignedTeam: null,
      affectedCIs: [],
      workflowInstance: null,
      availableTransitions: [],
      workflowHistory: [],
      comments: [],
    }))
  })
}

async function ciChanges(_: unknown, args: { ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session,
      `MATCH (c:Change {tenant_id: $tenantId})-[:${TICKET_CI_RELATIONSHIP.change}]->(n {id: $ciId})
       WHERE coalesce(c.deleted, false) = false
       RETURN properties(c) AS props
       ORDER BY c.created_at DESC`,
      { ciId: args.ciId, tenantId: ctx.tenantId },
    )
    return rows.map((r) => ({
      id:                 r.props['id']                     as string,
      tenantId:           r.props['tenant_id']              as string,
      code:               r.props['code']                   as string,
      title:              r.props['title']                  as string,
      description:        (r.props['description']            ?? null) as string | null,
      phase:              r.props['phase']                  as string,
      aggregateRiskScore: r.props['aggregate_risk_score'] != null
        ? toNumber(r.props['aggregate_risk_score']) : null,
      approvalRoute:      (r.props['approval_route']         ?? null) as string | null,
      approvalStatus:     (r.props['approval_status']        ?? null) as string | null,
      approvalAt:         (r.props['approval_at']            ?? null) as string | null,
      createdAt:          r.props['created_at']             as string,
      updatedAt:          r.props['updated_at']             as string,
      requester: null, changeOwner: null, approvalBy: null,
    }))
  })
}

/**
 * I problem che hanno questo CI fra gli impattati — revisione del 14 set 2026 ·
 * F12: il dettaglio del CI mostrava incident e change, non i problem.
 */
async function ciProblems(_: unknown, args: { ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session,
      `MATCH (p:Problem {tenant_id: $tenantId})-[:${TICKET_CI_RELATIONSHIP.problem}]->(n {id: $ciId, tenant_id: $tenantId})
       RETURN properties(p) AS props
       ORDER BY p.created_at DESC`,
      { ciId: args.ciId, tenantId: ctx.tenantId },
    )
    return rows.map((r) => ({
      id:        r.props['id']         as string,
      number:    (r.props['number'] ?? '') as string,
      title:     r.props['title']      as string,
      priority:  (r.props['priority'] ?? null) as string | null,
      status:    r.props['status']     as string,
      createdAt: r.props['created_at'] as string,
      updatedAt: r.props['updated_at'] as string,
    }))
  })
}

/** Le richieste che riguardano questo CI (revisione del 15 set 2026 · CM-8). */
async function ciServiceRequests(_: unknown, args: { ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session,
      `MATCH (r:ServiceRequest {tenant_id: $tenantId})-[:${TICKET_CI_RELATIONSHIP.service_request}]->(n {id: $ciId, tenant_id: $tenantId})
       RETURN properties(r) AS props
       ORDER BY r.created_at DESC`,
      { ciId: args.ciId, tenantId: ctx.tenantId },
    )
    return rows.map((r) => mapRequest(r.props))
  })
}

export const ciResolvers = {
  Query: { ciIncidents, ciChanges, ciProblems, ciServiceRequests },
}
