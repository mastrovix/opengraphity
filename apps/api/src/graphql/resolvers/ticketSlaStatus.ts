/**
 * Lo SLA di un ticket come lo legge l'interfaccia (`SLAStatusInfo`), in un
 * posto solo per incident, problem e service request.
 *
 * Erano due copie identiche (incident, problem) e la service request non
 * l'aveva: la sua pagina non mostrava lo SLA nemmeno quando una policy lo
 * aveva creato (giro del 14 set 2026).
 */
import { toNumber } from '@opengraphity/neo4j'
import { withSession } from './ci-utils.js'
import type { GraphQLContext } from '../../context.js'

type Props = Record<string, unknown>
export type TicketSlaLabel = 'Incident' | 'Problem' | 'ServiceRequest'

export function ticketSlaStatusResolver(label: TicketSlaLabel) {
  return async (parent: { id: string }, _: unknown, ctx: GraphQLContext) => withSession(async (session) => {
    const result = await session.executeRead((tx) => tx.run(`
      MATCH (e:${label} {id: $id, tenant_id: $tenantId})-[:HAS_SLA]->(s:SLAStatus)
      // Il preavviso della POLICY è la sorgente (revisione totale · B-33): uno
      // SLAStatus scritto prima del campo non deve far fallire l'intera
      // pagina di dettaglio, e la policy sa ancora quanto preavviso dare.
      OPTIONAL MATCH (p:SLAPolicyNode {id: s.policy_id, tenant_id: $tenantId})
      RETURN s, p.warning_minutes AS policyWarning
      ORDER BY s.started_at DESC LIMIT 1
    `, { id: parent.id, tenantId: ctx.tenantId }))
    if (!result.records.length) return null
    const s = result.records[0]!.get('s').properties as Props
    // Il preavviso è della policy (lo scheduler lo legge da qui per l'avviso):
    // il badge deve usare lo stesso, non una soglia sua (verifica «Cosa resta cablato», ondata 1).
    const onStatus = toNumber(s['tier_warning_minutes'])
    const onPolicy = toNumber(result.records[0]!.get('policyWarning'))
    const valid = (n: number) => Number.isInteger(n) && n > 0
    /**
     * B-33: se lo stato non porta il preavviso si legge quello della policy —
     * non è un ripiego muto, è la sorgente del valore, e lo scheduler scrive
     * lo stesso numero. Se nessuno dei due c'è, allora sì: è un difetto di
     * configurazione e si dice, perché un badge senza soglia mentirebbe.
     */
    const warningMinutes = valid(onStatus) ? onStatus : onPolicy
    if (!valid(warningMinutes)) {
      throw new Error(`SLAStatus ${String(s['id'])} of ${label} ${parent.id} has no valid warning lead (tier_warning_minutes=${String(s['tier_warning_minutes'])}, policy ${String(s['policy_id'])}=${String(result.records[0]!.get('policyWarning'))})`)
    }
    return {
      startedAt:        s['started_at'],
      responseDeadline: s['response_deadline'],
      resolveDeadline:  s['resolve_deadline'],
      responseMet:      Boolean(s['response_met']),
      resolveMet:       Boolean(s['resolve_met']),
      breached:         Boolean(s['breached']),
      pausedAt:         (s['paused_at'] ?? null) as string | null,
      warningMinutes,
    }
  })
}
