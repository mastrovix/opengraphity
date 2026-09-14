/**
 * Lo SLA di un ticket come lo legge l'interfaccia (`SLAStatusInfo`), in un
 * posto solo per incident, problem e service request.
 *
 * Erano due copie identiche (incident, problem) e la service request non
 * l'aveva: la sua pagina non mostrava lo SLA nemmeno quando una policy lo
 * aveva creato (giro del 14 set 2026).
 */
import { withSession } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'

type Props = Record<string, unknown>
export type TicketSlaLabel = 'Incident' | 'Problem' | 'ServiceRequest'

export function ticketSlaStatusResolver(label: TicketSlaLabel) {
  return async (parent: { id: string }, _: unknown, ctx: GraphQLContext) => withSession(async (session) => {
    const result = await session.executeRead((tx) => tx.run(`
      MATCH (e:${label} {id: $id, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
      RETURN s ORDER BY s.started_at DESC LIMIT 1
    `, { id: parent.id, tenantId: ctx.tenantId }))
    if (!result.records.length) return null
    const s = result.records[0]!.get('s').properties as Props
    return {
      startedAt:        s['started_at'],
      responseDeadline: s['response_deadline'],
      resolveDeadline:  s['resolve_deadline'],
      responseMet:      Boolean(s['response_met']),
      resolveMet:       Boolean(s['resolve_met']),
      breached:         Boolean(s['breached']),
      pausedAt:         (s['paused_at'] ?? null) as string | null,
    }
  })
}
