/**
 * Ticket aperti senza SLA.
 *
 * Da quando non ci sono più policy SLA di fabbrica, un ticket che nessuna
 * policy del tenant copre non riceve SLA: è una scelta di configurazione, e
 * l'amministratore deve vederla. Aperto = senza data di risoluzione,
 * completamento o chiusura. Non si contano i ticket per cui chi li ha creati
 * ha accettato l'avviso «nessuna policy SLA lo copre»: lo sapeva già.
 */
import type { Session } from 'neo4j-driver'

export async function ticketsWithoutSla(
  session: Session, tenantId: string, limit = 10,
): Promise<{ count: number; numbers: string[] }> {
  const r = await session.executeRead((tx) => tx.run(
    `CALL () {
       MATCH (e:Incident {tenant_id: $tenantId}) RETURN e
       UNION MATCH (e:Problem {tenant_id: $tenantId}) RETURN e
       UNION MATCH (e:ServiceRequest {tenant_id: $tenantId}) RETURN e
     }
     WITH e
     WHERE coalesce(e.resolved_at, e.completed_at, e.closed_at) IS NULL
       AND e.sla_absence_acknowledged_at IS NULL
       AND NOT (e)-[:HAS_SLA]->(:SLAStatus)
     WITH e ORDER BY e.created_at DESC
     WITH collect(coalesce(e.number, e.id)) AS numeri
     RETURN size(numeri) AS count, numeri[0..$limit] AS numbers`,
    { tenantId, limit },
  ))
  const rec = r.records[0]
  if (!rec) return { count: 0, numbers: [] }
  const count = rec.get('count') as number | { toNumber(): number }
  return {
    count: typeof count === 'number' ? count : count.toNumber(),
    numbers: (rec.get('numbers') as string[] | null) ?? [],
  }
}
