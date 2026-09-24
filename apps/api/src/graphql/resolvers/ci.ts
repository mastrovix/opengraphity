/**
 * CI ⇄ ticket relations wired in resolvers/index.ts (`ciIncidents`,
 * `ciChanges`). The former `allCIs/ciById/blastRadius` here were dead copies
 * (B-09): the live ones come from buildDynamicCIResolvers (dynamic-ci.ts).
 *
 * Every query starts FROM the CI, labelled (review of 23 Sep 2026): `(n {id})`
 * without a label cannot use the ConfigurationItem(id) index, and the planner
 * started from every incident, change or problem of the tenant — 50,000 on
 * the demo tenant — at each opening of a CI page.
 */
import { withSession, runQuery } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'
import type { Props } from './ci-utils.js'
import { TICKET_CI_RELATIONSHIP } from '@opengraphity/types'
import { mapRequest } from '../../services/requestService.js'
import { mapIncident } from '../../lib/mappers.js'
import { mapChange } from './change/mappers.js'

async function ciIncidents(_: unknown, args: { ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session,
      `MATCH (n:ConfigurationItem {id: $ciId, tenant_id: $tenantId})<-[:${TICKET_CI_RELATIONSHIP.incident}]-(i:Incident {tenant_id: $tenantId})
       RETURN properties(i) AS props
       ORDER BY i.created_at DESC`,
      { ciId: args.ciId, tenantId: ctx.tenantId },
    )
    // Lo STESSO mapper degli elenchi (revisione totale · B-15): qui l'oggetto
    // era costruito a mano e mancavano campi non nullabili dello schema
    // (`priority`, `major`, `category`) più i campi personalizzati del
    // cliente, che `withTicketProps` aggiunge. Un client che chiedeva
    // `ciIncidents { priority }` riceveva «Cannot return null».
    return rows.map((r) => mapIncident(r.props))
  })
}

async function ciChanges(_: unknown, args: { ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session,
      `MATCH (n:ConfigurationItem {id: $ciId, tenant_id: $tenantId})<-[:${TICKET_CI_RELATIONSHIP.change}]-(c:Change {tenant_id: $tenantId})
       WHERE coalesce(c.deleted, false) = false
       RETURN properties(c) AS props
       ORDER BY c.created_at DESC`,
      { ciId: args.ciId, tenantId: ctx.tenantId },
    )
    // B-15: lo stesso mapper dell'elenco delle change (`number`, `changeType`,
    // `risk`, i campi del cliente): a mano ne mancavano cinque.
    return rows.map((r) => mapChange(r.props))
  })
}

/**
 * I problem che hanno questo CI fra gli impattati — revisione del 14 set 2026 ·
 * F12: il dettaglio del CI mostrava incident e change, non i problem.
 */
async function ciProblems(_: unknown, args: { ciId: string }, ctx: GraphQLContext) {
  return withSession(async (session) => {
    const rows = await runQuery<{ props: Props }>(session,
      `MATCH (n:ConfigurationItem {id: $ciId, tenant_id: $tenantId})<-[:${TICKET_CI_RELATIONSHIP.problem}]-(p:Problem {tenant_id: $tenantId})
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
      `MATCH (n:ConfigurationItem {id: $ciId, tenant_id: $tenantId})<-[:${TICKET_CI_RELATIONSHIP.service_request}]-(r:ServiceRequest {tenant_id: $tenantId})
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
